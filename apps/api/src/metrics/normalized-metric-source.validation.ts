import { isDeepStrictEqual } from "node:util";
import {
  ConnectorBindingSchema,
  ConnectorOrderSchema,
  ConnectorRefundSchema,
  ConnectorInventorySchema,
  ConnectorCampaignMetricSchema,
  ExternalIdSchema,
  MetricEvidenceIdsSchema,
  MetricSubjectSchema,
  MetricTimestampSchema,
  MetricValueSchema,
  MetricWindowSchema,
  SourceVersionSchema,
  type MetricErrorCode,
  type MetricResult,
  type MetricSourceQuery,
} from "@shopmate/contracts";
import type {
  MetricSourcePrefix,
  NormalizedMetricFact,
  NormalizedMetricSourceBundle,
} from "@shopmate/database";
import { z } from "zod";

function precise(value: string): boolean {
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/u.exec(value)?.[1] ?? "";
  return !/[1-9]/u.test(fraction.slice(3));
}
const time = MetricTimestampSchema.refine(precise);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const revision = z.string().regex(/^p2-normalized-v1:[a-f0-9]{64}$/u);
const windowSchema = MetricWindowSchema.refine(
  (value) => precise(value.periodStart) && precise(value.periodEnd),
);
const kind = z.union(MetricValueSchema.options.map((option) => option.unwrap().shape.kind));
const request = z.strictObject({ kind, subject: MetricSubjectSchema });
export const normalizedSourceQuerySchema = z
  .strictObject({
    binding: ConnectorBindingSchema,
    window: windowSchema,
    visibleAt: time,
    definitionVersion: SourceVersionSchema,
    inputRevision: revision,
    coverageRequests: z
      .array(request)
      .min(1)
      .max(100)
      .refine((items) => new Set(items.map((item) => JSON.stringify(item))).size === items.length),
  })
  .refine((value) => Date.parse(value.window.periodEnd) <= Date.parse(value.visibleAt));
const receipt = z.strictObject({
  pageId: ExternalIdSchema,
  pageHash: hash,
  expectedCursor: z.string().min(1).max(16384).nullable(),
  nextCursor: z.string().min(1).max(16384).nullable(),
  observedAt: time,
  sourceWatermark: time,
  ingestedAt: time,
});
const prefix = z.strictObject({
  jobId: ExternalIdSchema,
  stream: z.enum(["ORDERS", "REFUNDS", "INVENTORY", "MARKETING"]),
  since: time,
  until: time,
  successfulThrough: time,
  proof: z.strictObject({
    pageCount: integer.min(1),
    terminalCount: z.literal(1),
    knownCount: integer.min(1),
    sourceWatermark: time,
    observedAt: time,
  }),
  receipts: z.array(receipt).min(1).max(10000),
});
function fact<T extends z.ZodType>(data: T) {
  return z.strictObject({ data, sourcePayloadHash: hash, observedAt: time, ingestedAt: time });
}
export const normalizedSourceBundleSchema = z.strictObject({
  mappingVersion: z.literal("p2-normalized-v1"),
  binding: ConnectorBindingSchema,
  scopeId: z.uuid(),
  provider: z.literal("MOCK"),
  generation: integer,
  window: windowSchema,
  visibleAt: time,
  businessNow: time,
  clockRevision: integer,
  sourceOpening: time,
  sourceWatermark: time,
  inputRevision: revision,
  capturedAt: time,
  evidenceIds: MetricEvidenceIdsSchema,
  prefixes: z.array(prefix).min(4).max(10000),
  orders: z.array(fact(ConnectorOrderSchema)).max(10000),
  refunds: z.array(fact(ConnectorRefundSchema)).max(10000),
  inventory: z.array(fact(ConnectorInventorySchema)).max(10000),
  campaigns: z.array(fact(ConnectorCampaignMetricSchema)).max(10000),
});
const errorSchema = z.strictObject({
  code: z.enum([
    "INVALID_INPUT",
    "OVERFLOW",
    "SCOPE_MISMATCH",
    "VERSION_MISMATCH",
    "WINDOW_MISMATCH",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "SOURCE_UNAVAILABLE",
  ]),
  evidenceIds: z.array(ExternalIdSchema),
});
export const normalizedSourceResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: z.unknown() }),
  z.strictObject({ ok: z.literal(false), error: errorSchema }),
]);
export function freezeNormalized<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freezeNormalized);
    Object.freeze(value);
  }
  return value;
}
export function normalizedFailure<T>(code: MetricErrorCode): MetricResult<T> {
  return freezeNormalized({ ok: false, error: { code, evidenceIds: [] } });
}
function instant(left: string, right: string): boolean {
  return Date.parse(left) === Date.parse(right);
}
export function normalizedContextMismatch(
  bundle: NormalizedMetricSourceBundle,
  query: MetricSourceQuery,
): MetricErrorCode | null {
  if (!isDeepStrictEqual(bundle.binding, query.binding)) return "SCOPE_MISMATCH";
  if (bundle.inputRevision !== query.inputRevision) return "VERSION_MISMATCH";
  if (
    bundle.window.timezone !== query.window.timezone ||
    bundle.window.currency !== query.window.currency ||
    !instant(bundle.window.periodStart, query.window.periodStart) ||
    !instant(bundle.window.periodEnd, query.window.periodEnd) ||
    !instant(bundle.visibleAt, query.visibleAt)
  )
    return "WINDOW_MISMATCH";
  return null;
}
function validReceiptGraph(value: MetricSourcePrefix): boolean {
  const { receipts, proof } = value;
  if (
    proof.pageCount !== receipts.length ||
    proof.knownCount !== receipts.length ||
    new Set(receipts.map((item) => item.pageId)).size !== receipts.length
  )
    return false;
  let cursor: string | null = null;
  const visited = new Set<string>();
  for (let index = 0; index < receipts.length; index++) {
    const matches = receipts.filter((item) => item.expectedCursor === cursor);
    const page = matches[0];
    if (matches.length !== 1 || !page || visited.has(page.pageId)) return false;
    visited.add(page.pageId);
    cursor = page.nextCursor;
    if (cursor === null && index !== receipts.length - 1) return false;
  }
  return (
    cursor === null &&
    Math.min(...receipts.map((item) => Date.parse(item.sourceWatermark))) ===
      Date.parse(proof.sourceWatermark) &&
    Math.max(...receipts.map((item) => Date.parse(item.observedAt))) ===
      Date.parse(proof.observedAt) &&
    receipts.every((item) => Date.parse(item.sourceWatermark) <= Date.parse(item.observedAt))
  );
}
function validPrefix(value: MetricSourcePrefix, visibleAt: string): boolean {
  return (
    Date.parse(value.since) < Date.parse(value.until) &&
    Date.parse(value.successfulThrough) >= Date.parse(value.since) &&
    instant(value.successfulThrough, value.proof.sourceWatermark) &&
    Date.parse(value.until) <= Date.parse(visibleAt) &&
    Date.parse(value.proof.observedAt) <= Date.parse(visibleAt) &&
    validReceiptGraph(value)
  );
}
export function normalizedStreamPrefixes(
  bundle: NormalizedMetricSourceBundle,
  stream: MetricSourcePrefix["stream"],
): readonly MetricSourcePrefix[] {
  return bundle.prefixes
    .filter((item) => item.stream === stream)
    .sort((left, right) => Date.parse(left.since) - Date.parse(right.since));
}
function completeStream(
  bundle: NormalizedMetricSourceBundle,
  stream: MetricSourcePrefix["stream"],
): boolean {
  const entries = normalizedStreamPrefixes(bundle, stream);
  if (
    !entries.length ||
    Date.parse(entries[0]!.since) > Date.parse(bundle.sourceOpening) ||
    Date.parse(entries.at(-1)!.successfulThrough) < Date.parse(bundle.window.periodEnd)
  )
    return false;
  return entries.every(
    (entry, index) =>
      validPrefix(entry, bundle.visibleAt) &&
      (index === 0 ||
        (instant(entries[index - 1]!.until, entry.since) &&
          Date.parse(entries[index - 1]!.successfulThrough) >= Date.parse(entry.since))),
  );
}
type SourceRecord = Readonly<{
  externalStoreId: string;
  source: Readonly<{ updatedAt: string | null }>;
}>;
function preciseFact(value: SourceRecord): boolean {
  const events = ["orderedAt", "paidAt", "requestedAt", "succeededAt"];
  return (
    (value.source.updatedAt === null || precise(value.source.updatedAt)) &&
    events.every((key) => {
      const timestamp: unknown = Reflect.get(value, key);
      return timestamp == null || (typeof timestamp === "string" && precise(timestamp));
    })
  );
}
function validStreamFacts(
  bundle: NormalizedMetricSourceBundle,
  stream: MetricSourcePrefix["stream"],
  facts: readonly NormalizedMetricFact<SourceRecord>[],
): boolean {
  const observedAt = Math.max(
    ...normalizedStreamPrefixes(bundle, stream).map((entry) => Date.parse(entry.proof.observedAt)),
  );
  // The archive deliberately records the actual conservative stream maximum, not a caller cutoff.
  return facts.every(
    (entry) =>
      entry.data.externalStoreId === bundle.binding.externalStoreId &&
      preciseFact(entry.data) &&
      entry.data.source.updatedAt !== null &&
      Date.parse(entry.data.source.updatedAt) <= Date.parse(entry.observedAt) &&
      Date.parse(entry.observedAt) === observedAt,
  );
}
function validFacts(bundle: NormalizedMetricSourceBundle): boolean {
  return (
    validStreamFacts(bundle, "ORDERS", bundle.orders) &&
    validStreamFacts(bundle, "REFUNDS", bundle.refunds) &&
    validStreamFacts(bundle, "INVENTORY", bundle.inventory) &&
    validStreamFacts(bundle, "MARKETING", bundle.campaigns)
  );
}
function uniqueFacts<T>(
  facts: readonly NormalizedMetricFact<T>[],
  key: (data: T) => string,
): boolean {
  return new Set(facts.map((entry) => key(entry.data))).size === facts.length;
}
function uniqueCollections(bundle: NormalizedMetricSourceBundle): boolean {
  return (
    uniqueFacts(bundle.orders, (data) => data.externalOrderId) &&
    uniqueFacts(bundle.refunds, (data) => data.externalRefundId) &&
    uniqueFacts(bundle.inventory, (data) =>
      JSON.stringify([data.externalSkuId, data.externalLocationId]),
    ) &&
    uniqueFacts(bundle.campaigns, (data) => JSON.stringify([data.externalCampaignId, data.date]))
  );
}
function provedWatermark(bundle: NormalizedMetricSourceBundle): number {
  const streams = ["ORDERS", "REFUNDS", "INVENTORY", "MARKETING"] as const;
  return Math.min(
    ...streams.map((stream) =>
      Math.max(
        ...normalizedStreamPrefixes(bundle, stream).map((entry) =>
          Date.parse(entry.proof.sourceWatermark),
        ),
      ),
    ),
  );
}
export function normalizedBundleProofValid(bundle: NormalizedMetricSourceBundle): boolean {
  return (
    Date.parse(bundle.visibleAt) <= Date.parse(bundle.businessNow) &&
    Date.parse(bundle.window.periodEnd) <= Date.parse(bundle.visibleAt) &&
    Date.parse(bundle.sourceWatermark) <= Date.parse(bundle.visibleAt) &&
    Date.parse(bundle.sourceWatermark) >= Date.parse(bundle.window.periodEnd) &&
    Date.parse(bundle.sourceWatermark) === provedWatermark(bundle) &&
    Date.parse(bundle.sourceOpening) <= Date.parse(bundle.window.periodStart) &&
    new Set(bundle.prefixes.map((item) => item.jobId)).size === bundle.prefixes.length &&
    (["ORDERS", "REFUNDS", "INVENTORY", "MARKETING"] as const).every((stream) =>
      completeStream(bundle, stream),
    ) &&
    validFacts(bundle) &&
    uniqueCollections(bundle)
  );
}

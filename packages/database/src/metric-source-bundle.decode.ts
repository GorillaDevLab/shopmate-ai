import { createHash } from "node:crypto";
import {
  ConnectorBindingSchema,
  ConnectorOrderSchema,
  ConnectorRefundSchema,
  ConnectorInventorySchema,
  ConnectorCampaignMetricSchema,
  MetricTimestampSchema,
  MetricWindowSchema,
} from "@shopmate/contracts";
import type {
  MetricSourcePrefix,
  MetricSourceReceipt,
  MetricSourceStream,
  NormalizedMetricFact,
  NormalizedMetricSourceBundle,
} from "./metric-source-bundle.types.js";

type Row = Record<string, unknown>;
export function sourceObject(value: unknown, keys: readonly string[]): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Invalid metric source object");
  const row = value as Row;
  if (Object.keys(row).length !== keys.length || !keys.every((key) => Object.hasOwn(row, key)))
    throw new TypeError("Invalid metric source fields");
  return row;
}
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value))
    throw new TypeError("Invalid metric source text");
  return value;
}
function time(value: unknown): string {
  const parsed = MetricTimestampSchema.parse(value);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(parsed))
    throw new TypeError("Invalid metric source timestamp precision");
  return parsed;
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
    throw new TypeError("Invalid metric source integer");
  return value;
}
function list<T>(value: unknown, decode: (item: unknown) => T): readonly T[] {
  if (!Array.isArray(value) || value.length > 10000)
    throw new TypeError("Invalid metric source collection");
  return value.map(decode);
}
function cursor(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 16384)
    throw new TypeError("Invalid metric source cursor");
  return value;
}
const hash = /^[a-f0-9]{64}$/u;
const id = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;
const revision = /^p2-normalized-v1:[a-f0-9]{64}$/u;
const prefixKeys = ["jobId", "stream", "since", "until", "successfulThrough", "proof", "receipts"];
const proofKeys = ["pageCount", "terminalCount", "knownCount", "sourceWatermark", "observedAt"];
const bundleKeys = [
  "mappingVersion",
  "binding",
  "scopeId",
  "provider",
  "generation",
  "window",
  "visibleAt",
  "businessNow",
  "clockRevision",
  "sourceOpening",
  "sourceWatermark",
  "prefixes",
  "orders",
  "refunds",
  "inventory",
  "campaigns",
];
function receipt(value: unknown): MetricSourceReceipt {
  const row = sourceObject(value, [
    "pageId",
    "pageHash",
    "expectedCursor",
    "nextCursor",
    "observedAt",
    "sourceWatermark",
    "ingestedAt",
  ]);
  return {
    pageId: text(row.pageId, id),
    pageHash: text(row.pageHash, hash),
    expectedCursor: cursor(row.expectedCursor),
    nextCursor: cursor(row.nextCursor),
    observedAt: time(row.observedAt),
    sourceWatermark: time(row.sourceWatermark),
    ingestedAt: time(row.ingestedAt),
  };
}
function stream(value: unknown): MetricSourceStream {
  if (value !== "ORDERS" && value !== "REFUNDS" && value !== "INVENTORY" && value !== "MARKETING")
    throw new TypeError("Invalid metric source stream");
  return value;
}
function prefix(value: unknown): MetricSourcePrefix {
  const row = sourceObject(value, prefixKeys);
  const proof = sourceObject(row.proof, proofKeys);
  const receipts = list(row.receipts, receipt);
  const pageCount = integer(proof.pageCount, 1);
  if (proof.terminalCount !== 1 || proof.knownCount !== pageCount || receipts.length !== pageCount)
    throw new TypeError("Invalid metric source prefix counts");
  const result: MetricSourcePrefix = {
    jobId: text(row.jobId, id),
    stream: stream(row.stream),
    since: time(row.since),
    until: time(row.until),
    successfulThrough: time(row.successfulThrough),
    proof: {
      pageCount,
      terminalCount: 1,
      knownCount: pageCount,
      sourceWatermark: time(proof.sourceWatermark),
      observedAt: time(proof.observedAt),
    },
    receipts,
  };
  if (result.since >= result.until || result.successfulThrough !== result.proof.sourceWatermark)
    throw new TypeError("Invalid metric source prefix window");
  validateReceipts(result);
  return result;
}
function validateReceipts(value: MetricSourcePrefix): void {
  const visited = new Set<string>();
  let next: string | null = null;
  for (let count = 0; count < value.receipts.length; count++) {
    const matches = value.receipts.filter((entry) => entry.expectedCursor === next);
    if (matches.length !== 1 || visited.has(matches[0]!.pageId))
      throw new TypeError("Invalid metric source receipt chain");
    const entry = matches[0]!;
    visited.add(entry.pageId);
    next = entry.nextCursor;
    if (next === null && count !== value.receipts.length - 1)
      throw new TypeError("Incomplete metric source receipt chain");
  }
  const minimum = value.receipts.reduce(
    (at, entry) => (entry.sourceWatermark < at ? entry.sourceWatermark : at),
    value.receipts[0]!.sourceWatermark,
  );
  const maximum = value.receipts.reduce(
    (at, entry) => (entry.observedAt > at ? entry.observedAt : at),
    value.receipts[0]!.observedAt,
  );
  if (
    next !== null ||
    minimum !== value.proof.sourceWatermark ||
    maximum !== value.proof.observedAt
  )
    throw new TypeError("Invalid metric source receipt aggregate");
}
function fact<T>(value: unknown, parse: (data: unknown) => T): NormalizedMetricFact<T> {
  const row = sourceObject(value, ["data", "sourcePayloadHash", "observedAt", "ingestedAt"]);
  return {
    data: parse(row.data),
    sourcePayloadHash: text(row.sourcePayloadHash, hash),
    observedAt: time(row.observedAt),
    ingestedAt: time(row.ingestedAt),
  };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function validatePrefixes(bundle: NormalizedMetricSourceBundle): void {
  if (
    bundle.visibleAt > bundle.businessNow ||
    bundle.window.periodEnd > bundle.visibleAt ||
    bundle.sourceWatermark < bundle.window.periodEnd
  )
    throw new TypeError("Invalid metric source cutoff");
  if (new Set(bundle.prefixes.map((entry) => entry.jobId)).size !== bundle.prefixes.length)
    throw new TypeError("Duplicate metric source prefix");
  for (const name of ["ORDERS", "REFUNDS", "INVENTORY", "MARKETING"]) {
    const entries = bundle.prefixes
      .filter((entry) => entry.stream === name)
      .sort((a, b) => a.since.localeCompare(b.since));
    if (
      !entries.length ||
      entries[0]!.since > bundle.sourceOpening ||
      entries.at(-1)!.successfulThrough < bundle.window.periodEnd
    )
      throw new TypeError("Incomplete metric source history");
    for (let index = 0; index < entries.length; index++) {
      if (
        entries[index]!.proof.observedAt > bundle.visibleAt ||
        entries[index]!.successfulThrough < entries[index]!.since ||
        (index > 0 &&
          (entries[index - 1]!.successfulThrough < entries[index]!.since ||
            entries[index - 1]!.until !== entries[index]!.since))
      )
        throw new TypeError("Incomplete metric source prefix");
    }
  }
}
function validateFacts(bundle: NormalizedMetricSourceBundle): void {
  for (const entry of [
    ...bundle.orders,
    ...bundle.refunds,
    ...bundle.inventory,
    ...bundle.campaigns,
  ]) {
    if (
      entry.data.externalStoreId !== bundle.binding.externalStoreId ||
      entry.observedAt > bundle.visibleAt ||
      entry.data.source.updatedAt === null ||
      Date.parse(entry.data.source.updatedAt) > Date.parse(entry.observedAt)
    )
      throw new TypeError("Invalid metric source fact binding or time");
    for (const key of ["orderedAt", "paidAt", "requestedAt", "succeededAt"] as const) {
      const data: object = entry.data;
      if (key in data) {
        const event: unknown = Reflect.get(data, key);
        if (
          event !== null &&
          (typeof event !== "string" || Date.parse(event) > Date.parse(entry.observedAt))
        )
          throw new TypeError("Future metric source event");
      }
    }
  }
}
export function decodeNormalizedMetricSourceBundle(value: unknown): NormalizedMetricSourceBundle {
  const stored = sourceObject(value, ["payload", "inputRevision", "capturedAt"]);
  const row = sourceObject(stored.payload, bundleKeys);
  const bundle: NormalizedMetricSourceBundle = {
    ...metadata(row, stored),
    prefixes: list(row.prefixes, prefix),
    orders: list(row.orders, (entry) => fact(entry, (data) => ConnectorOrderSchema.parse(data))),
    refunds: list(row.refunds, (entry) => fact(entry, (data) => ConnectorRefundSchema.parse(data))),
    inventory: list(row.inventory, (entry) =>
      fact(entry, (data) => ConnectorInventorySchema.parse(data)),
    ),
    campaigns: list(row.campaigns, (entry) =>
      fact(entry, (data) => ConnectorCampaignMetricSchema.parse(data)),
    ),
  };
  validatePrefixes(bundle);
  validateFacts(bundle);
  return freeze(bundle);
}
function metadata(
  row: Row,
  stored: Row,
): Omit<
  NormalizedMetricSourceBundle,
  "prefixes" | "orders" | "refunds" | "inventory" | "campaigns"
> {
  if (row.mappingVersion !== "p2-normalized-v1" || row.provider !== "MOCK")
    throw new TypeError("Unknown metric source mapping");
  const inputRevision = text(stored.inputRevision, revision);
  return {
    mappingVersion: "p2-normalized-v1",
    binding: ConnectorBindingSchema.parse(row.binding),
    scopeId: text(
      row.scopeId,
      /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
    ),
    provider: "MOCK",
    generation: integer(row.generation),
    window: MetricWindowSchema.parse(row.window),
    visibleAt: time(row.visibleAt),
    businessNow: time(row.businessNow),
    clockRevision: integer(row.clockRevision),
    sourceOpening: time(row.sourceOpening),
    sourceWatermark: time(row.sourceWatermark),
    inputRevision,
    capturedAt: time(stored.capturedAt),
    evidenceIds: [`metric-evidence-v1:${createHash("sha256").update(inputRevision).digest("hex")}`],
  };
}

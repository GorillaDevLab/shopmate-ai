import { createHash } from "node:crypto";
import {
  ConnectorBindingSchema,
  MetricInputV1Schema,
  MetricSubjectSchema,
  MetricValueSchema,
  MetricWindowSchema,
  MetricTimestampSchema,
  SourceVersionSchema,
  type ConnectorBinding,
  type MetricErrorCode,
  type MetricInputV1,
  type MetricKind,
  type MetricResult,
  type MetricSubject,
  type MetricWindow,
} from "@shopmate/contracts";
import { z } from "zod";
import type { MetricDefinitionRegistry } from "./metric-definition-registry.js";

export interface MetricEvidenceRequest {
  readonly input: MetricInputV1;
  readonly kind: MetricKind;
  readonly subject: MetricSubject;
}
export interface MetricReplayDescriptor {
  readonly schemaVersion: 1;
  readonly hashVersion: "metric-input-sha256-v1";
  readonly definitionVersion: string;
  readonly inputRevision: string;
  readonly binding: ConnectorBinding;
  readonly window: MetricWindow;
  readonly visibleAt: string;
  readonly sourceWatermark: string | null;
  readonly kind: MetricKind;
  readonly subject: MetricSubject;
  readonly inputHash: string;
  readonly evidenceIds: readonly string[];
}
export interface MetricEvidenceHasher {
  readonly create: (request: MetricEvidenceRequest) => MetricResult<MetricReplayDescriptor>;
  readonly verify: (
    request: Readonly<{ descriptor: MetricReplayDescriptor; input: MetricInputV1 }>,
  ) => MetricResult<MetricReplayDescriptor>;
}

const hashVersion = "metric-input-sha256-v1";
const kindSchema = z.union(MetricValueSchema.options.map((option) => option.unwrap().shape.kind));
const requestSchema = z.strictObject({
  input: MetricInputV1Schema,
  kind: kindSchema,
  subject: MetricSubjectSchema,
});
const descriptorSchema = z.strictObject({
  schemaVersion: z.literal(1),
  hashVersion: z.literal(hashVersion),
  definitionVersion: SourceVersionSchema,
  inputRevision: SourceVersionSchema,
  binding: ConnectorBindingSchema,
  window: MetricWindowSchema,
  visibleAt: MetricTimestampSchema,
  sourceWatermark: MetricTimestampSchema.nullable(),
  kind: kindSchema,
  subject: MetricSubjectSchema,
  inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  evidenceIds: z
    .array(z.string().regex(/^metric-evidence-v1:[a-f0-9]{64}$/u))
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length),
});
const verifySchema = z.strictObject({ descriptor: descriptorSchema, input: MetricInputV1Schema });
const timestampKeys = new Set([
  "periodStart",
  "periodEnd",
  "visibleAt",
  "sourceWatermark",
  "observedAt",
  "updatedAt",
  "orderedAt",
  "paidAt",
  "requestedAt",
  "succeededAt",
  "frozenAt",
  "acceptedAt",
  "asOf",
  "eta",
]);

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function failure<T>(code: MetricErrorCode): MetricResult<T> {
  return freeze({ ok: false, error: { code, evidenceIds: [] } });
}
function exactTimestamps(value: unknown, key = ""): boolean {
  if (typeof value === "string" && timestampKeys.has(key)) {
    const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? "";
    return !/[1-9]/.test(fraction.slice(3)) && Number.isFinite(Date.parse(value));
  }
  if (Array.isArray(value)) return value.every((item: unknown) => exactTimestamps(item));
  return (
    typeof value !== "object" ||
    value === null ||
    Object.entries(value).every(([name, item]) => exactTimestamps(item, name))
  );
}
function timestamp(value: string): string {
  return new Date(value).toISOString();
}
/** Only strict DTOs reach this private encoder; every current DTO array is an unordered collection. */
function canonical(value: unknown, key = ""): string {
  if (value === null) return "null";
  if (typeof value === "string")
    return JSON.stringify(timestampKeys.has(key) ? timestamp(value) : value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value
      .map((item: unknown) => canonical(item))
      .sort()
      .join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, item]) => `${JSON.stringify(name)}:${canonical(item, name)}`)
    .join(",")}}`;
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}
function sourceEvidence(input: MetricInputV1): readonly string[] {
  const ids = new Set<string>();
  function collect(value: unknown): void {
    if (Array.isArray(value)) return value.forEach(collect);
    if (typeof value !== "object" || value === null) return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "evidenceIds") (item as readonly string[]).forEach((id) => ids.add(id));
      else collect(item);
    }
  }
  collect(input);
  return [...ids].sort();
}
function descriptor(request: MetricEvidenceRequest): MetricReplayDescriptor {
  const { input, kind, subject } = request;
  const inputHash = `sha256:${digest({ domain: hashVersion, input, kind, subject })}`;
  const scope = {
    binding: input.binding,
    definitionVersion: input.definitionVersion,
    inputRevision: input.inputRevision,
    inputHash,
    kind,
    subject,
  };
  const evidenceIds = sourceEvidence(input)
    .map(
      (sourceEvidenceId) =>
        `metric-evidence-v1:${digest({ domain: "metric-evidence-v1", ...scope, sourceEvidenceId })}`,
    )
    .sort();
  return freeze({
    schemaVersion: 1,
    hashVersion,
    definitionVersion: input.definitionVersion,
    inputRevision: input.inputRevision,
    binding: input.binding,
    window: {
      periodStart: timestamp(input.periodStart),
      periodEnd: timestamp(input.periodEnd),
      timezone: input.timezone,
      currency: input.currency,
    },
    visibleAt: timestamp(input.visibleAt),
    sourceWatermark: input.sourceWatermark === null ? null : timestamp(input.sourceWatermark),
    kind,
    subject,
    inputHash,
    evidenceIds,
  });
}
function create(
  registry: MetricDefinitionRegistry,
  request: MetricEvidenceRequest,
): MetricResult<MetricReplayDescriptor> {
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success || !exactTimestamps(parsed.data)) return failure("INVALID_INPUT");
  const definition = registry.resolve(parsed.data.input.definitionVersion);
  if (!definition.ok) return failure(definition.error.code);
  return freeze({ ok: true, value: descriptor(parsed.data) });
}
function verify(
  registry: MetricDefinitionRegistry,
  request: Parameters<MetricEvidenceHasher["verify"]>[0],
): MetricResult<MetricReplayDescriptor> {
  const parsed = verifySchema.safeParse(request);
  if (!parsed.success || !exactTimestamps(parsed.data)) return failure("INVALID_INPUT");
  const { descriptor: proof, input } = parsed.data;
  if (canonical(proof.binding) !== canonical(input.binding)) return failure("SCOPE_MISMATCH");
  if (proof.definitionVersion !== input.definitionVersion) return failure("VERSION_MISMATCH");
  const window = {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    timezone: input.timezone,
    currency: input.currency,
  };
  if (canonical(proof.window) !== canonical(window)) return failure("WINDOW_MISMATCH");
  const recomputed = create(registry, { input, kind: proof.kind, subject: proof.subject });
  if (!recomputed.ok) return recomputed;
  return canonical(proof) === canonical(recomputed.value) ? recomputed : failure("CONFLICT");
}

/** Digests identify integrity and scope; callers still enforce repository authorization. */
export function createMetricEvidenceHasher(
  registry: MetricDefinitionRegistry,
): MetricEvidenceHasher {
  const parsed = z
    .object({
      resolve: z.custom<MetricDefinitionRegistry["resolve"]>(
        (value) => typeof value === "function",
      ),
    })
    .safeParse(registry);
  if (!parsed.success) throw new TypeError("Invalid metric definition registry");
  const snapshot = Object.freeze({ resolve: parsed.data.resolve });
  return Object.freeze({
    create: (request: MetricEvidenceRequest) => create(snapshot, request),
    verify: (request: Parameters<MetricEvidenceHasher["verify"]>[0]) => verify(snapshot, request),
  });
}

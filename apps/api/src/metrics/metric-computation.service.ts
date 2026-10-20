import { isDeepStrictEqual } from "node:util";
import {
  ConnectorBindingSchema,
  ExternalIdSchema,
  MetricComputationV1Schema,
  MetricInputV1Schema,
  MetricSnapshotV1Schema,
  MetricSubjectSchema,
  MetricTimestampSchema,
  MetricValueSchema,
  MetricWindowSchema,
  SourceVersionSchema,
  TenantContextSchema,
  type ConnectorBinding,
  type MetricCalculationRequest,
  type MetricCalculator,
  type MetricComputationV1,
  type MetricErrorCode,
  type MetricInputV1,
  type MetricResult,
  type MetricSnapshotRepository,
  type MetricSnapshotV1,
  type MetricSourceQuery,
  type MetricSourceReader,
  type TenantContext,
} from "@shopmate/contracts";
import { z } from "zod";
import type { MetricDefinition, MetricDefinitionRegistry } from "./metric-definition-registry.js";
import { createMetricEvidenceHasher, type MetricEvidenceHasher } from "./metric-evidence-hash.js";

export interface MetricComputationServiceOptions {
  readonly actor: TenantContext;
  readonly source: MetricSourceReader;
  readonly registry: MetricDefinitionRegistry;
  /** Must be constructed for this same actor; the host owns current membership enforcement. */
  readonly repository: MetricSnapshotRepository;
  readonly authorizeBinding: (
    actor: TenantContext,
    binding: ConnectorBinding,
  ) => Promise<MetricResult<ConnectorBinding>>;
}
export interface MetricComputeRequest {
  readonly query: MetricSourceQuery;
  readonly computedAt: string;
}
export interface MetricComputationService {
  readonly compute: (
    request: MetricComputeRequest,
  ) => Promise<MetricResult<readonly MetricSnapshotV1[]>>;
}
const kindSchema = z.union(MetricValueSchema.options.map((option) => option.unwrap().shape.kind));
const coverageSchema = z.strictObject({ kind: kindSchema, subject: MetricSubjectSchema });
const querySchema = z.strictObject({
  binding: ConnectorBindingSchema,
  window: MetricWindowSchema,
  visibleAt: MetricTimestampSchema,
  definitionVersion: SourceVersionSchema,
  inputRevision: SourceVersionSchema.nullable(),
  coverageRequests: z
    .array(coverageSchema)
    .min(1)
    .max(100)
    .refine(
      (requests) => new Set(requests.map((item) => JSON.stringify(item))).size === requests.length,
    ),
});
const requestSchema = z
  .strictObject({ query: querySchema, computedAt: MetricTimestampSchema })
  .refine(({ query, computedAt }) => Date.parse(computedAt) >= Date.parse(query.visibleAt))
  .refine(({ query }) => Date.parse(query.window.periodEnd) <= Date.parse(query.visibleAt))
  .refine(({ query, computedAt }) =>
    [computedAt, query.visibleAt, query.window.periodStart, query.window.periodEnd].every(
      preciseTimestamp,
    ),
  );
const storedSnapshotSchema = MetricSnapshotV1Schema.refine((snapshot) =>
  [
    snapshot.computedAt,
    snapshot.periodStart,
    snapshot.periodEnd,
    snapshot.visibleAt,
    snapshot.sourceWatermark,
  ].every((value) => value === null || preciseTimestamp(value)),
);
const definitionSchema = z.strictObject({
  definitionVersion: SourceVersionSchema,
  calculator: z.object({
    calculate: z.custom<MetricCalculator["calculate"]>((value) => typeof value === "function"),
  }),
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
const envelopeSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: z.unknown() }),
  z.strictObject({ ok: z.literal(false), error: errorSchema }),
]);
const permissions = ["tenant:read", "products:read", "orders:read", "inventory:read"] as const;
type Captured = MetricComputationServiceOptions & Readonly<{ hasher: MetricEvidenceHasher }>;
function preciseTimestamp(value: string): boolean {
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? "";
  return !/[1-9]/.test(fraction.slice(3));
}
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
function result(value: unknown): MetricResult<unknown> {
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) return failure("INVALID_INPUT");
  return parsed.data.ok ? { ok: true, value: parsed.data.value } : failure(parsed.data.error.code);
}
function inputMismatch(input: MetricInputV1, query: MetricSourceQuery): MetricErrorCode | null {
  if (!isDeepStrictEqual(input.binding, query.binding)) return "SCOPE_MISMATCH";
  if (input.definitionVersion !== query.definitionVersion) return "VERSION_MISMATCH";
  if (query.inputRevision !== null && input.inputRevision !== query.inputRevision)
    return "VERSION_MISMATCH";
  if (
    [input.periodStart, input.periodEnd, input.visibleAt, input.sourceWatermark].some(
      (time) => time !== null && !preciseTimestamp(time),
    )
  )
    return "INVALID_INPUT";
  const window = query.window;
  if (
    input.timezone !== window.timezone ||
    input.currency !== window.currency ||
    (["periodStart", "periodEnd"] as const).some(
      (key) => Date.parse(input[key]) !== Date.parse(window[key]),
    )
  )
    return "WINDOW_MISMATCH";
  return Date.parse(input.visibleAt) === Date.parse(query.visibleAt) ? null : "WINDOW_MISMATCH";
}
async function authorize(
  options: Captured,
  query: MetricSourceQuery,
): Promise<MetricResult<ConnectorBinding>> {
  const { actor } = options;
  if (!permissions.every((permission) => actor.permissions.includes(permission)))
    return failure("FORBIDDEN");
  if (
    actor.organizationId !== query.binding.organizationId ||
    actor.workspaceId !== query.binding.workspaceId
  )
    return failure("SCOPE_MISMATCH");
  try {
    const authorized = result(await options.authorizeBinding(actor, query.binding));
    if (!authorized.ok) return authorized;
    const parsed = ConnectorBindingSchema.safeParse(authorized.value);
    if (!parsed.success) return failure("INVALID_INPUT");
    return isDeepStrictEqual(parsed.data, query.binding)
      ? { ok: true, value: query.binding }
      : failure("SCOPE_MISMATCH");
  } catch {
    return failure("SOURCE_UNAVAILABLE");
  }
}
async function readInput(
  options: Captured,
  query: MetricSourceQuery,
): Promise<MetricResult<MetricInputV1>> {
  try {
    const source = result(await options.source.read(query));
    if (!source.ok) return source;
    const parsed = MetricInputV1Schema.safeParse(source.value);
    if (!parsed.success) return failure("INVALID_INPUT");
    const mismatch = inputMismatch(parsed.data, query);
    return mismatch ? failure(mismatch) : { ok: true, value: freeze(parsed.data) };
  } catch {
    return failure("SOURCE_UNAVAILABLE");
  }
}
function resolveDefinition(options: Captured, version: string): MetricResult<MetricDefinition> {
  try {
    const resolved = result(options.registry.resolve(version));
    if (!resolved.ok) return resolved;
    const parsed = definitionSchema.safeParse(resolved.value);
    if (!parsed.success) return failure("INVALID_INPUT");
    return parsed.data.definitionVersion === version
      ? { ok: true, value: parsed.data }
      : failure("VERSION_MISMATCH");
  } catch {
    return failure("SOURCE_UNAVAILABLE");
  }
}
function validateCalculation(
  options: Captured,
  request: MetricCalculationRequest,
  value: unknown,
): MetricResult<MetricComputationV1> {
  const calculated = result(value);
  if (!calculated.ok) return calculated;
  const parsed = MetricComputationV1Schema.safeParse(calculated.value);
  if (!parsed.success) return failure("INVALID_INPUT");
  const { snapshot, input } = parsed.data;
  if (
    snapshot.metric.kind !== request.kind ||
    !isDeepStrictEqual(snapshot.subject, request.subject)
  )
    return failure("INVALID_INPUT");
  if (snapshot.computedAt !== request.computedAt) return failure("INVALID_INPUT");
  const identity = { kind: request.kind, subject: request.subject };
  const original = options.hasher.create({ ...identity, input: request.input });
  const returned = options.hasher.create({ ...identity, input });
  if (!original.ok) return original;
  if (!returned.ok) return returned;
  if (original.value.inputHash !== returned.value.inputHash) return failure("CONFLICT");
  return { ok: true, value: freeze({ input: request.input, snapshot }) };
}
function calculateAll(
  options: Captured,
  calculator: MetricCalculator,
  request: MetricComputeRequest,
  input: MetricInputV1,
): MetricResult<readonly MetricComputationV1[]> {
  const computations: MetricComputationV1[] = [];
  try {
    for (const coverage of request.query.coverageRequests) {
      const calculation = freeze({ input, ...coverage, computedAt: request.computedAt });
      const computed = validateCalculation(options, calculation, calculator.calculate(calculation));
      if (!computed.ok) return computed;
      computations.push(computed.value);
    }
    return { ok: true, value: freeze(computations) };
  } catch {
    return failure("INVALID_INPUT");
  }
}
function comparable(snapshot: MetricSnapshotV1): unknown {
  const { computedAt, ...rest } = snapshot;
  void computedAt;
  return {
    ...rest,
    periodStart: new Date(rest.periodStart).toISOString(),
    periodEnd: new Date(rest.periodEnd).toISOString(),
    visibleAt: new Date(rest.visibleAt).toISOString(),
    sourceWatermark:
      rest.sourceWatermark === null ? null : new Date(rest.sourceWatermark).toISOString(),
    evidenceIds: [...rest.evidenceIds].sort(),
    issues: rest.issues
      .map((issue) => ({
        code: issue.code,
        field: issue.field,
        evidenceIds: [...issue.evidenceIds].sort(),
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  };
}
async function appendAll(
  options: Captured,
  computations: readonly MetricComputationV1[],
): Promise<MetricResult<readonly MetricSnapshotV1[]>> {
  const snapshots: MetricSnapshotV1[] = [];
  try {
    for (const computation of computations) {
      const appended = result(await options.repository.append(computation));
      if (!appended.ok) return appended;
      const parsed = storedSnapshotSchema.safeParse(appended.value);
      if (
        !parsed.success ||
        !isDeepStrictEqual(comparable(parsed.data), comparable(computation.snapshot))
      )
        return failure("CONFLICT");
      snapshots.push(freeze(parsed.data));
    }
    return { ok: true, value: freeze(snapshots) };
  } catch {
    return failure("SOURCE_UNAVAILABLE");
  }
}
async function compute(
  options: Captured,
  value: MetricComputeRequest,
): Promise<MetricResult<readonly MetricSnapshotV1[]>> {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) return failure("INVALID_INPUT");
  const request = freeze(parsed.data);
  const authorized = await authorize(options, request.query);
  if (!authorized.ok) return authorized;
  const definition = resolveDefinition(options, request.query.definitionVersion);
  if (!definition.ok) return failure(definition.error.code);
  const source = await readInput(options, request.query);
  if (!source.ok) return source;
  const calculated = calculateAll(options, definition.value.calculator, request, source.value);
  return calculated.ok ? appendAll(options, calculated.value) : calculated;
}
/** Construction is server-only: capture the authenticated actor and its actor-bound repository. */
export function createMetricComputationService(
  options: MetricComputationServiceOptions,
): MetricComputationService {
  const actor = freeze(TenantContextSchema.parse(options.actor));
  const { read } = options.source,
    { append, read: readSnapshot } = options.repository;
  const { resolve } = options.registry,
    { authorizeBinding } = options;
  const registry = Object.freeze({ resolve });
  const captured: Captured = Object.freeze({
    actor,
    source: Object.freeze({ read }),
    repository: Object.freeze({ append, read: readSnapshot }),
    registry,
    authorizeBinding,
    hasher: createMetricEvidenceHasher(registry),
  });
  return Object.freeze({ compute: (request: MetricComputeRequest) => compute(captured, request) });
}

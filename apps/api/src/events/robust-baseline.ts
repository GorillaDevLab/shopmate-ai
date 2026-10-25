import {
  BaselineRequestSchema,
  RobustBaselineV1Schema,
  SourceVersionSchema,
  sameEventPeriod,
  type BaselinePort,
  type BaselineRequest,
  type EventErrorCode,
  type EventCancellationObservation,
  type EventAdSpendObservation,
  type EventNormalizedObservation,
  type EventResult,
  type EventSourceReference,
  type MetricSnapshotV1,
  type RobustBaselineV1,
} from "@shopmate/contracts";
import { z } from "zod";
import { createMetricWindowResolver } from "../metrics/metric-window.js";

/** Server-owned configuration; callers must pin this exact version in each request. */
const policySchema = z
  .strictObject({
    version: SourceVersionSchema,
    minimumSamples: z.number().int().min(1).max(200),
    lookbackWeeks: z.number().int().min(1).max(200),
    maximumAgeSeconds: z
      .number()
      .int()
      .min(0)
      .max(Math.floor(Number.MAX_SAFE_INTEGER / 1000)),
  })
  .refine((value) => value.minimumSamples <= value.lookbackWeeks)
  .readonly();
export type RobustBaselinePolicy = z.infer<typeof policySchema>;
type Sample = Readonly<{
  period: EventSourceReference["period"];
  value: number | null;
  visibleAt: string;
  computedAt: string;
  sourceWatermark: string | null;
  status: MetricSnapshotV1["status"];
  sampleSize: number;
  issues: MetricSnapshotV1["issues"];
  evidenceIds: readonly string[];
  reference: EventSourceReference;
  content: string;
}>;
const weekMs = 7 * 86400000;
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function failure<T>(code: EventErrorCode, evidenceIds: readonly string[] = []): EventResult<T> {
  return { ok: false, error: { code, evidenceIds } };
}
function matchesReference(snapshot: MetricSnapshotV1, ref: EventSourceReference): boolean {
  return (
    ref.kind === "METRIC_SNAPSHOT" &&
    ref.version === snapshot.inputRevision &&
    sameEventPeriod(ref.period, snapshot) &&
    Date.parse(ref.observedAt) >= Date.parse(snapshot.computedAt)
  );
}
function periodInstants(period: { readonly periodStart: string; readonly periodEnd: string }) {
  return { periodStart: Date.parse(period.periodStart), periodEnd: Date.parse(period.periodEnd) };
}
function referenceContent(ref: EventSourceReference): string {
  return JSON.stringify({
    ...ref,
    period: { ...ref.period, ...periodInstants(ref.period) },
    observedAt: Date.parse(ref.observedAt),
  });
}
function snapshotContent(snapshot: MetricSnapshotV1): string {
  // Validated object field order is fixed; timestamp spellings identify instants, not revisions.
  return JSON.stringify({
    ...snapshot,
    ...periodInstants(snapshot),
    visibleAt: Date.parse(snapshot.visibleAt),
    computedAt: Date.parse(snapshot.computedAt),
    sourceWatermark:
      snapshot.sourceWatermark === null ? null : Date.parse(snapshot.sourceWatermark),
  });
}
function metricSample(snapshot: MetricSnapshotV1, reference: EventSourceReference): Sample {
  return {
    period: reference.period,
    value: snapshot.metric.value,
    visibleAt: snapshot.visibleAt,
    computedAt: snapshot.computedAt,
    sourceWatermark: snapshot.sourceWatermark,
    status: snapshot.status,
    sampleSize: snapshot.sampleSize,
    issues: snapshot.issues,
    evidenceIds: snapshot.evidenceIds,
    reference,
    content: snapshotContent(snapshot),
  };
}
function cancellationSample(item: EventCancellationObservation): Sample {
  const content = JSON.stringify({
    ...item,
    reference: referenceContent(item.reference),
    rate: { ...item.rate, period: { ...item.rate.period, ...periodInstants(item.rate.period) } },
    visibleAt: Date.parse(item.visibleAt),
    computedAt: Date.parse(item.computedAt),
    sourceWatermark: item.sourceWatermark === null ? null : Date.parse(item.sourceWatermark),
  });
  return {
    period: item.reference.period,
    value: item.rate.valueBasisPoints,
    visibleAt: item.visibleAt,
    computedAt: item.computedAt,
    sourceWatermark: item.sourceWatermark,
    status: item.quality.dataStatus,
    sampleSize: item.quality.sampleSize,
    issues: item.quality.issues,
    evidenceIds: item.evidenceIds,
    reference: item.reference,
    content,
  };
}
function spendSample(item: EventAdSpendObservation): Sample {
  const measuredCoverage =
    item.measuredCoverage === null
      ? null
      : {
          ...item.measuredCoverage,
          ...periodInstants(item.measuredCoverage),
          observedAt: Date.parse(item.measuredCoverage.observedAt),
        };
  const content = JSON.stringify({
    ...item,
    reference: referenceContent(item.reference),
    measuredCoverage,
    visibleAt: Date.parse(item.visibleAt),
    computedAt: Date.parse(item.computedAt),
    sourceWatermark: item.sourceWatermark === null ? null : Date.parse(item.sourceWatermark),
  });
  return {
    period: item.reference.period,
    value: item.spendMinor,
    visibleAt: item.visibleAt,
    computedAt: item.computedAt,
    sourceWatermark: item.sourceWatermark,
    status: item.quality.dataStatus,
    sampleSize: item.quality.sampleSize,
    issues: item.quality.issues,
    evidenceIds: item.evidenceIds,
    reference: item.reference,
    content,
  };
}
function normalizedSample(item: EventNormalizedObservation): Sample {
  return "spendMinor" in item ? spendSample(item) : cancellationSample(item);
}
function aggregatePayloadConflict(input: readonly Sample[]): boolean {
  const seen = new Map<string, string>();
  for (const sample of input) {
    if (sample.reference.kind !== "NORMALIZED_AGGREGATE") continue;
    const key = JSON.stringify([
      sample.reference.kind,
      sample.reference.id,
      sample.reference.version,
    ]);
    if (seen.has(key) && seen.get(key) !== sample.content) return true;
    seen.set(key, sample.content);
  }
  return false;
}
function referenceConflict(refs: readonly EventSourceReference[]): boolean {
  const seen = new Map<string, string>();
  for (const ref of refs) {
    const key = JSON.stringify([ref.kind, ref.id, ref.version]);
    const content = referenceContent(ref);
    if (seen.has(key) && seen.get(key) !== content) return true;
    seen.set(key, content);
  }
  return false;
}
function samples(request: BaselineRequest): EventResult<readonly Sample[]> {
  if (referenceConflict(request.sourceReferences)) return failure("CONFLICT");
  const output: Sample[] = [];
  for (const snapshot of request.candidates) {
    const refs = request.sourceReferences.filter((ref) => matchesReference(snapshot, ref));
    refs.sort((left, right) => compareText(referenceContent(left), referenceContent(right)));
    if (!refs[0]) return failure("INVALID_INPUT", snapshot.evidenceIds);
    output.push(metricSample(snapshot, refs[0]));
  }
  output.push(...(request.normalizedObservations ?? []).map(normalizedSample));
  return aggregatePayloadConflict(output) ? failure("CONFLICT") : { ok: true, value: output };
}
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function businessDate(time: string): string {
  const parts = dateFormatter.formatToParts(new Date(time));
  const part = (kind: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === kind)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function aligned(request: BaselineRequest, sample: Sample): boolean {
  const windows = createMetricWindowResolver({
    snapshot: () => ({ now: request.observedAt, revision: 0 }),
  });
  const result = windows.align(
    request.period,
    businessDate(sample.period.periodStart),
    request.observedAt,
  );
  return result.ok && result.value.aligned && sameEventPeriod(result.value.baseline, sample.period);
}
function observationOrder(left: Sample, right: Sample): number {
  return (
    Date.parse(left.visibleAt) - Date.parse(right.visibleAt) ||
    Date.parse(left.computedAt) - Date.parse(right.computedAt)
  );
}
function uniqueWindows(input: readonly Sample[]): EventResult<readonly Sample[]> {
  // Inspect newest observations first so superseded ties cannot depend on input order.
  const ordered = [...input].sort((a, b) => observationOrder(b, a));
  const groups = new Map<string, Sample>();
  for (const sample of ordered) {
    const key = JSON.stringify([
      Date.parse(sample.period.periodStart),
      Date.parse(sample.period.periodEnd),
    ]);
    const prior = groups.get(key);
    const order = prior ? observationOrder(sample, prior) : 1;
    if (prior && order === 0 && sample.content !== prior.content)
      return failure("CONFLICT", [...new Set([...prior.evidenceIds, ...sample.evidenceIds])]);
    if (!prior || order > 0) groups.set(key, sample);
  }
  return {
    ok: true,
    value: [...groups.values()].sort(
      (a, b) => Date.parse(b.period.periodStart) - Date.parse(a.period.periodStart),
    ),
  };
}
function stale(sample: Sample, request: BaselineRequest, policy: RobustBaselinePolicy): boolean {
  const age = Date.parse(request.observedAt) - Date.parse(sample.period.periodEnd);
  const distance = Date.parse(request.period.periodStart) - Date.parse(sample.period.periodStart);
  return (
    distance > policy.lookbackWeeks * weekMs ||
    age > policy.maximumAgeSeconds * 1000 ||
    sample.status === "STALE" ||
    sample.issues.some((issue) => issue.code === "STALE_SOURCE")
  );
}
function usable(sample: Sample, request: BaselineRequest, policy: RobustBaselinePolicy): boolean {
  return (
    !stale(sample, request, policy) &&
    sample.status === "VERIFIED" &&
    sample.value !== null &&
    sample.sampleSize > 0
  );
}
/** Fixed dyadic scale retains every IEEE-754 input and both median half steps exactly. */
function exactValue(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 2047n);
  const fraction = bits & ((1n << 52n) - 1n);
  const significand = exponent === 0 ? fraction : fraction + (1n << 52n);
  const scaled = significand << BigInt((exponent === 0 ? 0 : exponent - 1) + 2);
  return bits >> 63n === 0n ? scaled : -scaled;
}
function median(values: readonly bigint[]): bigint {
  const sorted = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2n;
}
function magnitude(value: bigint): bigint {
  return value < 0n ? -value : value;
}
function boundedNumber(value: bigint): number | null {
  if (magnitude(value) > BigInt(Number.MAX_SAFE_INTEGER) << 1076n) return null;
  if (value === 0n) return 0;
  let significand = magnitude(value);
  let exponent = -1076;
  while (significand % 2n === 0n) {
    significand /= 2n;
    exponent++;
  }
  if (significand > (1n << 53n) - 1n || exponent < -1074) return null;
  const number = Number(significand) * 2 ** exponent;
  return value < 0n ? -number : number;
}
function statistics(input: readonly Sample[]): EventResult<{ median: number; mad: number }> {
  const values: bigint[] = [];
  for (const sample of input) {
    if (sample.value === null) return failure("INVALID_INPUT");
    values.push(exactValue(sample.value));
  }
  const center = median(values);
  const deviation = median(values.map((value) => magnitude(value - center)));
  const medianNumber = boundedNumber(center);
  const mad = boundedNumber(deviation);
  if (medianNumber === null || mad === null)
    return failure(
      "OVERFLOW",
      input.map((sample) => sample.reference.id),
    );
  return { ok: true, value: { median: medianNumber, mad } };
}
function unavailable(request: BaselineRequest, status: "MISSING" | "UNALIGNED"): RobustBaselineV1 {
  return {
    status,
    alignment: status,
    measure: request.measure,
    aggregation: "EXACT_MEDIAN",
    version: request.baselineVersion,
    period: null,
    median: null,
    mad: null,
    sampleSize: 0,
    coverageBasisPoints: 0,
    sourceReferences: status === "MISSING" ? [] : request.sourceReferences.slice(0, 200),
  };
}
function baseline(
  request: BaselineRequest,
  input: readonly Sample[],
  policy: RobustBaselinePolicy,
): EventResult<RobustBaselineV1> {
  const selected = input.filter((sample) => usable(sample, request, policy));
  // Coverage measures usable historical slots out of this policy's lookback, not transactions.
  const coverageBasisPoints = Math.floor((selected.length * 10000) / policy.lookbackWeeks);
  const common = {
    alignment: "ALIGNED" as const,
    measure: request.measure,
    aggregation: "EXACT_MEDIAN" as const,
    version: policy.version,
    period: (selected[0] ?? input[0]).reference.period,
    sampleSize: selected.length,
    coverageBasisPoints,
  };
  if (selected.length < policy.minimumSamples)
    return {
      ok: true,
      value: {
        ...common,
        status: input.every((sample) => stale(sample, request, policy)) ? "STALE" : "INSUFFICIENT",
        median: null,
        mad: null,
        sourceReferences: input.slice(0, 200).map((sample) => sample.reference),
      },
    };
  const stats = statistics(selected);
  if (!stats.ok) return stats;
  const value = {
    ...common,
    ...stats.value,
    sourceReferences: selected.map((sample) => sample.reference),
  };
  return validatedBaseline({ ...value, status: value.median === 0 ? "ZERO" : "AVAILABLE" });
}
function validatedBaseline(value: unknown): EventResult<RobustBaselineV1> {
  const parsed = RobustBaselineV1Schema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : failure("OVERFLOW");
}
function evaluate(
  input: BaselineRequest,
  policy: RobustBaselinePolicy,
): EventResult<RobustBaselineV1> {
  const parsed = BaselineRequestSchema.safeParse(input);
  if (!parsed.success) return failure("INVALID_INPUT");
  const request = parsed.data;
  if (request.baselineVersion !== policy.version) return failure("VERSION_MISMATCH");
  const observed = samples(request);
  if (!observed.ok) return observed;
  if (observed.value.length === 0) return { ok: true, value: unavailable(request, "MISSING") };
  const comparable = observed.value.filter((sample) => aligned(request, sample));
  if (comparable.length === 0) return { ok: true, value: unavailable(request, "UNALIGNED") };
  const unique = uniqueWindows(comparable);
  return unique.ok ? baseline(request, unique.value, policy) : unique;
}
/** Pure evaluation over supplied visible observations; no source fetching or runtime registration. */
export function createRobustBaseline(input: RobustBaselinePolicy): BaselinePort {
  const policy = policySchema.parse(input);
  return Object.freeze({ evaluate: (request: BaselineRequest) => evaluate(request, policy) });
}

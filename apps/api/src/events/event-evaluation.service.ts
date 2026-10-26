import {
  BaselineRequestSchema,
  ConnectorBindingSchema,
  EventDetectionOutcomeSchema,
  EventDetectionRequestSchema,
  EventEvidenceV1Schema,
  EventMeasureSchema,
  EventPeriodSchema,
  EventRulePolicyV1Schema,
  EventTimestampSchema,
  EventTypeSchema,
  ExternalIdSchema,
  MetricSnapshotV1Schema,
  RobustBaselineV1Schema,
  SourceVersionSchema,
  TenantContextSchema,
  sameEventBinding,
  sameEventPeriod,
  type BaselinePort,
  type DataQualityIssueV1,
  type EventCandidate,
  type EventDetectionOutcome,
  type EventDetectionRequest,
  type EventDetector,
  type EventEntity,
  type EventEvidenceV1,
  type EventErrorCode,
  type EventResult,
  type EventRulePolicyV1,
  type EventType,
  type MetricReadPort,
  type MetricSnapshotV1,
  type RobustBaselineV1,
  type TenantContext,
} from "@shopmate/contracts";
import { z } from "zod";

const jobSchema = z
  .strictObject({
    evidence: EventEvidenceV1Schema,
    measures: z.array(EventMeasureSchema).max(100).readonly(),
    baselineRequest: BaselineRequestSchema.nullable(),
  })
  .readonly();
const runSchema = z
  .strictObject({
    binding: ConnectorBindingSchema,
    period: EventPeriodSchema,
    observedAt: EventTimestampSchema,
    definitionVersion: SourceVersionSchema,
    inputRevision: SourceVersionSchema,
    sourceWatermark: EventTimestampSchema.nullable(),
    rulePolicyVersion: SourceVersionSchema,
    jobs: z.array(jobSchema).min(1).max(200).readonly(),
  })
  .readonly();
type Run = z.infer<typeof runSchema>;
type Job = z.infer<typeof jobSchema>;
const errorSchema = z
  .strictObject({
    code: z.enum([
      "INVALID_INPUT",
      "SCOPE_MISMATCH",
      "VERSION_MISMATCH",
      "WINDOW_MISMATCH",
      "FORBIDDEN",
      "NOT_FOUND",
      "CONFLICT",
      "SOURCE_UNAVAILABLE",
      "OVERFLOW",
    ]),
    evidenceIds: z.array(ExternalIdSchema).readonly(),
  })
  .readonly();
function resultSchema<T extends z.ZodType>(schema: T) {
  return z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), value: schema }),
    z.strictObject({ ok: z.literal(false), error: errorSchema }),
  ]);
}
function failure<T>(code: EventErrorCode): EventResult<T> {
  return { ok: false, error: { code, evidenceIds: [] } };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => compare(left, right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function sameTime(left: string | null, right: string | null): boolean {
  return left === null || right === null ? left === right : Date.parse(left) === Date.parse(right);
}

export interface EventDetectorRegistration {
  readonly eventType: EventType;
  readonly rulePolicyVersion: string;
  readonly detector: EventDetector;
}
export interface EventEvaluation {
  readonly eventType: EventType;
  readonly entity: EventEntity;
  readonly outcome: EventDetectionOutcome;
}
export interface EventEvaluationRun {
  readonly frame: Readonly<Omit<Run, "jobs">>;
  readonly candidates: readonly EventCandidate[];
  readonly evaluations: readonly EventEvaluation[];
}
export class EventDetectorRegistry {
  readonly policy: EventRulePolicyV1;
  readonly #detectors = new Map<EventType, EventDetector>();
  constructor(policy: EventRulePolicyV1, entries: readonly EventDetectorRegistration[]) {
    this.policy = freeze(EventRulePolicyV1Schema.parse(policy));
    for (const entry of entries) {
      const eventType = EventTypeSchema.parse(entry.eventType);
      if (
        entry.rulePolicyVersion !== this.policy.version ||
        this.#detectors.has(eventType) ||
        !this.policy.rules.some((rule) => rule.eventType === eventType)
      )
        throw new RangeError("Duplicate, unconfigured or unpinned event detector");
      if (typeof entry.detector?.detect !== "function") throw new TypeError("Invalid detector");
      this.#detectors.set(
        eventType,
        Object.freeze({ detect: entry.detector.detect.bind(entry.detector) }),
      );
    }
    Object.freeze(this);
  }
  has(eventType: EventType): boolean {
    return this.#detectors.has(eventType);
  }
  detect(request: EventDetectionRequest): EventResult<EventDetectionOutcome> {
    const parsed = EventDetectionRequestSchema.safeParse(request);
    if (!parsed.success) return failure("INVALID_INPUT");
    if (canonical(parsed.data.policy) !== canonical(this.policy))
      return failure("VERSION_MISMATCH");
    const detector = this.#detectors.get(parsed.data.evidence.eventType);
    return detector ? detector.detect(freeze(parsed.data)) : failure("INVALID_INPUT");
  }
}

function jobError(run: Run, job: Job, registry: EventDetectorRegistry): EventErrorCode | null {
  const evidence = job.evidence;
  if (!registry.has(evidence.eventType)) return "INVALID_INPUT";
  if (evidence.baseline !== null && !observedBaseline(evidence.baseline, run.observedAt))
    return "WINDOW_MISMATCH";
  if (!sameEventBinding(evidence.binding, run.binding)) return "SCOPE_MISMATCH";
  if (!sameEventPeriod(evidence, run.period)) return "WINDOW_MISMATCH";
  if (
    evidence.definitionVersion !== run.definitionVersion ||
    evidence.sourceReferences.some((ref) => ref.version !== run.inputRevision)
  )
    return "VERSION_MISMATCH";
  if (
    !sameTime(evidence.observedAt, run.observedAt) ||
    !sameTime(evidence.sourceWatermark, run.sourceWatermark)
  )
    return "CONFLICT";
  const baseline = job.baselineRequest;
  if (baseline === null) return null;
  if (
    !sameEventBinding(baseline.binding, run.binding) ||
    canonical(baseline.entity) !== canonical(evidence.entity) ||
    baseline.eventType !== evidence.eventType
  )
    return "SCOPE_MISMATCH";
  if (!sameEventPeriod(baseline.period, run.period)) return "WINDOW_MISMATCH";
  if (
    baseline.definitionVersion !== run.definitionVersion ||
    baseline.baselineVersion !== registry.policy.baselineVersion
  )
    return "VERSION_MISMATCH";
  return sameTime(baseline.observedAt, run.observedAt) ? null : "CONFLICT";
}
function snapshotError(run: Run, job: Job, row: MetricSnapshotV1): EventErrorCode | null {
  if (
    !sameEventBinding(row.binding, run.binding) ||
    canonical(row.subject) !== canonical(job.evidence.entity)
  )
    return "SCOPE_MISMATCH";
  if (!sameEventPeriod(row, run.period)) return "WINDOW_MISMATCH";
  if (row.definitionVersion !== run.definitionVersion || row.inputRevision !== run.inputRevision)
    return "VERSION_MISMATCH";
  if (
    !sameTime(row.sourceWatermark, run.sourceWatermark) ||
    !sameTime(row.visibleAt, run.observedAt) ||
    Date.parse(row.computedAt) > Date.parse(run.observedAt)
  )
    return "CONFLICT";
  return job.measures.some(
    (measure) => measure.kind === row.metric.kind && measure.unit === row.metric.unit,
  )
    ? null
    : "INVALID_INPUT";
}
function outcomeError(
  request: EventDetectionRequest,
  outcome: EventDetectionOutcome,
): EventErrorCode | null {
  if (!conservesQuality(request, outcome)) return "CONFLICT";
  if (outcome.disposition !== "CANDIDATE") return null;
  const candidate = outcome.candidate;
  if (
    !sameEventBinding(candidate.evidence.binding, request.evidence.binding) ||
    candidate.evidence.eventType !== request.evidence.eventType ||
    canonical(candidate.evidence.entity) !== canonical(request.evidence.entity)
  )
    return "SCOPE_MISMATCH";
  if (candidate.rulePolicyVersion !== request.policy.version) return "VERSION_MISMATCH";
  return canonical(candidate.evidence) === canonical({ ...request.evidence, ...outcome.quality })
    ? null
    : "CONFLICT";
}
function diagnostic(issue: DataQualityIssueV1): string {
  return canonical({ ...issue, evidenceIds: [...issue.evidenceIds].sort(compare) });
}
function observedBaseline(baseline: RobustBaselineV1, observedAt: string): boolean {
  const period = baseline.period;
  return (
    period === null ||
    (Date.parse(period.periodEnd) <= Date.parse(observedAt) &&
      baseline.sourceReferences.some((ref) => sameEventPeriod(ref.period, period)))
  );
}
function conservesQuality(request: EventDetectionRequest, outcome: EventDetectionOutcome): boolean {
  const quality = outcome.quality;
  const original = request.evidence;
  const issues = [...original.issues, ...request.snapshots.flatMap((row) => row.issues)];
  const reported = new Set(quality.issues.map(diagnostic));
  const precedence = ["UNAVAILABLE", "STALE", "INSUFFICIENT", "ESTIMATED", "VERIFIED"];
  return (
    issues.every((issue) => reported.has(diagnostic(issue))) &&
    quality.sampleSize <= original.sampleSize &&
    quality.coverageBasisPoints <= original.coverageBasisPoints &&
    precedence.indexOf(quality.dataStatus) <= precedence.indexOf(original.dataStatus)
  );
}
function normalizeSnapshots(
  run: Run,
  job: Job,
  rows: readonly MetricSnapshotV1[],
): EventResult<readonly MetricSnapshotV1[]> {
  const unique = new Map<string, MetricSnapshotV1>();
  for (const row of rows) {
    const invalid = snapshotError(run, job, row);
    if (invalid) return failure(invalid);
    const prior = unique.get(row.metric.kind);
    if (prior && canonical(prior) !== canonical(row)) return failure("CONFLICT");
    unique.set(row.metric.kind, row);
  }
  return {
    ok: true,
    value: freeze(
      [...unique.values()].sort((left, right) => compare(left.metric.kind, right.metric.kind)),
    ),
  };
}
function finish(
  run: Run,
  evaluations: readonly EventEvaluation[],
): EventResult<EventEvaluationRun> {
  const candidates = new Map<string, EventCandidate>();
  for (const evaluation of evaluations) {
    if (evaluation.outcome.disposition !== "CANDIDATE") continue;
    const candidate = evaluation.outcome.candidate;
    const previous = candidates.get(candidate.fingerprint);
    if (previous && canonical(previous) !== canonical(candidate)) return failure("CONFLICT");
    candidates.set(candidate.fingerprint, candidate);
  }
  return {
    ok: true,
    value: freeze({
      frame: {
        binding: run.binding,
        period: run.period,
        observedAt: run.observedAt,
        definitionVersion: run.definitionVersion,
        inputRevision: run.inputRevision,
        sourceWatermark: run.sourceWatermark,
        rulePolicyVersion: run.rulePolicyVersion,
      },
      candidates: [...candidates.values()].sort((left, right) =>
        compare(left.fingerprint, right.fingerprint),
      ),
      evaluations: [...evaluations].sort((left, right) =>
        compare(canonical(left), canonical(right)),
      ),
    }),
  };
}
/** Component only. The authenticated host supplies actor and store-authorizing read port.
 * Evidence/reference minting and repository append belong to the P04-017/028 host. */
export class EventEvaluationService {
  readonly #actor: TenantContext;
  constructor(
    actor: TenantContext,
    private readonly metrics: MetricReadPort,
    private readonly baselines: BaselinePort,
    private readonly registry: EventDetectorRegistry,
  ) {
    const parsed = TenantContextSchema.parse(actor);
    if (!parsed.permissions.includes("tenant:read"))
      throw new RangeError("Authenticated read permission required");
    this.#actor = freeze(parsed);
  }
  async evaluate(input: unknown): Promise<EventResult<EventEvaluationRun>> {
    const parsed = runSchema.safeParse(input);
    if (!parsed.success) return failure("INVALID_INPUT");
    const run = freeze(parsed.data);
    const invalid = this.validate(run);
    if (invalid) return failure(invalid);
    try {
      return await this.execute(run);
    } catch {
      return failure("SOURCE_UNAVAILABLE");
    }
  }
  private validate(run: Run): EventErrorCode | null {
    if (
      this.#actor.organizationId !== run.binding.organizationId ||
      this.#actor.workspaceId !== run.binding.workspaceId
    )
      return "FORBIDDEN";
    if (run.rulePolicyVersion !== this.registry.policy.version) return "VERSION_MISMATCH";
    if (
      Date.parse(run.period.periodEnd) > Date.parse(run.observedAt) ||
      (run.sourceWatermark !== null && Date.parse(run.sourceWatermark) > Date.parse(run.observedAt))
    )
      return "INVALID_INPUT";
    for (const job of run.jobs) {
      const invalid = jobError(run, job, this.registry);
      if (invalid) return invalid;
    }
    return null;
  }
  private async execute(run: Run): Promise<EventResult<EventEvaluationRun>> {
    const evaluations: EventEvaluation[] = [];
    const cache = new Map<string, readonly MetricSnapshotV1[]>();
    for (const job of run.jobs) {
      const snapshots = await this.read(run, job, cache);
      if (!snapshots.ok) return snapshots;
      const prepared = this.prepare(job, snapshots.value);
      if (!prepared.ok) return prepared;
      const parsed = resultSchema(EventDetectionOutcomeSchema).safeParse(
        this.registry.detect(prepared.value),
      );
      if (!parsed.success) return failure("INVALID_INPUT");
      if (!parsed.data.ok) return parsed.data;
      const invalid = outcomeError(prepared.value, parsed.data.value);
      if (invalid) return failure(invalid);
      evaluations.push({
        eventType: job.evidence.eventType,
        entity: job.evidence.entity,
        outcome: freeze(parsed.data.value),
      });
    }
    return finish(run, evaluations);
  }
  private async read(
    run: Run,
    job: Job,
    cache: Map<string, readonly MetricSnapshotV1[]>,
  ): Promise<EventResult<readonly MetricSnapshotV1[]>> {
    if (job.evidence.entity.kind === "CONNECTION" && job.measures.length > 0)
      return failure("INVALID_INPUT");
    const query = metricQuery(run, job);
    const key = canonical(query);
    let rows = cache.get(key);
    if (!rows) {
      const parsed = resultSchema(z.array(MetricSnapshotV1Schema).max(200)).safeParse(
        await this.metrics.read(freeze({ actor: this.#actor, query })),
      );
      if (!parsed.success) return failure("INVALID_INPUT");
      if (!parsed.data.ok) return parsed.data;
      const normalized = normalizeSnapshots(run, job, parsed.data.value);
      if (!normalized.ok) return normalized;
      rows = normalized.value;
      cache.set(key, rows);
    }
    return { ok: true, value: rows };
  }
  private prepare(
    job: Job,
    snapshots: readonly MetricSnapshotV1[],
  ): EventResult<EventDetectionRequest> {
    const prepared = this.baselineEvidence(job);
    if (!prepared.ok) return prepared;
    const evidence = prepared.value;
    const parsed = EventDetectionRequestSchema.safeParse({
      evidence,
      snapshots,
      baseline: evidence.baseline,
      policy: this.registry.policy,
    });
    return parsed.success ? { ok: true, value: freeze(parsed.data) } : failure("INVALID_INPUT");
  }
  private baselineEvidence(job: Job): EventResult<EventEvidenceV1> {
    const request = job.baselineRequest;
    if (request === null) return { ok: true, value: job.evidence };
    const parsed = resultSchema(RobustBaselineV1Schema).safeParse(this.baselines.evaluate(request));
    if (!parsed.success) return failure("INVALID_INPUT");
    if (!parsed.data.ok) return parsed.data;
    const baseline = parsed.data.value;
    if (!observedBaseline(baseline, request.observedAt)) return failure("WINDOW_MISMATCH");
    if (
      baseline.version !== this.registry.policy.baselineVersion ||
      canonical(baseline.measure) !== canonical(request.measure)
    )
      return failure("VERSION_MISMATCH");
    if (
      baseline.sourceReferences.some(
        (ref) => !request.sourceReferences.some((source) => canonical(ref) === canonical(source)),
      )
    )
      return failure("CONFLICT");
    return {
      ok: true,
      value: {
        ...job.evidence,
        baseline,
        baselineVersion: baseline.version,
        baselineAlignment: baseline.alignment,
      },
    };
  }
}

function metricQuery(run: Run, job: Job) {
  // A connection has no metric subject; an empty store read still enforces store ownership.
  const subject =
    job.evidence.entity.kind === "CONNECTION" ? { kind: "STORE" as const } : job.evidence.entity;
  return freeze({
    binding: run.binding,
    window: run.period,
    kinds: [...new Set(job.measures.map((measure) => measure.kind))].sort(compare),
    subject,
    definitionVersion: run.definitionVersion,
    inputRevision: run.inputRevision,
    visibleAt: run.observedAt,
  });
}

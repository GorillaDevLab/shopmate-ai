import {
  DecisionControlSchema,
  DecisionProviderDescriptorSchema,
  EvaluationContextSchema,
  EventStateSchema,
  EventTimestampSchema,
  ExternalIdSchema,
  RoutedPrimaryDecisionRunSchema,
  SourceVersionSchema,
  type DecisionControl,
  type DecisionPortError,
  type DecisionPortResult,
  type EvaluationContext,
  type PrimaryDecisionRun,
  type RoutingPort,
  type RoutingRequest,
  type SecurityClock,
  sameDecisionEvidence,
  sameEventBinding,
} from "@shopmate/contracts";
import { z } from "zod";
import { CanonicalHostEvidenceHash } from "./decision-input-sanitizer.js";

const quantity = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const preferences = z
  .strictObject({
    notifications: z.enum(["ALL", "DAILY_ONLY", "NONE"]),
    allowDeep: z.boolean(),
    quietHours: z
      .strictObject({
        timezone: z.string().min(1).max(100),
        startMinute: quantity.max(1439),
        endMinute: quantity.max(1439),
      })
      .nullable(),
  })
  .readonly();
const policy = z
  .strictObject({
    version: SourceVersionSchema,
    cooldownSeconds: quantity,
    breakOnSeverityUpgrade: z.boolean(),
    breakOnRecovery: z.boolean(),
    batchWindowSeconds: quantity.min(1),
    maximumImmediatePerStore: quantity,
  })
  .readonly();
const historyEntry = z
  .strictObject({
    run: RoutedPrimaryDecisionRunSchema,
    eventRevision: quantity.min(1),
    eventState: EventStateSchema,
    policyVersion: SourceVersionSchema,
    routedAt: EventTimestampSchema,
  })
  .readonly();
const snapshotSchema = z
  .strictObject({
    context: EvaluationContextSchema,
    activeRun: RoutedPrimaryDecisionRunSchema,
    decisionKey: ExternalIdSchema,
    provider: DecisionProviderDescriptorSchema,
    rulesetVersion: SourceVersionSchema,
    preferences: preferences.nullable(),
    budget: z.strictObject({ remainingDeepRuns: quantity }).readonly().nullable(),
    policy,
    history: z.array(historyEntry).max(10000).readonly(),
  })
  .readonly();
const requestSchema = z
  .strictObject({
    context: EvaluationContextSchema,
    run: RoutedPrimaryDecisionRunSchema,
    control: DecisionControlSchema,
  })
  .readonly();
type VerifiedRequest = z.infer<typeof requestSchema>;
type HistoryEntry = z.infer<typeof historyEntry>;
const severityRank = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 } as const;

function failure<T>(code: DecisionPortError): DecisionPortResult<T> {
  return Object.freeze({ ok: false, code });
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function verifyBinding(request: VerifiedRequest, snapshot: DecisionRoutingSnapshot) {
  const { context, run } = request;
  if (!context.actor.permissions.includes("tenant:read")) return "FORBIDDEN";
  if (!sameValue(context.actor, snapshot.context.actor)) return "FORBIDDEN";
  if (!sameValue(context, snapshot.context) || !sameValue(run, snapshot.activeRun))
    return "CONFLICT";
  if (
    run.decisionKey !== snapshot.decisionKey ||
    run.eventId !== context.event.id ||
    run.requestId !== context.requestId ||
    run.result.correlationId !== context.correlationId
  )
    return "CONFLICT";
  if (!sameDecisionEvidence(run.evidence, context.evidence.reference)) return "HASH_MISMATCH";
  if (run.rulesetVersion !== snapshot.rulesetVersion || !sameValue(run.provider, snapshot.provider))
    return "VERSION_MISMATCH";
  if (severityRank[run.effective.severity] < severityRank[context.event.severityFloor])
    return "INVALID_INPUT";
  return null;
}

function verifyHistory(snapshot: DecisionRoutingSnapshot, now: number): boolean {
  const binding = snapshot.context.event.binding;
  const ids = new Set<string>();
  return snapshot.history.every((entry) => {
    if (ids.has(entry.run.id)) return false;
    ids.add(entry.run.id);
    return (
      sameEventBinding(binding, entry.run.evidence.binding) &&
      Date.parse(entry.routedAt) <= now &&
      Date.parse(entry.run.createdAt) <= Date.parse(entry.routedAt)
    );
  });
}

function inCooldown(request: VerifiedRequest, snapshot: DecisionRoutingSnapshot, now: number) {
  const entries = snapshot.history.filter(
    (entry) =>
      entry.run.decisionKey === request.run.decisionKey ||
      entry.run.eventId === request.run.eventId,
  );
  const latest = entries.reduce<HistoryEntry | null>(
    (found, entry) =>
      found === null || Date.parse(entry.routedAt) > Date.parse(found.routedAt) ? entry : found,
    null,
  );
  if (
    latest === null ||
    now - Date.parse(latest.routedAt) >= snapshot.policy.cooldownSeconds * 1000
  )
    return false;
  return !breakCooldown(request, snapshot, latest);
}

function breakCooldown(
  request: VerifiedRequest,
  snapshot: DecisionRoutingSnapshot,
  last: HistoryEntry,
) {
  if (
    last.policyVersion !== snapshot.policy.version ||
    request.context.event.revision <= last.eventRevision
  )
    return false;
  const policy = snapshot.policy;
  const upgrade =
    policy.breakOnSeverityUpgrade &&
    request.run.evidence.hash !== last.run.evidence.hash &&
    severityRank[request.run.effective.severity] > severityRank[last.run.effective.severity];
  const recovery =
    policy.breakOnRecovery &&
    request.context.event.state === "RESOLVED" &&
    (last.eventState === "OPEN" || last.eventState === "ACKNOWLEDGED");
  return upgrade || recovery;
}

function routeCooldown(request: VerifiedRequest, snapshot: DecisionRoutingSnapshot, now: number) {
  if (!inCooldown(request, snapshot, now)) return request.run;
  const effective = request.run.effective;
  const notificationRoute =
    effective.notificationRoute === "NOTIFY_NOW" ? "DAILY_BRIEF" : effective.notificationRoute;
  const llmEscalation =
    effective.llmEscalation === "DEEP_REASONING_REQUIRED"
      ? "NO_LLM_NEEDED"
      : effective.llmEscalation;
  if (
    notificationRoute === effective.notificationRoute &&
    llmEscalation === effective.llmEscalation
  )
    return request.run;
  return {
    ...request.run,
    effective: { ...effective, notificationRoute, llmEscalation },
    overrideReason: "COOLDOWN" as const,
  };
}

/** Card-local trusted server state; the host must load/serialize it within its routing unit of work. */
export type DecisionRoutingSnapshot = z.infer<typeof snapshotSchema>;
export interface DecisionRoutingState {
  readonly load: (
    context: EvaluationContext,
    control: DecisionControl,
  ) => Promise<DecisionPortResult<DecisionRoutingSnapshot>>;
}

export class DecisionRoutingService implements RoutingPort {
  readonly #hasher = new CanonicalHostEvidenceHash();
  constructor(
    private readonly state: DecisionRoutingState,
    private readonly clock: SecurityClock,
  ) {}

  async route(request: RoutingRequest): Promise<DecisionPortResult<PrimaryDecisionRun>> {
    try {
      const parsed = requestSchema.safeParse(request);
      if (!parsed.success) return failure("INVALID_INPUT");
      const validity = this.currentTime(parsed.data.control);
      if (!validity.ok) return validity;
      const hash = this.#hasher.hash(parsed.data.context.evidence.evidence);
      if (!hash.ok) return hash;
      if (hash.value !== parsed.data.context.evidence.reference.hash)
        return failure("HASH_MISMATCH");
      return await this.loadAndRoute(parsed.data);
    } catch {
      // Nested frozen schemas can throw arithmetic refinements; fail closed at this boundary.
      return failure("INVALID_INPUT");
    }
  }

  private currentTime(control: DecisionControl): DecisionPortResult<number> {
    if (this.clock.timeDomain !== "SECURITY_UTC") return failure("INVALID_INPUT");
    const now = this.clock.now();
    if (!EventTimestampSchema.safeParse(now).success) return failure("INVALID_INPUT");
    const milliseconds = Date.parse(now);
    if (control.signal.aborted || milliseconds >= Date.parse(control.deadlineAt))
      return failure("UNAVAILABLE");
    return { ok: true, value: milliseconds };
  }

  private async loadAndRoute(
    request: VerifiedRequest,
  ): Promise<DecisionPortResult<PrimaryDecisionRun>> {
    let loaded: DecisionPortResult<DecisionRoutingSnapshot>;
    try {
      loaded = await this.state.load(request.context, request.control);
    } catch {
      // Server state outage cannot grant an unthrottled route.
      return failure("UNAVAILABLE");
    }
    const current = this.currentTime(request.control);
    if (!current.ok) return current;
    if (!loaded.ok) return loaded;
    const snapshot = snapshotSchema.safeParse(loaded.value);
    if (!snapshot.success) return failure("INVALID_INPUT");
    const error = verifyBinding(request, snapshot.data);
    if (error !== null) return failure(error);
    if (!verifyHistory(snapshot.data, current.value)) return failure("INVALID_INPUT");
    const run = RoutedPrimaryDecisionRunSchema.parse(
      routeCooldown(request, snapshot.data, current.value),
    );
    const final = this.currentTime(request.control);
    return final.ok ? Object.freeze({ ok: true, value: run }) : final;
  }
}

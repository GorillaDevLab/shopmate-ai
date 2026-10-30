import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  DecisionControlSchema,
  DecisionLabelsSchema,
  DecisionOverrideReasonSchema,
  DecisionProviderDescriptorSchema,
  DecisionRulesetV1Schema,
  EvaluationContextSchema,
  EventTimestampSchema,
  ExternalIdSchema,
  PrimaryDecisionRunSchema,
  SanitizedDecisionInputSchema,
  sameDecisionEvidence,
  type DecisionControl,
  type DecisionHardGate,
  type DecisionHardGateResult,
  type DecisionInputSanitizer,
  type DecisionPortError,
  type DecisionPortResult,
  type DecisionProvider,
  type DecisionResult,
  type DecisionRulesetV1,
  type DecisionUnavailableCode,
  type EvaluationContext,
  type PrimaryDecisionRun,
  type RoutingPort,
  type SanitizedDecisionInput,
  type SecurityClock,
} from "@shopmate/contracts";
import { z } from "zod";
import { DefaultDecisionInputSanitizer } from "./decision-input-sanitizer.js";
import { DecisionResultValidator } from "./decision-result-validator.js";

const errorCode = z.enum([
  "INVALID_INPUT",
  "FORBIDDEN",
  "SCOPE_MISMATCH",
  "VERSION_MISMATCH",
  "HASH_MISMATCH",
  "CONFLICT",
  "UNAVAILABLE",
]);
function portSchema<T extends z.ZodType>(schema: T) {
  return z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), value: schema }),
    z.strictObject({ ok: z.literal(false), code: errorCode }),
  ]);
}
const claimSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("CLAIMED"), commitToken: ExternalIdSchema }).readonly(),
  z.strictObject({ status: z.literal("COMMITTED"), run: PrimaryDecisionRunSchema }).readonly(),
]);
const gateSchema = portSchema(
  z.strictObject({
    effective: DecisionLabelsSchema,
    overrideReason: DecisionOverrideReasonSchema.nullable(),
  }),
);
const runResultSchema = portSchema(PrimaryDecisionRunSchema);

export interface DecisionClaimRequest {
  readonly context: EvaluationContext;
  readonly decisionKey: string;
  /** Overall lease expiry covers primary attempt AND fallback; never the shorter attempt deadline. */
  readonly control: DecisionControl;
}
export interface DecisionCommitRequest extends DecisionClaimRequest {
  readonly commitToken: string;
  readonly runs: readonly PrimaryDecisionRun[];
}
export type DecisionClaim = z.infer<typeof claimSchema>;
/** API-local orchestration seam, NOT a durable implementation of the shared append-only repository.
 * The adapter must authorize current membership/store/evidence, claim a scoped stable key, then lock
 * and verify its token/overall lease before invoking route at most once. Route, immutable history,
 * effective winner, audit and effects must share ONE transaction. A failed route rolls back.
 * An unavailable terminal records history only: it must never become an effective winner.
 * No-winner retries/expired claims return CONFLICT; a committed evaluated winner is reusable.
 */
export interface DecisionEvaluationAuthority {
  readonly claim: (request: DecisionClaimRequest) => Promise<DecisionPortResult<DecisionClaim>>;
  readonly commit: (
    request: DecisionCommitRequest,
    route: (run: PrimaryDecisionRun) => Promise<DecisionPortResult<PrimaryDecisionRun>>,
  ) => Promise<DecisionPortResult<PrimaryDecisionRun>>;
}
export interface DecisionProviderRegistration {
  readonly mode: "PRIMARY" | "SHADOW";
  readonly provider: DecisionProvider;
}
/** Server construction only; evaluate requests cannot select a provider or grant SHADOW authority. */
export class DecisionProviderRegistry {
  readonly #registrations: readonly DecisionProviderRegistration[];
  constructor(
    rules: DecisionProvider,
    registrations: readonly DecisionProviderRegistration[] = [],
  ) {
    if (rules.descriptor.key !== "rules") throw new RangeError("Rules fallback required");
    const entries = [{ mode: "PRIMARY" as const, provider: rules }, ...registrations];
    const keys = new Set<string>();
    this.#registrations = Object.freeze(
      entries.map((entry) => {
        if (entry.mode !== "PRIMARY" && entry.mode !== "SHADOW")
          throw new RangeError("Invalid mode");
        const descriptor = DecisionProviderDescriptorSchema.parse(entry.provider.descriptor);
        if (keys.has(descriptor.key)) throw new RangeError("Duplicate provider key");
        keys.add(descriptor.key);
        if (typeof entry.provider.evaluate !== "function")
          throw new RangeError("Provider required");
        return Object.freeze({
          mode: entry.mode,
          provider: Object.freeze({
            descriptor,
            evaluate: entry.provider.evaluate.bind(entry.provider),
          }),
        });
      }),
    );
  }
  primary(key = "rules"): DecisionProvider {
    const entry = this.#registrations.find((item) => item.provider.descriptor.key === key);
    if (!entry || entry.mode !== "PRIMARY") throw new RangeError("PRIMARY provider unavailable");
    return entry.provider;
  }
}
export interface DecisionEvaluationHostOptions {
  readonly registry: DecisionProviderRegistry;
  readonly authority: DecisionEvaluationAuthority;
  readonly clock: SecurityClock;
  readonly ruleset: DecisionRulesetV1;
  readonly hardGate: DecisionHardGate;
  readonly routing: RoutingPort;
  readonly sanitizer?: DecisionInputSanitizer;
  readonly primaryKey?: string;
  readonly attemptTimeoutMs?: number;
}
type Lifecycle = Readonly<{
  context: EvaluationContext;
  control: DecisionControl;
  monotonicDeadline: number;
  decisionKey: string;
  input: SanitizedDecisionInput;
  stop: AbortController;
}>;
function failure<T>(code: DecisionPortError): DecisionPortResult<T> {
  return Object.freeze({ ok: false, code });
}
function unavailable(context: EvaluationContext, code: DecisionUnavailableCode): DecisionResult {
  return Object.freeze({
    schemaVersion: 1,
    correlationId: context.correlationId,
    status: "UNAVAILABLE",
    code,
  });
}
function stableKey(
  context: EvaluationContext,
  ruleset: DecisionRulesetV1,
  primary: DecisionProvider,
  fallback: DecisionProvider,
): string {
  const binding = context.event.binding;
  const evidence = context.evidence.reference;
  const fields = [
    binding.organizationId,
    binding.workspaceId,
    binding.storeId,
    binding.connectionId,
    binding.externalStoreId,
    context.event.id,
    context.event.revision,
    context.event.fingerprint,
    context.event.rulePolicyVersion,
    evidence.id,
    evidence.version,
    evidence.hash,
    evidence.definitionVersion,
    evidence.baselineVersion,
    ruleset.version,
    primary.descriptor,
    fallback.descriptor,
  ];
  return `decision:${createHash("sha256").update(JSON.stringify(fields)).digest("hex")}`;
}
function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function matchingRun(run: PrimaryDecisionRun, life: Lifecycle): boolean {
  return (
    run.eventId === life.context.event.id &&
    run.decisionKey === life.decisionKey &&
    sameDecisionEvidence(run.evidence, life.context.evidence.reference)
  );
}

export class DecisionEvaluationHost {
  readonly #ruleset: DecisionRulesetV1;
  readonly #primary: DecisionProvider;
  readonly #fallback: DecisionProvider;
  readonly #timeout: number;
  readonly #sanitizer: DecisionInputSanitizer;
  constructor(private readonly options: DecisionEvaluationHostOptions) {
    this.#ruleset = DecisionRulesetV1Schema.parse(options.ruleset);
    this.#primary = options.registry.primary(options.primaryKey);
    this.#fallback = options.registry.primary("rules");
    this.#timeout = z
      .number()
      .int()
      .min(1)
      .max(2147483647)
      .parse(options.attemptTimeoutMs ?? 1000);
    this.#sanitizer = options.sanitizer ?? new DefaultDecisionInputSanitizer();
    if (options.clock.timeDomain !== "SECURITY_UTC")
      throw new RangeError("Security clock required");
  }
  async evaluate(
    context: unknown,
    control: DecisionControl,
  ): Promise<DecisionPortResult<PrimaryDecisionRun>> {
    try {
      const life = this.prepare(context, control);
      if (!life.ok) return life;
      return await this.withinLifetime(life.value);
    } catch {
      // Injected infrastructure failures expose no raw provider or database detail.
      return failure("UNAVAILABLE");
    }
  }
  private async withinLifetime(life: Lifecycle): Promise<DecisionPortResult<PrimaryDecisionRun>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => undefined;
    const stopped = new Promise<DecisionPortResult<PrimaryDecisionRun>>((resolve) => {
      onAbort = () => {
        life.stop.abort();
        resolve(failure("UNAVAILABLE"));
      };
      life.control.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(onAbort, Math.max(0, life.monotonicDeadline - performance.now()));
      if (life.control.signal.aborted) onAbort();
    });
    try {
      return await Promise.race([this.claimAndEvaluate(life), stopped]);
    } finally {
      clearTimeout(timer);
      life.control.signal.removeEventListener("abort", onAbort);
      life.stop.abort();
    }
  }
  private async claimAndEvaluate(life: Lifecycle): Promise<DecisionPortResult<PrimaryDecisionRun>> {
    const claim = portSchema(claimSchema).safeParse(
      await this.options.authority.claim({
        context: life.context,
        decisionKey: life.decisionKey,
        control: life.control,
      }),
    );
    if (!claim.success) return failure("INVALID_INPUT");
    if (!claim.data.ok) return claim.data;
    if (!this.active(life)) return failure("UNAVAILABLE");
    if (claim.data.value.status === "COMMITTED") return this.reused(claim.data.value.run, life);
    return this.evaluateClaim(life, claim.data.value.commitToken);
  }
  private prepare(raw: unknown, rawControl: DecisionControl): DecisionPortResult<Lifecycle> {
    const context = EvaluationContextSchema.safeParse(raw);
    const control = DecisionControlSchema.safeParse(rawControl);
    if (!context.success || !control.success) return failure("INVALID_INPUT");
    if (!context.data.actor.permissions.includes("tenant:read")) return failure("FORBIDDEN");
    const input = portSchema(SanitizedDecisionInputSchema).safeParse(
      this.#sanitizer.sanitize(context.data),
    );
    if (!input.success) return failure("INVALID_INPUT");
    if (!input.data.ok) return input.data;
    const remaining = Date.parse(control.data.deadlineAt) - this.now();
    if (control.data.signal.aborted || remaining <= 0 || remaining > 2147483647)
      return failure("UNAVAILABLE");
    const life = Object.freeze({
      context: context.data,
      control: control.data,
      monotonicDeadline: performance.now() + remaining,
      input: input.data.value,
      stop: new AbortController(),
      decisionKey: stableKey(context.data, this.#ruleset, this.#primary, this.#fallback),
    });
    return { ok: true, value: life };
  }
  private now(): number {
    return Date.parse(EventTimestampSchema.parse(this.options.clock.now()));
  }
  private active(life: Lifecycle): boolean {
    return (
      !life.control.signal.aborted &&
      !life.stop.signal.aborted &&
      this.now() < Date.parse(life.control.deadlineAt) &&
      performance.now() < life.monotonicDeadline
    );
  }
  private reused(run: PrimaryDecisionRun, life: Lifecycle): DecisionPortResult<PrimaryDecisionRun> {
    if (
      !matchingRun(run, life) ||
      run.rulesetVersion !== this.#ruleset.version ||
      run.result.status !== "EVALUATED" ||
      ![this.#primary, this.#fallback].some((provider) =>
        sameValue(provider.descriptor, run.provider),
      )
    )
      return failure("CONFLICT");
    return Object.freeze({ ok: true, value: run });
  }
  private async evaluateClaim(
    life: Lifecycle,
    commitToken: string,
  ): Promise<DecisionPortResult<PrimaryDecisionRun>> {
    const first = await this.attempt(life, this.#primary, null);
    if (!first.ok) return first;
    const runs = [first.value];
    if (first.value.result.status === "UNAVAILABLE" && this.#primary !== this.#fallback) {
      if (first.value.result.code === "ABORTED") return failure("UNAVAILABLE");
      const fallback = await this.attempt(life, this.#fallback, first.value.id);
      if (!fallback.ok) return fallback;
      runs.push(fallback.value);
    }
    if (!this.active(life)) return failure("UNAVAILABLE");
    const request = Object.freeze({
      context: life.context,
      control: life.control,
      decisionKey: life.decisionKey,
      commitToken,
      runs: Object.freeze(runs),
    });
    return this.commit(request, life);
  }
  private async attempt(
    life: Lifecycle,
    provider: DecisionProvider,
    fallbackOf: string | null,
  ): Promise<DecisionPortResult<PrimaryDecisionRun>> {
    if (!this.active(life)) return failure("UNAVAILABLE");
    const started = performance.now();
    const result = await this.providerResult(life, provider);
    if (!this.active(life)) return failure("UNAVAILABLE");
    const gated = this.gate(life, result, fallbackOf);
    if (!gated.ok) return gated;
    const run = PrimaryDecisionRunSchema.parse({
      schemaVersion: 1,
      id: randomUUID(),
      mode: "PRIMARY",
      eventId: life.context.event.id,
      decisionKey: life.decisionKey,
      requestId: life.context.requestId,
      evidence: life.context.evidence.reference,
      provider: provider.descriptor,
      rulesetVersion: this.#ruleset.version,
      fallbackOf,
      result,
      ...gated.value,
      latencyMs: Math.max(0, Math.floor(performance.now() - started)),
      createdAt: new Date(this.now()).toISOString(),
    });
    return { ok: true, value: run };
  }
  private gate(
    life: Lifecycle,
    result: DecisionResult,
    fallbackOf: string | null,
  ): DecisionPortResult<{
    effective: DecisionHardGateResult["effective"] | null;
    overrideReason: DecisionHardGateResult["overrideReason"];
  }> {
    if (result.status === "UNAVAILABLE")
      return { ok: true, value: { effective: null, overrideReason: null } };
    const gated = gateSchema.safeParse(
      this.options.hardGate.evaluate({
        context: life.context,
        suggestion: result,
        ruleset: this.#ruleset,
      }),
    );
    if (!gated.success) return failure("INVALID_INPUT");
    if (!gated.data.ok) return gated.data;
    return {
      ok: true,
      value: {
        effective: gated.data.value.effective,
        overrideReason:
          gated.data.value.overrideReason ?? (fallbackOf === null ? null : "PROVIDER_UNAVAILABLE"),
      },
    };
  }
  private async providerResult(
    life: Lifecycle,
    provider: DecisionProvider,
  ): Promise<DecisionResult> {
    const { controller, control, monotonicDeadline } = this.attemptControl(life);
    const validator = new DecisionResultValidator({
      descriptor: provider.descriptor,
      supportedInputVersions: provider.descriptor.supportedInputVersions,
      rulesetVersion: this.#ruleset.version,
    });
    const prepared = validator.prepare(life.context, control);
    if (!prepared.ok) return unavailable(life.context, "INVALID_RESULT");
    if (prepared.value.status === "UNAVAILABLE") return prepared.value;
    const raw = await this.raceProvider(
      life,
      provider,
      control,
      controller,
      monotonicDeadline - performance.now(),
    );
    if (
      control.signal.aborted ||
      performance.now() >= monotonicDeadline ||
      this.now() >= Date.parse(control.deadlineAt)
    ) {
      controller.abort();
      return unavailable(life.context, life.control.signal.aborted ? "ABORTED" : "TIMEOUT");
    }
    const result = validator.validate(
      raw,
      prepared.value,
      life.context,
      provider.descriptor,
      control,
    );
    return result.ok ? result.value : unavailable(life.context, "INVALID_RESULT");
  }
  private attemptControl(life: Lifecycle) {
    const controller = new AbortController();
    const remaining = Math.min(
      this.#timeout,
      life.monotonicDeadline - performance.now(),
      Date.parse(life.control.deadlineAt) - this.now(),
    );
    const control: DecisionControl = Object.freeze({
      timeDomain: "SECURITY_UTC",
      deadlineAt: new Date(this.now() + remaining).toISOString(),
      signal: AbortSignal.any([life.control.signal, life.stop.signal, controller.signal]),
    });
    return { controller, control, monotonicDeadline: performance.now() + remaining };
  }
  private async raceProvider(
    life: Lifecycle,
    provider: DecisionProvider,
    control: DecisionControl,
    controller: AbortController,
    remaining: number,
  ): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => undefined;
    const stopped = new Promise<DecisionResult>((resolve) => {
      onAbort = () =>
        resolve(unavailable(life.context, life.control.signal.aborted ? "ABORTED" : "TIMEOUT"));
      control.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => controller.abort(), Math.max(0, remaining));
      if (control.signal.aborted) onAbort();
    });
    const work = Promise.resolve()
      .then(() => provider.evaluate(life.input, control))
      .catch(() => unavailable(life.context, "PROVIDER_FAILURE"));
    try {
      return await Promise.race([work, stopped]);
    } finally {
      clearTimeout(timer);
      control.signal.removeEventListener("abort", onAbort);
    }
  }
  private async commit(
    request: DecisionCommitRequest,
    life: Lifecycle,
  ): Promise<DecisionPortResult<PrimaryDecisionRun>> {
    const terminal = request.runs.at(-1);
    if (!terminal) return failure("INVALID_INPUT");
    let routed = false;
    let routedRun: PrimaryDecisionRun | undefined;
    const route = async (
      candidate: PrimaryDecisionRun,
    ): Promise<DecisionPortResult<PrimaryDecisionRun>> => {
      if (routed || !sameValue(candidate, terminal)) return failure("CONFLICT");
      routed = true;
      if (!this.active(life) || candidate.result.status !== "EVALUATED")
        return failure("UNAVAILABLE");
      const result = runResultSchema.safeParse(
        await this.options.routing.route({
          context: life.context,
          run: candidate,
          control: life.control,
        }),
      );
      if (!result.success) return failure("INVALID_INPUT");
      if (!result.data.ok) return result.data;
      const original = { ...candidate, effective: null, overrideReason: null };
      const actual = { ...result.data.value, effective: null, overrideReason: null };
      if (!sameValue(original, actual)) return failure("CONFLICT");
      routedRun = result.data.value;
      return this.active(life) ? result.data : failure("UNAVAILABLE");
    };
    const result = runResultSchema.safeParse(await this.options.authority.commit(request, route));
    if (!result.success) return failure("INVALID_INPUT");
    if (!result.data.ok) return result.data;
    if (!this.active(life)) return failure("UNAVAILABLE");
    if (!sameValue(result.data.value, routedRun ?? terminal)) return failure("CONFLICT");
    if (terminal.result.status === "EVALUATED" && !routedRun) return failure("CONFLICT");
    return result.data;
  }
}

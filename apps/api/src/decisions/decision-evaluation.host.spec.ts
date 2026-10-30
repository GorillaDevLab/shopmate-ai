import { expect, it } from "vitest";
import {
  EvaluationContextSchema,
  EventEvidenceV1Schema,
  EventTypeSchema,
  RoutedPrimaryDecisionRunSchema,
  createEventFingerprint,
  type DecisionControl,
  type DecisionPortResult,
  type DecisionProvider,
  type DecisionResult,
  type EvaluationContext,
  type EventEvidenceV1,
  type PrimaryDecisionRun,
} from "@shopmate/contracts";
import {
  CanonicalHostEvidenceHash,
  DefaultDecisionInputSanitizer,
} from "./decision-input-sanitizer.js";
import { DEFAULT_DECISION_RULESET as ruleset } from "./decision-ruleset.js";
import {
  DecisionEvaluationHost,
  DecisionProviderRegistry,
  type DecisionEvaluationAuthority,
  type DecisionCommitRequest,
} from "./decision-evaluation.host.js";
import { DEFAULT_EVENT_RULE_POLICY as eventPolicy } from "../events/event-rule-policy.js";
import { RulesDecisionProvider } from "./rules-decision.provider.js";
import { PureInventoryRefundRuleEvaluator } from "./inventory-refund-rules.js";
import { DefaultDecisionHardGate } from "./decision-hard-gate.js";
import { DecisionRoutingService } from "./decision-routing.service.js";
import { SimulationClock } from "../integrations/mock/business-clock.js";

const instant = "2026-10-25T01:00:00Z";
const binding = {
  organizationId: "org-a",
  workspaceId: "workspace-a",
  storeId: "store-a",
  connectionId: "connection-a",
  externalStoreId: "external-a",
};
const period = {
  periodStart: "2026-10-25T00:00:00Z",
  periodEnd: instant,
  timezone: "Asia/Shanghai",
  currency: "CNY",
};
const labels = { ...ruleset.defaultLabels, severity: "LOW" as const };
function value<T>(result: DecisionPortResult<T>): T {
  if (!result.ok) throw new Error(result.code);
  return result.value;
}
const source = {
  kind: "NORMALIZED_AGGREGATE",
  id: "source-a",
  version: "source-v1",
  hash: "source-hash",
  binding,
  definitionVersion: "metrics-v1",
  period,
  observedAt: instant,
  measure: null,
};
function evidenceFixture(): EventEvidenceV1 {
  return EventEvidenceV1Schema.parse({
    schemaVersion: 1,
    binding,
    ...period,
    observedAt: instant,
    sourceWatermark: instant,
    dataStatus: "VERIFIED",
    sampleSize: 1,
    coverageBasisPoints: 10000,
    issues: [],
    definitionVersion: "metrics-v1",
    baselineVersion: null,
    baselineAlignment: "MISSING",
    baseline: null,
    sourceReferences: [source],
    eventType: "SYNC_FAILURE",
    entity: { kind: "CONNECTION", connectionId: binding.connectionId },
    facts: {
      lastSuccessAt: instant,
      lagSeconds: 0,
      typedErrorCode: "TEMPORARY",
      affectedResourceKind: "INVENTORY",
    },
  });
}
function referenceFixture(evidence: EventEvidenceV1) {
  return {
    schemaVersion: 1,
    id: "evidence-a",
    version: "evidence-v1",
    hash: value(new CanonicalHostEvidenceHash().hash(evidence)),
    binding,
    eventType: evidence.eventType,
    entity: evidence.entity,
    definitionVersion: evidence.definitionVersion,
    baselineVersion: null,
  };
}
function eventFixture(evidence: EventEvidenceV1, reference = referenceFixture(evidence)) {
  return {
    schemaVersion: 1,
    id: "event-a",
    binding,
    eventType: evidence.eventType,
    entity: evidence.entity,
    fingerprint: createEventFingerprint(reference),
    severityFloor: "LOW",
    rulePolicyVersion: "event-policy-v1",
    state: "OPEN",
    revision: 1,
    firstSeenAt: instant,
    lastSeenAt: instant,
    currentEvidence: reference,
  };
}
function contextFixture(): EvaluationContext {
  const evidence = evidenceFixture();
  const reference = referenceFixture(evidence);
  return EvaluationContextSchema.parse({
    schemaVersion: 1,
    requestId: "request-a",
    correlationId: "57a1befc-02cb-4acc-8a1a-6975b2016240",
    actor: {
      userId: "user-a",
      merchantId: "merchant-a",
      organizationId: binding.organizationId,
      workspaceId: binding.workspaceId,
      role: "VIEWER",
      permissions: ["tenant:read"],
    },
    evidence: { reference, evidence },
    event: eventFixture(evidence, reference),
  });
}
function evaluated(correlationId: string): DecisionResult {
  return {
    schemaVersion: 1,
    status: "EVALUATED",
    correlationId,
    rulesetVersion: ruleset.version,
    labels,
    confidenceMetadata: null,
  };
}
function provider(
  key = "rules",
  evaluate: DecisionProvider["evaluate"] = async (input) => evaluated(input.correlationId),
): DecisionProvider {
  return { descriptor: { key, version: `${key}-v1`, supportedInputVersions: [1] }, evaluate };
}
function control(milliseconds = 1000): DecisionControl {
  return {
    timeDomain: "SECURITY_UTC",
    deadlineAt: new Date(Date.parse(instant) + milliseconds).toISOString(),
    signal: new AbortController().signal,
  };
}
type MutableAuthority = {
  -readonly [K in keyof DecisionEvaluationAuthority]: DecisionEvaluationAuthority[K];
};
function memoryAuthority(
  history: PrimaryDecisionRun[],
  commits: DecisionCommitRequest[],
): MutableAuthority {
  return {
    claim: async () => ({ ok: true, value: { status: "CLAIMED", commitToken: "token-a" } }),
    commit: async (request, route) => {
      commits.push(request);
      const terminal = request.runs[request.runs.length - 1];
      if (!terminal) return { ok: false, code: "INVALID_INPUT" };
      const routed =
        terminal.result.status === "EVALUATED"
          ? await route(terminal)
          : { ok: true as const, value: terminal };
      if (!routed.ok) return routed;
      history.push(...request.runs.slice(0, -1), routed.value);
      return routed;
    },
  };
}
function fixture(primary = provider(), fallback = provider()) {
  const history: PrimaryDecisionRun[] = [];
  const commits: DecisionCommitRequest[] = [];
  let routes = 0;
  const authority = memoryAuthority(history, commits);
  const registry = new DecisionProviderRegistry(
    fallback,
    primary.descriptor.key === "rules" ? [] : [{ mode: "PRIMARY", provider: primary }],
  );
  const options = {
    registry,
    authority,
    ruleset,
    primaryKey: primary.descriptor.key,
    attemptTimeoutMs: 100,
    clock: { timeDomain: "SECURITY_UTC" as const, now: () => instant },
    hardGate: {
      evaluate: () => ({ ok: true as const, value: { effective: labels, overrideReason: null } }),
    },
    routing: {
      route: async ({ run }: { run: PrimaryDecisionRun }) => {
        routes += 1;
        return { ok: true as const, value: run };
      },
    },
  };
  return {
    host: new DecisionEvaluationHost(options),
    history,
    commits,
    authority,
    options,
    routes: () => routes,
  };
}

it("defaults to Rules PRIMARY and publishes a gated immutable run once", async () => {
  const test = fixture();
  const result = value(await test.host.evaluate(contextFixture(), control()));
  expect(result.result.status).toBe("EVALUATED");
  expect(result.provider.key).toBe("rules");
  expect(result.fallbackOf).toBeNull();
  expect(result.effective).toEqual(labels);
  expect(test.history).toHaveLength(1);
  expect(test.routes()).toBe(1);
});

it.each(["throw", "invalid", "unsupported", "timeout"] as const)(
  "records %s and a coherently linked Rules fallback",
  async (mode) => {
    const primary = provider("offline-primary", async (input) => {
      if (mode === "throw") throw new Error("untrusted vendor details");
      if (mode === "timeout") return new Promise<DecisionResult>(() => undefined);
      if (mode === "invalid") return { ...evaluated(input.correlationId), raw: "secret" };
      return {
        schemaVersion: 1,
        status: "UNAVAILABLE",
        correlationId: input.correlationId,
        code: "UNSUPPORTED_SCHEMA",
      };
    });
    const test = fixture(primary);
    const result = value(await test.host.evaluate(contextFixture(), control()));
    expect(test.history).toHaveLength(2);
    expect(test.history[0]?.result).toMatchObject({
      status: "UNAVAILABLE",
      code: {
        throw: "PROVIDER_FAILURE",
        invalid: "INVALID_RESULT",
        unsupported: "UNSUPPORTED_SCHEMA",
        timeout: "TIMEOUT",
      }[mode],
    });
    expect(result.provider.key).toBe("rules");
    expect(result.fallbackOf).toBe(test.history[0]?.id);
    expect(result.decisionKey).toBe(test.history[0]?.decisionKey);
    expect(result.overrideReason).toBe("PROVIDER_UNAVAILABLE");
    expect(test.routes()).toBe(1);
    expect(JSON.stringify(test.history)).not.toContain("untrusted vendor details");
  },
);

it("preserves both failed runs and returns unavailable for human review", async () => {
  const fail = async () => {
    throw new Error("offline");
  };
  const test = fixture(provider("offline-primary", fail), provider("rules", fail));
  const result = value(await test.host.evaluate(contextFixture(), control()));
  expect(result.result).toMatchObject({ status: "UNAVAILABLE", code: "PROVIDER_FAILURE" });
  expect(result.effective).toBeNull();
  expect(result.fallbackOf).toBe(test.history[0]?.id);
  expect(test.history).toHaveLength(2);
  expect(test.routes()).toBe(0);
});

it("rejects a SHADOW registration as PRIMARY before invoking it", () => {
  const shadow = provider("offline-shadow");
  const registry = new DecisionProviderRegistry(provider(), [{ mode: "SHADOW", provider: shadow }]);
  expect(registry.primary().descriptor.key).toBe("rules");
  expect(() => registry.primary("offline-shadow")).toThrow("PRIMARY");
});

it("ignores a late primary completion after the committed fallback", async () => {
  let finish: ((result: DecisionResult) => void) | undefined;
  let observed: DecisionControl | undefined;
  const test = fixture(
    provider("offline-primary", async (_input, current) => {
      observed = current;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }),
  );
  const context = contextFixture();
  const result = value(await test.host.evaluate(context, control()));
  expect(observed?.signal.aborted).toBe(true);
  expect(result.provider.key).toBe("rules");
  finish?.(evaluated(context.correlationId));
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(test.history).toHaveLength(2);
  expect(test.commits).toHaveLength(1);
  expect(test.routes()).toBe(1);
});

it("propagates live cancellation without producing a successful fallback", async () => {
  const caller = new AbortController();
  let observed: AbortSignal | undefined;
  const test = fixture(
    provider("offline-primary", async (_input, current) => {
      observed = current.signal;
      caller.abort();
      return new Promise<DecisionResult>(() => undefined);
    }),
  );
  expect(
    await test.host.evaluate(contextFixture(), { ...control(), signal: caller.signal }),
  ).toEqual({ ok: false, code: "UNAVAILABLE" });
  expect(observed?.aborted).toBe(true);
  expect(test.history).toHaveLength(0);
  expect(test.routes()).toBe(0);
});

it("bounds a Rules fallback by its real overall deadline", async () => {
  const forever = provider(
    "offline-primary",
    async () => new Promise<DecisionResult>(() => undefined),
  );
  const test = fixture(forever);
  expect(await test.host.evaluate(contextFixture(), control(5))).toEqual({
    ok: false,
    code: "UNAVAILABLE",
  });
  expect(test.history).toHaveLength(0);
  expect(test.routes()).toBe(0);
});

it("treats a blocking provider finishing after its attempt deadline as timeout", async () => {
  const test = fixture(
    provider("offline-primary", async (input) => {
      const deadline = performance.now() + 130;
      while (performance.now() < deadline) {
        /* Simulate a provider ignoring cooperative cancellation. */
      }
      return evaluated(input.correlationId);
    }),
  );
  const result = value(await test.host.evaluate(contextFixture(), control()));
  expect(test.history[0]?.result).toMatchObject({ status: "UNAVAILABLE", code: "TIMEOUT" });
  expect(result.provider.key).toBe("rules");
});

it("reuses a stable committed key across new requests and correlations", async () => {
  const test = fixture();
  const context = contextFixture();
  const first = value(await test.host.evaluate(context, control()));
  let retryKey = "";
  test.authority.claim = async (request) => {
    retryKey = request.decisionKey;
    return { ok: true, value: { status: "COMMITTED", run: first } };
  };
  const retried = value(
    await test.host.evaluate(
      {
        ...context,
        requestId: "request-retry",
        correlationId: "bd11a751-9686-4892-b31c-d069ed3e2787",
      },
      control(),
    ),
  );
  expect(retryKey).toBe(first.decisionKey);
  expect(retried).toEqual(first);
  expect(test.history).toHaveLength(1);
  expect(test.routes()).toBe(1);
});

it("rejects a commit response that changes immutable winner metadata", async () => {
  const test = fixture();
  const original = test.authority.commit;
  test.authority.commit = async (request, route) => {
    const result = await original(request, route);
    return result.ok
      ? { ok: true, value: { ...result.value, requestId: "forged-request" } }
      : result;
  };
  expect(await test.host.evaluate(contextFixture(), control())).toEqual({
    ok: false,
    code: "CONFLICT",
  });
});

it("rejects malformed or unauthorized inputs before provider execution", async () => {
  const test = fixture();
  const context = contextFixture();
  expect(await test.host.evaluate({ ...context, raw: "vendor" }, control())).toEqual({
    ok: false,
    code: "INVALID_INPUT",
  });
  expect(
    await test.host.evaluate(
      { ...context, actor: { ...context.actor, permissions: [] } },
      control(),
    ),
  ).toEqual({ ok: false, code: "FORBIDDEN" });
  const reference = { ...context.evidence.reference, hash: "forged-hash" };
  expect(
    await test.host.evaluate(
      {
        ...context,
        event: { ...context.event, currentEvidence: reference },
        evidence: { ...context.evidence, reference },
      },
      control(),
    ),
  ).toEqual({ ok: false, code: "HASH_MISMATCH" });
  expect(test.history).toHaveLength(0);
});

it("does not invoke Rules when the registry default Rules provider fails", async () => {
  const test = fixture(
    provider(),
    provider("rules", async () => {
      throw new Error("offline");
    }),
  );
  const result = value(await test.host.evaluate(contextFixture(), control()));
  expect(result.result).toMatchObject({ status: "UNAVAILABLE", code: "PROVIDER_FAILURE" });
  expect(test.history).toHaveLength(1);
  expect(test.routes()).toBe(0);
});

it("passes the overall lease and stable token to one commit, blocking a second route", async () => {
  const test = fixture();
  const current = control();
  let second: DecisionPortResult<PrimaryDecisionRun> | undefined;
  test.authority.commit = async (request, route) => {
    expect(request.control.deadlineAt).toBe(current.deadlineAt);
    expect(request.control.signal).toBe(current.signal);
    expect(request.commitToken).toBe("token-a");
    const terminal = request.runs.at(-1);
    if (!terminal) throw new Error("Missing terminal");
    const first = await route(terminal);
    second = await route(terminal);
    return first;
  };
  expect(value(await test.host.evaluate(contextFixture(), current)).result.status).toBe(
    "EVALUATED",
  );
  expect(second).toEqual({ ok: false, code: "CONFLICT" });
  expect(test.routes()).toBe(1);
});

it("cannot publish a committed terminal without running the host route callback", async () => {
  const test = fixture();
  test.authority.commit = async (request) => {
    const terminal = request.runs.at(-1);
    if (!terminal) throw new Error("Missing terminal");
    return { ok: true, value: terminal };
  };
  expect(await test.host.evaluate(contextFixture(), control())).toEqual({
    ok: false,
    code: "CONFLICT",
  });
  expect(test.routes()).toBe(0);
});

it("returns unavailable when the claim outlives the overall deadline", async () => {
  const test = fixture();
  test.authority.claim = async () => new Promise(() => undefined);
  const result = await Promise.race([
    test.host.evaluate(contextFixture(), control(10)),
    new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 100)),
  ]);
  expect(result).toEqual({ ok: false, code: "UNAVAILABLE" });
  expect(test.routes()).toBe(0);
});

function realRules(context: EvaluationContext) {
  const prepared = JSON.stringify(value(new DefaultDecisionInputSanitizer().sanitize(context)));
  return new RulesDecisionProvider({
    ruleset,
    policy: eventPolicy,
    defaults: EventTypeSchema.options.map((eventType) => ({
      eventType,
      labels: { ...labels, notificationRoute: "NOTIFY_NOW", llmEscalation: "SIMPLE_EXPLANATION" },
    })),
    specialRules: new PureInventoryRefundRuleEvaluator(),
    assurance: {
      verify: (input, pins) =>
        JSON.stringify(input) === prepared &&
        pins.rulesetVersion === ruleset.version &&
        pins.eventPolicyVersion === eventPolicy.version
          ? { ok: true, value: undefined }
          : { ok: false, code: "HASH_MISMATCH" },
    },
    clock: { timeDomain: "SECURITY_UTC", now: () => instant },
  });
}
function realRouting(context: EvaluationContext, current: () => PrimaryDecisionRun) {
  return new DecisionRoutingService(
    {
      load: async () => {
        const activeRun = RoutedPrimaryDecisionRunSchema.parse(current());
        return {
          ok: true,
          value: {
            context,
            activeRun,
            decisionKey: activeRun.decisionKey,
            provider: activeRun.provider,
            rulesetVersion: activeRun.rulesetVersion,
            preferences: { notifications: "DAILY_ONLY", allowDeep: false, quietHours: null },
            budget: { remainingDeepRuns: 0 },
            history: [],
            policy: {
              version: "routing-v1",
              cooldownSeconds: 300,
              breakOnSeverityUpgrade: true,
              breakOnRecovery: true,
              batchWindowSeconds: 60,
              maximumImmediatePerStore: 2,
            },
          },
        };
      },
    },
    { timeDomain: "SECURITY_UTC", now: () => instant },
  );
}

it("composes the actual Rules, strict boundary, hard gate and routing components", async () => {
  const sourceContext = contextFixture();
  const context = EvaluationContextSchema.parse({
    ...sourceContext,
    event: { ...sourceContext.event, severityFloor: "HIGH" },
  });
  const test = fixture();
  const commit = test.authority.commit;
  let terminal: PrimaryDecisionRun | undefined;
  test.authority.commit = async (request, route) => {
    terminal = request.runs.at(-1);
    return commit(request, route);
  };
  const routing = realRouting(context, () => {
    if (!terminal) throw new Error("No staged terminal");
    return terminal;
  });
  const hardGate = new DefaultDecisionHardGate({
    read: () => ({ ok: true, value: { context, ruleset, eventPolicy, budget: "ELIGIBLE" } }),
  });
  const host = new DecisionEvaluationHost({
    ...test.options,
    hardGate,
    routing,
    registry: new DecisionProviderRegistry(realRules(context)),
  });
  const result = value(await host.evaluate(context, control()));
  expect(result.result).toMatchObject({
    status: "EVALUATED",
    confidenceMetadata: null,
    labels: { severity: "LOW", notificationRoute: "NOTIFY_NOW" },
  });
  expect(result.effective).toMatchObject({ severity: "HIGH", notificationRoute: "DAILY_BRIEF" });
  expect(result.overrideReason).toBe("NOTIFICATION_PREFERENCE");
  expect(test.history).toHaveLength(1);
});

it("uses real elapsed time when the independent business clock jumps forward", async () => {
  const business = new SimulationClock(instant);
  const started = performance.now();
  const test = fixture(
    provider("offline-primary", async () => {
      business.advance(86400000 * 365);
      return new Promise<DecisionResult>(() => undefined);
    }),
  );
  const result = value(await test.host.evaluate(contextFixture(), control()));
  expect(performance.now() - started).toBeGreaterThanOrEqual(80);
  expect(business.snapshot().now).toBe("2027-10-25T01:00:00.000Z");
  expect(test.history[0]?.result).toMatchObject({ status: "UNAVAILABLE", code: "TIMEOUT" });
  expect(result.provider.key).toBe("rules");
});

it("keeps claim and routing failures controlled without committing a winner", async () => {
  const test = fixture();
  test.authority.claim = async () => ({ ok: false, code: "FORBIDDEN" });
  expect(await test.host.evaluate(contextFixture(), control())).toEqual({
    ok: false,
    code: "FORBIDDEN",
  });
  test.authority.claim = async () => ({
    ok: true,
    value: { status: "CLAIMED", commitToken: "token-a", raw: true },
  });
  expect(await test.host.evaluate(contextFixture(), control())).toEqual({
    ok: false,
    code: "INVALID_INPUT",
  });
  expect(test.history).toHaveLength(0);
});

it("does not publish history when routing fails closed", async () => {
  const test = fixture();
  const host = new DecisionEvaluationHost({
    ...test.options,
    routing: { route: async () => ({ ok: false, code: "UNAVAILABLE" }) },
  });
  expect(await host.evaluate(contextFixture(), control())).toEqual({
    ok: false,
    code: "UNAVAILABLE",
  });
  expect(test.history).toHaveLength(0);
});

it("rejects stale committed evidence instead of reusing its authority", async () => {
  const test = fixture();
  const first = value(await test.host.evaluate(contextFixture(), control()));
  test.authority.claim = async () => ({
    ok: true,
    value: {
      status: "COMMITTED",
      run: { ...first, evidence: { ...first.evidence, hash: "old-evidence-hash" } },
    },
  });
  expect(await test.host.evaluate(contextFixture(), control())).toEqual({
    ok: false,
    code: "CONFLICT",
  });
  expect(test.routes()).toBe(1);
});

it("rejects an authority that ignores a failed routing callback", async () => {
  const test = fixture();
  test.authority.commit = async (request, route) => {
    const terminal = request.runs.at(-1);
    if (!terminal) throw new Error("Missing terminal");
    await route(terminal);
    return { ok: true, value: terminal };
  };
  const host = new DecisionEvaluationHost({
    ...test.options,
    routing: { route: async () => ({ ok: false, code: "UNAVAILABLE" }) },
  });
  expect(await host.evaluate(contextFixture(), control())).toEqual({ ok: false, code: "CONFLICT" });
});

it("rejects a blocking commit completing after the overall deadline", async () => {
  const test = fixture();
  const original = test.authority.commit;
  test.authority.commit = async (request, route) => {
    const result = await original(request, route);
    const deadline = performance.now() + 80;
    while (performance.now() < deadline) {
      /* Simulate an uncooperative injected authority. */
    }
    return result;
  };
  expect(await test.host.evaluate(contextFixture(), control(60))).toEqual({
    ok: false,
    code: "UNAVAILABLE",
  });
});

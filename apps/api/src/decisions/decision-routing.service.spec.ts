import { expect, expectTypeOf, it } from "vitest";
import {
  EvaluationContextSchema,
  EventEvidenceV1Schema,
  PrimaryDecisionRunSchema,
  RoutedPrimaryDecisionRunSchema,
  type EventEvidenceReference,
  createEventFingerprint,
  type DecisionLabels,
  type DecisionPortResult,
  type PrimaryDecisionRun,
  type RoutingPort,
  type RoutingRequest,
} from "@shopmate/contracts";
import { CanonicalHostEvidenceHash } from "./decision-input-sanitizer.js";
import {
  DecisionRoutingService,
  type DecisionRoutingSnapshot,
  type DecisionRoutingState,
} from "./decision-routing.service.js";

const instant = "2026-10-25T01:00:00Z";
const binding = {
  organizationId: "org-a",
  workspaceId: "ws-a",
  storeId: "store-a",
  connectionId: "conn-a",
  externalStoreId: "external-a",
};
const period = {
  periodStart: "2026-10-25T00:00:00Z",
  periodEnd: instant,
  timezone: "Asia/Shanghai",
  currency: "CNY",
} as const;
const labels: DecisionLabels = {
  severity: "HIGH",
  notificationRoute: "NOTIFY_NOW",
  llmEscalation: "DEEP_REASONING_REQUIRED",
  evidenceSufficiency: "SUFFICIENT",
  attentionPriority: "HIGH_PRIORITY",
  reasonCodes: ["SYNC_FAILURE"],
};
const provider = { key: "rules", version: "v1", supportedInputVersions: [1] } as const;
function value<T>(result: DecisionPortResult<T>): T {
  if (!result.ok) throw new Error(`Unexpected failure: ${result.code}`);
  return result.value;
}
const evidence = EventEvidenceV1Schema.parse({
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
  sourceReferences: [
    {
      kind: "NORMALIZED_AGGREGATE",
      id: "source-a",
      version: "v1",
      hash: "source-hash",
      binding,
      definitionVersion: "metrics-v1",
      period,
      observedAt: instant,
      measure: null,
    },
  ],
  eventType: "SYNC_FAILURE",
  entity: { kind: "CONNECTION", connectionId: binding.connectionId },
  facts: {
    lastSuccessAt: instant,
    lagSeconds: 0,
    typedErrorCode: "TEMPORARY",
    affectedResourceKind: "INVENTORY",
  },
});
function referenceFixture(): EventEvidenceReference {
  return {
    schemaVersion: 1,
    id: "evidence-a",
    version: "v1",
    hash: value(new CanonicalHostEvidenceHash().hash(evidence)),
    binding,
    eventType: evidence.eventType,
    entity: evidence.entity,
    definitionVersion: "metrics-v1",
    baselineVersion: null,
  };
}
const actor = {
  userId: "user-a",
  merchantId: "merchant-a",
  organizationId: "org-a",
  workspaceId: "ws-a",
  role: "VIEWER",
  permissions: ["tenant:read"],
} as const;
function eventFixture(reference: EventEvidenceReference) {
  return {
    schemaVersion: 1,
    id: "event-a",
    binding,
    eventType: evidence.eventType,
    entity: evidence.entity,
    fingerprint: createEventFingerprint(evidence),
    severityFloor: "LOW",
    rulePolicyVersion: "event-v1",
    state: "OPEN",
    revision: 1,
    firstSeenAt: instant,
    lastSeenAt: instant,
    currentEvidence: reference,
  } as const;
}
function contextFixture() {
  const reference = referenceFixture();
  return EvaluationContextSchema.parse({
    schemaVersion: 1,
    requestId: "request-a",
    correlationId: "57a1befc-02cb-4acc-8a1a-6975b2016240",
    actor,
    event: eventFixture(reference),
    evidence: { reference, evidence },
  });
}
function requestFixture(): RoutingRequest {
  const context = contextFixture();
  const run = PrimaryDecisionRunSchema.parse({
    schemaVersion: 1,
    id: "run-a",
    eventId: "event-a",
    decisionKey: "key-a",
    requestId: context.requestId,
    evidence: context.evidence.reference,
    provider,
    rulesetVersion: "rules-v1",
    fallbackOf: null,
    mode: "PRIMARY",
    result: {
      schemaVersion: 1,
      status: "EVALUATED",
      correlationId: context.correlationId,
      rulesetVersion: "rules-v1",
      labels,
      confidenceMetadata: null,
    },
    effective: labels,
    overrideReason: null,
    latencyMs: 0,
    createdAt: instant,
  });
  return {
    context,
    run,
    control: {
      timeDomain: "SECURITY_UTC",
      deadlineAt: "2026-10-25T01:01:00Z",
      signal: new AbortController().signal,
    },
  };
}
function snapshotFixture(request = requestFixture()): DecisionRoutingSnapshot {
  return {
    context: request.context,
    activeRun: RoutedPrimaryDecisionRunSchema.parse(request.run),
    decisionKey: request.run.decisionKey,
    provider,
    rulesetVersion: "rules-v1",
    preferences: { notifications: "ALL", allowDeep: true, quietHours: null },
    budget: { remainingDeepRuns: 1 },
    history: [],
    policy: {
      version: "routing-v1",
      cooldownSeconds: 300,
      breakOnSeverityUpgrade: true,
      breakOnRecovery: true,
      batchWindowSeconds: 60,
      maximumImmediatePerStore: 2,
    },
  };
}
function service(snapshot: DecisionRoutingSnapshot, now = instant) {
  return new DecisionRoutingService(
    { load: async () => ({ ok: true, value: snapshot }) },
    { timeDomain: "SECURITY_UTC", now: () => now },
  );
}
async function routed(snapshot: DecisionRoutingSnapshot, request = requestFixture()) {
  return value(await service(snapshot).route(request));
}
function prior(request = requestFixture()): DecisionRoutingSnapshot["history"][number] {
  return {
    run: {
      ...request.run,
      id: "previous-run",
      effective: labels,
      result: {
        schemaVersion: 1,
        status: "EVALUATED",
        correlationId: request.context.correlationId,
        rulesetVersion: "rules-v1",
        labels,
        confidenceMetadata: null,
      },
    },
    eventRevision: 1,
    eventState: "OPEN",
    policyVersion: "routing-v1",
    routedAt: instant,
  };
}

it("blocks duplicate immediate notification and DEEP inside cooldown", async () => {
  const snapshot = snapshotFixture();
  const output = await routed({ ...snapshot, history: [prior()] });
  expect(output.effective).toMatchObject({
    notificationRoute: "DAILY_BRIEF",
    llmEscalation: "NO_LLM_NEEDED",
    severity: "HIGH",
    attentionPriority: "HIGH_PRIORITY",
  });
  expect(output.overrideReason).toBe("COOLDOWN");
});

it("implements RoutingPort and preserves justified routes, suggestions and source records", async () => {
  expectTypeOf<DecisionRoutingService>().toExtend<RoutingPort>();
  const request = requestFixture();
  const before = JSON.stringify(request.context);
  const result = await routed(snapshotFixture(request), request);
  expect(result).toEqual(request.run);
  expect(result.result).toEqual(request.run.result);
  expect(JSON.stringify(request.context)).toBe(before);
});

it.each(["eventId", "decisionKey", "requestId", "id"] as const)(
  "rejects changed run %s against current server state",
  async (field) => {
    const request = requestFixture();
    const output = await service(snapshotFixture(request)).route({
      ...request,
      run: { ...request.run, [field]: "untrusted" },
    });
    expect(output).toEqual({ ok: false, code: "CONFLICT" });
  },
);

it("rejects forged effective labels that bypass the authoritative hard gate", async () => {
  const request = requestFixture();
  const snapshot = snapshotFixture(request);
  const output = await service(snapshot).route({
    ...request,
    run: {
      ...request.run,
      effective: { ...labels, severity: "INFO" },
      overrideReason: "NOTIFICATION_PREFERENCE",
    },
  });
  expect(output).toEqual({ ok: false, code: "CONFLICT" });
});

it("rejects stale event revision despite identical evidence", async () => {
  const request = requestFixture();
  const snapshot = snapshotFixture(request);
  const current = {
    ...snapshot,
    context: { ...snapshot.context, event: { ...snapshot.context.event, revision: 2 } },
  };
  expect(await service(current).route(request)).toEqual({ ok: false, code: "CONFLICT" });
});

it("requires the same authenticated actor and existing read permission", async () => {
  const request = requestFixture();
  const snapshot = snapshotFixture(request);
  const changed = {
    ...request,
    context: { ...request.context, actor: { ...request.context.actor, userId: "someone-else" } },
  };
  expect(await service(snapshot).route(changed)).toEqual({ ok: false, code: "FORBIDDEN" });
  const noPermission = {
    ...request,
    context: { ...request.context, actor: { ...request.context.actor, permissions: [] } },
  };
  expect(await service(snapshotFixture(noPermission)).route(noPermission)).toEqual({
    ok: false,
    code: "FORBIDDEN",
  });
});

it("checks host evidence bytes rather than trusting a shared forged digest", async () => {
  const request = requestFixture();
  const reference = { ...request.context.evidence.reference, hash: "forged" };
  const context = {
    ...request.context,
    event: { ...request.context.event, currentEvidence: reference },
    evidence: { ...request.context.evidence, reference },
  };
  const forged = { ...request, context, run: { ...request.run, evidence: reference } };
  expect(await service(snapshotFixture(forged)).route(forged)).toEqual({
    ok: false,
    code: "HASH_MISMATCH",
  });
});

it.each(["rulesetVersion", "provider"] as const)("binds current %s", async (field) => {
  const request = requestFixture();
  const snapshot = snapshotFixture(request);
  const changed =
    field === "provider"
      ? { ...snapshot, provider: { ...provider, version: "v2" } }
      : { ...snapshot, rulesetVersion: "rules-v2" };
  expect(await service(changed).route(request)).toEqual({ ok: false, code: "VERSION_MISMATCH" });
});

it("rejects unavailable and shadow runs", async () => {
  const request = requestFixture();
  const unavailable: PrimaryDecisionRun = {
    ...request.run,
    effective: null,
    overrideReason: null,
    result: {
      schemaVersion: 1,
      status: "UNAVAILABLE",
      correlationId: request.context.correlationId,
      code: "TIMEOUT",
    },
  };
  expect(await service(snapshotFixture(request)).route({ ...request, run: unavailable })).toEqual({
    ok: false,
    code: "INVALID_INPUT",
  });
  const shadow = { ...request, run: { ...request.run, mode: "SHADOW", effective: null } };
  const result = await service(snapshotFixture(request)).route(shadow as unknown as RoutingRequest);
  expect(result).toEqual({ ok: false, code: "INVALID_INPUT" });
});

it("rejects a server fixture below the deterministic event floor", async () => {
  const original = requestFixture();
  const request = {
    ...original,
    context: {
      ...original.context,
      event: { ...original.context.event, severityFloor: "CRITICAL" as const },
    },
  };
  expect(await service(snapshotFixture(request)).route(request)).toEqual({
    ok: false,
    code: "INVALID_INPUT",
  });
});

it.each(["2026-10-25T01:01:00Z", "2026-10-25T01:01:01Z"])(
  "refuses expired real UTC deadline at %s",
  async (now) => {
    expect(await service(snapshotFixture(), now).route(requestFixture())).toEqual({
      ok: false,
      code: "UNAVAILABLE",
    });
  },
);

it("refuses a preaborted native signal", async () => {
  const request = requestFixture();
  const controller = new AbortController();
  controller.abort();
  expect(
    await service(snapshotFixture(request)).route({
      ...request,
      control: { ...request.control, signal: controller.signal },
    }),
  ).toEqual({ ok: false, code: "UNAVAILABLE" });
});

it.each(["abort", "deadline"] as const)("rechecks live %s after loading", async (kind) => {
  const request = requestFixture();
  const controller = new AbortController();
  let now = instant;
  const state: DecisionRoutingState = {
    load: async () => {
      if (kind === "abort") controller.abort();
      else now = request.control.deadlineAt;
      return { ok: true, value: snapshotFixture(request) };
    },
  };
  const router = new DecisionRoutingService(state, { timeDomain: "SECURITY_UTC", now: () => now });
  expect(
    await router.route({ ...request, control: { ...request.control, signal: controller.signal } }),
  ).toEqual({ ok: false, code: "UNAVAILABLE" });
});

it("rejects structural fake signals and business clock domains", async () => {
  const request = requestFixture();
  const invalid = { ...request, control: { ...request.control, signal: { aborted: false } } };
  expect(
    await service(snapshotFixture(request)).route(invalid as unknown as RoutingRequest),
  ).toEqual({ ok: false, code: "INVALID_INPUT" });
  const clock = { timeDomain: "BUSINESS", now: () => instant };
  const router = new DecisionRoutingService(
    { load: async () => ({ ok: true, value: snapshotFixture(request) }) },
    clock as unknown as ConstructorParameters<typeof DecisionRoutingService>[1],
  );
  expect(await router.route(request)).toEqual({ ok: false, code: "INVALID_INPUT" });
});

it.each([null, { remainingDeepRuns: 0 }])(
  "unknown/exhausted budget %j disables DEEP",
  async (budget) => {
    const output = await routed({ ...snapshotFixture(), budget });
    expect(output.effective).toMatchObject({
      notificationRoute: "NOTIFY_NOW",
      llmEscalation: "NO_LLM_NEEDED",
    });
    expect(output.overrideReason).toBe("LLM_BUDGET");
  },
);

it("unknown preferences conservatively defer notification and disable DEEP", async () => {
  const output = await routed({ ...snapshotFixture(), preferences: null });
  expect(output.effective).toMatchObject({
    notificationRoute: "DAILY_BRIEF",
    llmEscalation: "NO_LLM_NEEDED",
  });
  expect(output.overrideReason).toBe("NOTIFICATION_PREFERENCE");
});

it.each(["DAILY_ONLY", "NONE"] as const)(
  "applies %s without dropping SYNC_FAILURE",
  async (notifications) => {
    const snapshot = snapshotFixture();
    const output = await routed({
      ...snapshot,
      preferences: { ...snapshot.preferences!, notifications },
    });
    expect(output.effective?.notificationRoute).toBe(
      notifications === "NONE" ? "IGNORE" : "DAILY_BRIEF",
    );
    expect(output.effective?.reasonCodes).toEqual(["SYNC_FAILURE"]);
    expect(output.result).toEqual(requestFixture().run.result);
    expect(output.evidence).toEqual(snapshot.context.evidence.reference);
    expect(output.eventId).toBe("event-a");
    expect(output.overrideReason).toBe("NOTIFICATION_PREFERENCE");
  },
);

it("disabled DEEP preference overrides available budget", async () => {
  const snapshot = snapshotFixture();
  const output = await routed({
    ...snapshot,
    preferences: { ...snapshot.preferences!, allowDeep: false },
  });
  expect(output.effective?.llmEscalation).toBe("NO_LLM_NEEDED");
  expect(output.overrideReason).toBe("NOTIFICATION_PREFERENCE");
});

function quietSnapshot(startMinute: number, endMinute: number, timezone = "Asia/Shanghai") {
  const snapshot = snapshotFixture();
  return {
    ...snapshot,
    preferences: { ...snapshot.preferences!, quietHours: { timezone, startMinute, endMinute } },
  };
}

it.each([
  [540, 600, "DAILY_BRIEF"],
  [480, 540, "NOTIFY_NOW"],
  [1380, 600, "DAILY_BRIEF"],
  [1380, 480, "NOTIFY_NOW"],
  [540, 540, "NOTIFY_NOW"],
] as const)("uses quiet start inclusive/end exclusive for %s-%s", async (start, end, expected) => {
  const output = await routed(quietSnapshot(start, end));
  expect(output.effective?.notificationRoute).toBe(expected);
  expect(output.overrideReason).toBe(expected === "DAILY_BRIEF" ? "QUIET_HOURS" : null);
  expect(output.effective?.llmEscalation).toBe("DEEP_REASONING_REQUIRED");
});

it("evaluates quiet hours at SECURITY_UTC with the configured DST timezone", async () => {
  // 01:00 UTC is 14:00 NZDT on this date; evidence business time is not the routing clock.
  const output = await routed(quietSnapshot(840, 900, "Pacific/Auckland"));
  expect(output.effective?.notificationRoute).toBe("DAILY_BRIEF");
  expect(output.overrideReason).toBe("QUIET_HOURS");
});

it("fails closed on an invalid quiet timezone", async () => {
  expect(await service(quietSnapshot(0, 1, "Not/AZone")).route(requestFixture())).toEqual({
    ok: false,
    code: "INVALID_INPUT",
  });
});

function changedRequest(
  patch: Partial<DecisionLabels>,
  original = requestFixture(),
): RoutingRequest {
  return {
    ...original,
    run: { ...original.run, effective: { ...labels, ...patch }, overrideReason: "SEVERITY_FLOOR" },
  };
}

it("ESCALATE remains an in-app human intent with no provider or outbox dependency", async () => {
  const request = changedRequest({ notificationRoute: "ESCALATE" });
  const snapshot = snapshotFixture(request);
  const output = await routed(
    { ...snapshot, budget: null, preferences: { ...snapshot.preferences!, notifications: "NONE" } },
    request,
  );
  expect(output.effective).toMatchObject({
    notificationRoute: "ESCALATE",
    llmEscalation: "NO_LLM_NEEDED",
    severity: "HIGH",
    attentionPriority: "HIGH_PRIORITY",
  });
  expect(output.overrideReason).toBe("LLM_BUDGET");
  expect(output).not.toHaveProperty("delivery");
});

it("applies a per-store cap across sequential distinct events", async () => {
  const history: DecisionRoutingSnapshot["history"][number][] = [];
  const routes: string[] = [];
  for (let index = 0; index < 3; index++) {
    const original = requestFixture();
    const context = {
      ...original.context,
      event: { ...original.context.event, id: `event-${index}` },
    };
    const request = {
      ...original,
      context,
      run: {
        ...original.run,
        id: `run-${index}`,
        eventId: context.event.id,
        decisionKey: `key-${index}`,
      },
    };
    const snapshot = { ...snapshotFixture(request), history: [...history] };
    const run = value(await service(snapshot).route(request));
    routes.push(run.effective!.notificationRoute);
    history.push({ ...prior(request), run: RoutedPrimaryDecisionRunSchema.parse(run) });
  }
  expect(routes).toEqual(["NOTIFY_NOW", "NOTIFY_NOW", "DAILY_BRIEF"]);
});

it("cap applies after a cooldown break and uses NOTIFICATION_PREFERENCE", async () => {
  const snapshot = snapshotFixture();
  const output = await routed({
    ...snapshot,
    policy: { ...snapshot.policy, maximumImmediatePerStore: 0 },
  });
  expect(output.effective?.notificationRoute).toBe("DAILY_BRIEF");
  expect(output.overrideReason).toBe("NOTIFICATION_PREFERENCE");
});

it("batch lower time boundary is exclusive", async () => {
  const snapshot = snapshotFixture();
  const old = {
    ...prior(),
    run: {
      ...prior().run,
      eventId: "other",
      decisionKey: "other",
      createdAt: "2026-10-25T00:59:00Z",
    },
    routedAt: "2026-10-25T00:59:00Z",
  };
  const output = await routed({
    ...snapshot,
    policy: { ...snapshot.policy, maximumImmediatePerStore: 1 },
    history: [old],
  });
  expect(output.effective?.notificationRoute).toBe("NOTIFY_NOW");
});

it("uses documented single-reason precedence while applying all constraints", async () => {
  const snapshot = quietSnapshot(540, 600);
  const output = await routed({
    ...snapshot,
    history: [prior()],
    budget: null,
    preferences: { ...snapshot.preferences, notifications: "NONE" },
  });
  expect(output.effective).toMatchObject({
    notificationRoute: "IGNORE",
    llmEscalation: "NO_LLM_NEEDED",
  });
  expect(output.overrideReason).toBe("COOLDOWN");
});

function advancedRequest(patch: Partial<DecisionLabels> = {}): RoutingRequest {
  const original = changedRequest(patch);
  return {
    ...original,
    context: { ...original.context, event: { ...original.context.event, revision: 2 } },
  };
}

it("a fresh higher severity can break cooldown under the same versioned policy", async () => {
  const request = advancedRequest({ severity: "CRITICAL" });
  const last = prior();
  const history = [
    {
      ...last,
      run: { ...last.run, evidence: { ...last.run.evidence, hash: "previous-evidence-hash" } },
    },
  ];
  const output = await routed({ ...snapshotFixture(request), history }, request);
  expect(output.effective).toMatchObject({
    severity: "CRITICAL",
    notificationRoute: "NOTIFY_NOW",
    llmEscalation: "DEEP_REASONING_REQUIRED",
  });
  expect(output.overrideReason).toBe("SEVERITY_FLOOR");
});

it.each(["disabled", "policy-version", "same-evidence", "same-revision"] as const)(
  "cannot break upgrade cooldown for %s",
  async (kind) => {
    const original = advancedRequest({ severity: "CRITICAL" });
    const request =
      kind === "same-revision"
        ? {
            ...original,
            context: { ...original.context, event: { ...original.context.event, revision: 1 } },
          }
        : original;
    const snapshot = snapshotFixture(request);
    const last = prior();
    const history = [
      {
        ...last,
        policyVersion: kind === "policy-version" ? "routing-v0" : "routing-v1",
        run: {
          ...last.run,
          evidence: {
            ...last.run.evidence,
            hash: kind === "same-evidence" ? last.run.evidence.hash : "old-hash",
          },
        },
      },
    ];
    const output = await routed(
      {
        ...snapshot,
        history,
        policy: { ...snapshot.policy, breakOnSeverityUpgrade: kind !== "disabled" },
      },
      request,
    );
    expect(output.effective).toMatchObject({
      notificationRoute: "DAILY_BRIEF",
      llmEscalation: "NO_LLM_NEEDED",
    });
    expect(output.overrideReason).toBe("COOLDOWN");
  },
);

it.each(["OPEN", "ACKNOWLEDGED"] as const)(
  "versioned %s recovery breaks cooldown",
  async (eventState) => {
    const original = advancedRequest();
    const request = {
      ...original,
      context: {
        ...original.context,
        event: { ...original.context.event, state: "RESOLVED" as const },
      },
    };
    const output = await routed(
      { ...snapshotFixture(request), history: [{ ...prior(), eventState }] },
      request,
    );
    expect(output.effective?.notificationRoute).toBe("NOTIFY_NOW");
    expect(output.effective?.llmEscalation).toBe("DEEP_REASONING_REQUIRED");
  },
);

it("a version change cannot silently grant a recovery cooldown break", async () => {
  const original = advancedRequest();
  const request = {
    ...original,
    context: {
      ...original.context,
      event: { ...original.context.event, state: "RESOLVED" as const },
    },
  };
  const snapshot = snapshotFixture(request);
  const output = await routed(
    { ...snapshot, history: [prior()], policy: { ...snapshot.policy, version: "routing-v2" } },
    request,
  );
  expect(output.overrideReason).toBe("COOLDOWN");
});

it("at the exact cooldown expiry the route is available again", async () => {
  const snapshot = snapshotFixture();
  const request = requestFixture();
  const control = { ...request.control, deadlineAt: "2026-10-25T01:06:00Z" };
  const output = value(
    await service({ ...snapshot, history: [prior()] }, "2026-10-25T01:05:00Z").route({
      ...request,
      control,
    }),
  );
  expect(output.effective?.notificationRoute).toBe("NOTIFY_NOW");
  expect(output.effective?.llmEscalation).toBe("DEEP_REASONING_REQUIRED");
});

it("changed evidence alone does not bypass unchanged severity cooldown", async () => {
  const request = advancedRequest();
  const last = prior();
  const history = [
    { ...last, run: { ...last.run, evidence: { ...last.run.evidence, hash: "old-hash" } } },
  ];
  const output = await routed({ ...snapshotFixture(request), history }, request);
  expect(output.overrideReason).toBe("COOLDOWN");
});

it("a cooldown break does not bypass quiet hours or store cap", async () => {
  const request = advancedRequest({ severity: "CRITICAL" });
  const snapshot = snapshotFixture(request);
  const last = prior();
  const history = [
    { ...last, run: { ...last.run, evidence: { ...last.run.evidence, hash: "old-hash" } } },
  ];
  const output = await routed(
    {
      ...snapshot,
      history,
      preferences: quietSnapshot(540, 600).preferences,
      policy: { ...snapshot.policy, maximumImmediatePerStore: 0 },
    },
    request,
  );
  expect(output.effective?.notificationRoute).toBe("DAILY_BRIEF");
  expect(output.overrideReason).toBe("NOTIFICATION_PREFERENCE");
});

it.each(["SECURITY_POLICY", "INSUFFICIENT_EVIDENCE"] as const)(
  "preserves upstream %s reason while enforcing budget",
  async (overrideReason) => {
    const original = requestFixture();
    const request = { ...original, run: { ...original.run, overrideReason } };
    const output = await routed({ ...snapshotFixture(request), budget: null }, request);
    expect(output.effective?.llmEscalation).toBe("NO_LLM_NEEDED");
    expect(output.overrideReason).toBe(overrideReason);
  },
);

it.each(["storeId", "workspaceId", "organizationId", "connectionId", "externalStoreId"] as const)(
  "rejects history outside exact %s binding",
  async (field) => {
    const snapshot = snapshotFixture();
    const last = prior();
    const binding = { ...last.run.evidence.binding, [field]: "unrelated" };
    const entity = { kind: "CONNECTION" as const, connectionId: binding.connectionId };
    const history = [
      { ...last, run: { ...last.run, evidence: { ...last.run.evidence, binding, entity } } },
    ];
    expect(await service({ ...snapshot, history }).route(requestFixture())).toEqual({
      ok: false,
      code: "INVALID_INPUT",
    });
  },
);

it("rejects duplicate or future history instead of bypassing the cap", async () => {
  const snapshot = snapshotFixture();
  expect(
    await service({ ...snapshot, history: [prior(), prior()] }).route(requestFixture()),
  ).toEqual({ ok: false, code: "INVALID_INPUT" });
  const history = [{ ...prior(), routedAt: "2026-10-25T01:00:01Z" }];
  expect(await service({ ...snapshot, history }).route(requestFixture())).toEqual({
    ok: false,
    code: "INVALID_INPUT",
  });
});

it("maps state outages to UNAVAILABLE and preserves a valid denied result", async () => {
  const request = requestFixture();
  const state: DecisionRoutingState = {
    load: async () => {
      throw new Error("state unavailable");
    },
  };
  const clock = { timeDomain: "SECURITY_UTC" as const, now: () => instant };
  expect(await new DecisionRoutingService(state, clock).route(request)).toEqual({
    ok: false,
    code: "UNAVAILABLE",
  });
  const denied: DecisionRoutingState = { load: async () => ({ ok: false, code: "FORBIDDEN" }) };
  expect(await new DecisionRoutingService(denied, clock).route(request)).toEqual({
    ok: false,
    code: "FORBIDDEN",
  });
});

it("rejects undeclared error fields from a malformed server state result", async () => {
  const state = {
    load: async () => ({ ok: false, code: "FORBIDDEN", unexpected: "must-not-escape" }),
  };
  const router = new DecisionRoutingService(state as unknown as DecisionRoutingState, {
    timeDomain: "SECURITY_UTC",
    now: () => instant,
  });
  expect(await router.route(requestFixture())).toEqual({ ok: false, code: "INVALID_INPUT" });
});

it("refuses future run creation time even when authoritative snapshot matches", async () => {
  const original = requestFixture();
  const request = { ...original, run: { ...original.run, createdAt: "2026-10-25T01:00:01Z" } };
  expect(await service(snapshotFixture(request)).route(request)).toEqual({
    ok: false,
    code: "INVALID_INPUT",
  });
});

type RouteHistory = DecisionRoutingSnapshot["history"];
function tiedPrior(
  revision: number,
  severity: DecisionLabels["severity"],
  eventState: RouteHistory[number]["eventState"] = "OPEN",
  eventId = "event-a",
): RouteHistory[number] {
  const previous = prior();
  const effective = { ...labels, severity };
  return {
    ...previous,
    eventRevision: revision,
    eventState,
    run: {
      ...previous.run,
      id: `historical-${revision}-${severity}-${eventState}-${eventId}`,
      eventId,
      effective,
      result: { ...previous.run.result, labels: effective },
      evidence: { ...previous.run.evidence, hash: `historical-${revision}-${severity}` },
    },
  };
}

function thirdRevision(state: "OPEN" | "RESOLVED" = "OPEN"): RoutingRequest {
  const original = advancedRequest();
  return {
    ...original,
    context: { ...original.context, event: { ...original.context.event, revision: 3, state } },
  };
}

async function routeTiedHistory(request: RoutingRequest, history: RouteHistory) {
  const snapshot = snapshotFixture(request);
  return routed(
    { ...snapshot, history, policy: { ...snapshot.policy, maximumImmediatePerStore: 10 } },
    request,
  );
}

it.each([false, true])(
  "equal-time prior upgrade suppresses unchanged HIGH in reverse=%s",
  async (reverse) => {
    const history = [tiedPrior(1, "LOW"), tiedPrior(2, "HIGH")];
    const output = await routeTiedHistory(thirdRevision(), reverse ? history.reverse() : history);
    expect(output.effective).toMatchObject({
      notificationRoute: "DAILY_BRIEF",
      llmEscalation: "NO_LLM_NEEDED",
      severity: "HIGH",
    });
    expect(output.overrideReason).toBe("COOLDOWN");
  },
);

it.each([false, true])("equal-time prior recovery cannot replay in reverse=%s", async (reverse) => {
  const history = [tiedPrior(1, "HIGH", "OPEN"), tiedPrior(2, "HIGH", "RESOLVED")];
  const output = await routeTiedHistory(
    thirdRevision("RESOLVED"),
    reverse ? history.reverse() : history,
  );
  expect(output.effective).toMatchObject({
    notificationRoute: "DAILY_BRIEF",
    llmEscalation: "NO_LLM_NEEDED",
  });
  expect(output.overrideReason).toBe("COOLDOWN");
});

it.each([false, true])(
  "equal-revision severity ambiguity stays conservative in reverse=%s",
  async (reverse) => {
    const history = [tiedPrior(2, "LOW"), tiedPrior(2, "HIGH")];
    const output = await routeTiedHistory(thirdRevision(), reverse ? history.reverse() : history);
    expect(output.effective).toMatchObject({
      notificationRoute: "DAILY_BRIEF",
      llmEscalation: "NO_LLM_NEEDED",
    });
    expect(output.overrideReason).toBe("COOLDOWN");
  },
);

it.each([false, true])(
  "equal-revision recovery ambiguity stays conservative in reverse=%s",
  async (reverse) => {
    const history = [tiedPrior(2, "HIGH", "OPEN"), tiedPrior(2, "HIGH", "RESOLVED")];
    const output = await routeTiedHistory(
      thirdRevision("RESOLVED"),
      reverse ? history.reverse() : history,
    );
    expect(output.effective).toMatchObject({
      notificationRoute: "DAILY_BRIEF",
      llmEscalation: "NO_LLM_NEEDED",
    });
    expect(output.overrideReason).toBe("COOLDOWN");
  },
);

it.each([false, true])(
  "newer same-event revision still permits a real upgrade in reverse=%s",
  async (reverse) => {
    const history = [tiedPrior(1, "CRITICAL"), tiedPrior(2, "LOW")];
    const output = await routeTiedHistory(thirdRevision(), reverse ? history.reverse() : history);
    expect(output.effective).toMatchObject({
      notificationRoute: "NOTIFY_NOW",
      llmEscalation: "DEEP_REASONING_REQUIRED",
    });
    expect(output.overrideReason).toBe("SEVERITY_FLOOR");
  },
);

it.each([false, true])(
  "newer same-event OPEN still permits recovery in reverse=%s",
  async (reverse) => {
    const history = [tiedPrior(1, "HIGH", "RESOLVED"), tiedPrior(2, "HIGH", "OPEN")];
    const output = await routeTiedHistory(
      thirdRevision("RESOLVED"),
      reverse ? history.reverse() : history,
    );
    expect(output.effective).toMatchObject({
      notificationRoute: "NOTIFY_NOW",
      llmEscalation: "DEEP_REASONING_REQUIRED",
    });
    expect(output.overrideReason).toBe("SEVERITY_FLOOR");
  },
);

it.each([false, true])(
  "revisions from different events cannot order key ties in reverse=%s",
  async (reverse) => {
    const history = [tiedPrior(2, "LOW"), tiedPrior(1, "HIGH", "OPEN", "other-event")];
    const output = await routeTiedHistory(thirdRevision(), reverse ? history.reverse() : history);
    expect(output.effective).toMatchObject({
      notificationRoute: "DAILY_BRIEF",
      llmEscalation: "NO_LLM_NEEDED",
    });
    expect(output.overrideReason).toBe("COOLDOWN");
  },
);

it.each([false, true])(
  "another event cannot prove an upgrade revision in reverse=%s",
  async (reverse) => {
    const history = [tiedPrior(2, "LOW"), tiedPrior(1, "LOW", "OPEN", "other-event")];
    const output = await routeTiedHistory(thirdRevision(), reverse ? history.reverse() : history);
    expect(output.effective).toMatchObject({
      notificationRoute: "DAILY_BRIEF",
      llmEscalation: "NO_LLM_NEEDED",
    });
    expect(output.overrideReason).toBe("COOLDOWN");
  },
);

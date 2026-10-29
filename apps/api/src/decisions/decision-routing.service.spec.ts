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

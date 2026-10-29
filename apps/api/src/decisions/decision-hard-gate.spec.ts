import { expect, expectTypeOf, it } from "vitest";
import {
  DecisionResultSchema,
  EvaluationContextSchema,
  EventEvidenceV1Schema,
  createEventFingerprint,
  type DecisionHardGate,
  type DecisionHardGateRequest,
  type DecisionLabels,
  type DecisionPortResult,
  type EvaluationContext,
  type EventEvidenceV1,
} from "@shopmate/contracts";
import { DEFAULT_DECISION_RULESET as ruleset } from "./decision-ruleset.js";
import { DEFAULT_EVENT_RULE_POLICY as eventPolicy } from "../events/event-rule-policy.js";
import { CanonicalHostEvidenceHash } from "./decision-input-sanitizer.js";
import {
  DefaultDecisionHardGate,
  type CurrentDecisionHardGatePolicy,
} from "./decision-hard-gate.js";

const instant = "2026-10-25T01:00:00Z";
const period = {
  periodStart: "2026-10-25T00:00:00Z",
  periodEnd: instant,
  timezone: "Asia/Shanghai",
  currency: "CNY",
} as const;
const binding = {
  organizationId: "org-a",
  workspaceId: "workspace-a",
  storeId: "store-a",
  connectionId: "connection-a",
  externalStoreId: "external-a",
};
const actor = {
  userId: "user-a",
  merchantId: "merchant-a",
  organizationId: "org-a",
  workspaceId: "workspace-a",
  role: "VIEWER",
  permissions: ["tenant:read"],
} as const;
const hasher = new CanonicalHostEvidenceHash();
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
} as const;
const facts = {
  availableUnits: 100,
  salesUnits: 100,
  salesWindow: period,
  salesWindowHours: 1,
  estimatedHoursRemaining: 1,
  supplierLeadTimeHours: 8,
  safetyBufferHours: null,
  inboundETA: null,
  inventoryObservedAt: instant,
  inventoryAgeSeconds: 0,
  inventoryStatus: "VERIFIED",
} as const;

function value<T>(result: DecisionPortResult<T>): T {
  if (!result.ok) throw new Error(result.code);
  return result.value;
}
function evidenceFixture(patch: object = {}): EventEvidenceV1 {
  return EventEvidenceV1Schema.parse({
    schemaVersion: 1,
    binding,
    ...period,
    observedAt: instant,
    sourceWatermark: instant,
    dataStatus: "VERIFIED",
    sampleSize: 100,
    coverageBasisPoints: 10000,
    issues: [],
    definitionVersion: "metrics-v1",
    baselineVersion: null,
    baselineAlignment: "MISSING",
    baseline: null,
    sourceReferences: [source],
    eventType: "STOCKOUT_RISK",
    entity: { kind: "SKU", externalSkuId: "sku-a" },
    facts,
    ...patch,
  });
}
function contextFixture(evidence = evidenceFixture(), floor: DecisionLabels["severity"] = "HIGH") {
  const reference = {
    schemaVersion: 1,
    id: "evidence-a",
    version: "evidence-v1",
    hash: value(hasher.hash(evidence)),
    binding: evidence.binding,
    eventType: evidence.eventType,
    entity: evidence.entity,
    definitionVersion: evidence.definitionVersion,
    baselineVersion: evidence.baselineVersion,
  };
  return EvaluationContextSchema.parse({
    schemaVersion: 1,
    actor,
    requestId: "request-a",
    correlationId: "57a1befc-02cb-4acc-8a1a-6975b2016240",
    evidence: { reference, evidence },
    event: {
      schemaVersion: 1,
      id: "event-a",
      binding: evidence.binding,
      eventType: evidence.eventType,
      entity: evidence.entity,
      fingerprint: createEventFingerprint(evidence),
      severityFloor: floor,
      rulePolicyVersion: eventPolicy.version,
      state: "OPEN",
      revision: 1,
      firstSeenAt: instant,
      lastSeenAt: instant,
      currentEvidence: reference,
    },
  });
}
function requestFixture(
  context = contextFixture(),
  patch: Partial<DecisionLabels> = {},
): DecisionHardGateRequest {
  return {
    context,
    ruleset,
    suggestion: DecisionResultSchema.parse({
      schemaVersion: 1,
      status: "EVALUATED",
      correlationId: context.correlationId,
      rulesetVersion: ruleset.version,
      confidenceMetadata: null,
      labels: {
        severity: "LOW",
        notificationRoute: "IGNORE",
        attentionPriority: "LOW_PRIORITY",
        llmEscalation: "DEEP_REASONING_REQUIRED",
        evidenceSufficiency: "SUFFICIENT",
        reasonCodes: ["NO_MATERIAL_CHANGE"],
        ...patch,
      },
    }),
  };
}
function policy(context: EvaluationContext): CurrentDecisionHardGatePolicy {
  return { context, ruleset, eventPolicy, budget: "ELIGIBLE" };
}
function gate(context: EvaluationContext, patch: Partial<CurrentDecisionHardGatePolicy> = {}) {
  return new DefaultDecisionHardGate({
    read: () => ({ ok: true, value: { ...policy(context), ...patch } }),
  });
}

it("implements the actual hard gate port and preserves deterministic HIGH/CRITICAL floors", () => {
  expectTypeOf<DefaultDecisionHardGate>().toExtend<DecisionHardGate>();
  for (const severity of ["HIGH", "CRITICAL"] as const) {
    const context = contextFixture(evidenceFixture(), severity);
    expect(value(gate(context).evaluate(requestFixture(context)))).toMatchObject({
      effective: { severity },
      overrideReason: "SEVERITY_FLOOR",
    });
  }
});

it("preserves valid labels at or above the floor without adding authority", () => {
  const context = contextFixture();
  const request = requestFixture(context, { severity: "CRITICAL" });
  const result = value(gate(context).evaluate(request));
  expect(result.overrideReason).toBeNull();
  expect(Object.keys(result.effective).sort()).toEqual([
    "attentionPriority",
    "evidenceSufficiency",
    "llmEscalation",
    "notificationRoute",
    "reasonCodes",
    "severity",
  ]);
  expect(context.actor.permissions).not.toContain("actions:approve");
});

it.each([
  null,
  {},
  { context: null },
  { ...requestFixture(), approve: true },
  { ...requestFixture(), suggestion: { ...requestFixture().suggestion, priceRiskExempt: true } },
])("rejects malformed or authority-extending input %j", (request) => {
  expect(gate(contextFixture()).evaluate(request)).toEqual({ ok: false, code: "INVALID_INPUT" });
});

it("rejects unavailable and mismatched result correlation/version", () => {
  const context = contextFixture();
  const request = requestFixture(context);
  const suggestions = [
    {
      schemaVersion: 1,
      status: "UNAVAILABLE",
      correlationId: context.correlationId,
      code: "TIMEOUT",
    },
    { ...request.suggestion, correlationId: "199b61fd-4d67-4189-bc45-294ef59beeba" },
    { ...request.suggestion, rulesetVersion: "other-rules" },
  ];
  for (const suggestion of suggestions)
    expect(gate(context).evaluate({ ...request, suggestion }).ok).toBe(false);
});

it("rechecks current authorization on each invocation and fails closed if revoked or unavailable", () => {
  const context = contextFixture();
  let current: DecisionPortResult<CurrentDecisionHardGatePolicy> = {
    ok: true,
    value: policy(context),
  };
  let calls = 0;
  const subject = new DefaultDecisionHardGate({
    read: () => {
      calls++;
      return current;
    },
  });
  expect(subject.evaluate(requestFixture(context)).ok).toBe(true);
  current = { ok: false, code: "FORBIDDEN" };
  expect(subject.evaluate(requestFixture(context))).toEqual(current);
  expect(calls).toBe(2);
  const broken = new DefaultDecisionHardGate({
    read: () => {
      throw new Error("offline");
    },
  });
  expect(broken.evaluate(requestFixture(context))).toEqual({ ok: false, code: "UNAVAILABLE" });
});

it("rejects current ownership, principal, permission, revision and request replay mismatches", () => {
  const context = contextFixture();
  const candidates = [
    [{ ...context, actor: { ...actor, userId: "other-user" } }, "FORBIDDEN"],
    [{ ...context, actor: { ...actor, permissions: [] } }, "FORBIDDEN"],
    [{ ...context, event: { ...context.event, revision: 2 } }, "CONFLICT"],
    [{ ...context, requestId: "request-b" }, "CONFLICT"],
  ] as const;
  for (const [current, code] of candidates)
    expect(gate(EvaluationContextSchema.parse(current)).evaluate(requestFixture(context))).toEqual({
      ok: false,
      code,
    });
  const scoped = { ...binding, storeId: "store-b" };
  const other = contextFixture(
    evidenceFixture({ binding: scoped, sourceReferences: [{ ...source, binding: scoped }] }),
  );
  expect(gate(other).evaluate(requestFixture(context))).toEqual({
    ok: false,
    code: "SCOPE_MISMATCH",
  });
});

it("binds immutable reference versions, evidence facts, and server-selected policy versions", () => {
  const context = contextFixture();
  const reference = { ...context.evidence.reference, hash: "forged" };
  const forged = {
    ...context,
    evidence: { ...context.evidence, reference },
    event: { ...context.event, currentEvidence: reference },
  };
  expect(gate(context).evaluate(requestFixture(EvaluationContextSchema.parse(forged)))).toEqual({
    ok: false,
    code: "HASH_MISMATCH",
  });
  const other = contextFixture(evidenceFixture({ facts: { ...facts, availableUnits: 101 } }));
  expect(gate(other).evaluate(requestFixture(context)).ok).toBe(false);
  const changedRules = { ...ruleset, inventory: { ...ruleset.inventory, minimumSampleSize: 0 } };
  expect(gate(context).evaluate({ ...requestFixture(context), ruleset: changedRules })).toEqual({
    ok: false,
    code: "VERSION_MISMATCH",
  });
  expect(
    gate(context, { eventPolicy: { ...eventPolicy, version: "different" } }).evaluate(
      requestFixture(context),
    ),
  ).toEqual({ ok: false, code: "VERSION_MISMATCH" });
});

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

function issue(code: string, field = "sales") {
  return { code, field, evidenceIds: [source.id] };
}
const qualityCases = [
  [{ sampleSize: 0 }, "INSUFFICIENT_SAMPLE", "INSUFFICIENT_DATA"],
  [
    { dataStatus: "INSUFFICIENT", issues: [issue("LOW_SAMPLE")] },
    "INSUFFICIENT_SAMPLE",
    "INSUFFICIENT_DATA",
  ],
  [{ dataStatus: "STALE", issues: [issue("STALE_SOURCE")] }, "STALE_DATA", "INSUFFICIENT_DATA"],
  [
    { dataStatus: "INSUFFICIENT", issues: [issue("SOURCE_INCONSISTENT")] },
    "CONFLICTING_DATA",
    "AMBIGUOUS",
  ],
  [
    { dataStatus: "INSUFFICIENT", issues: [issue("WINDOW_MISMATCH")] },
    "CONFLICTING_DATA",
    "AMBIGUOUS",
  ],
  [
    { dataStatus: "INSUFFICIENT", issues: [issue("VERSION_MISMATCH")] },
    "CONFLICTING_DATA",
    "AMBIGUOUS",
  ],
  [
    { dataStatus: "ESTIMATED", coverageBasisPoints: 8000, issues: [issue("PARTIAL_COVERAGE")] },
    "PARTIAL_COVERAGE",
    "INSUFFICIENT_DATA",
  ],
  [
    { dataStatus: "UNAVAILABLE", sourceWatermark: null, issues: [issue("NOT_SYNCHRONIZED")] },
    "MISSING_DATA",
    "INSUFFICIENT_DATA",
  ],
] as const;
it.each(qualityCases)(
  "blocks unsupported DEEP for host evidence limitations %#",
  (patch, reason, sufficiency) => {
    const context = contextFixture(evidenceFixture(patch));
    const result = value(gate(context).evaluate(requestFixture(context)));
    expect(result).toMatchObject({
      effective: {
        severity: "HIGH",
        llmEscalation: "NO_LLM_NEEDED",
        evidenceSufficiency: sufficiency,
      },
      overrideReason: "INSUFFICIENT_EVIDENCE",
    });
    expect(result.effective.reasonCodes).toContain(reason);
  },
);

it("measures source freshness against observedAt at the exact millisecond boundary", () => {
  for (const [observedAt, expected] of [
    ["2026-10-25T02:00:00Z", "DEEP_REASONING_REQUIRED"],
    ["2026-10-25T02:00:00.001Z", "NO_LLM_NEEDED"],
  ] as const) {
    const context = contextFixture(
      evidenceFixture({
        observedAt,
        facts: { ...facts, inventoryObservedAt: observedAt, inventoryAgeSeconds: 0 },
      }),
    );
    const result = value(gate(context).evaluate(requestFixture(context, { severity: "HIGH" })));
    expect(result.effective.llmEscalation).toBe(expected);
  }
});

it.each(["BLOCKED", "UNKNOWN"] as const)("blocks DEEP when current host budget is %s", (budget) => {
  const context = contextFixture();
  expect(value(gate(context, { budget }).evaluate(requestFixture(context)))).toMatchObject({
    effective: { severity: "HIGH", llmEscalation: "NO_LLM_NEEDED" },
    overrideReason: "LLM_BUDGET",
  });
});

it("applies insufficiency before budget before severity floor while enforcing all constraints", () => {
  const context = contextFixture(evidenceFixture({ sampleSize: 0 }), "CRITICAL");
  const result = value(gate(context, { budget: "BLOCKED" }).evaluate(requestFixture(context)));
  expect(result).toMatchObject({
    effective: { severity: "CRITICAL", llmEscalation: "NO_LLM_NEEDED" },
    overrideReason: "INSUFFICIENT_EVIDENCE",
  });
});

it.each(["INSUFFICIENT_DATA", "AMBIGUOUS"] as const)(
  "blocks model DEEP with declared %s even if host quality passes",
  (evidenceSufficiency) => {
    const context = contextFixture();
    expect(
      value(gate(context).evaluate(requestFixture(context, { evidenceSufficiency }))),
    ).toMatchObject({
      effective: { evidenceSufficiency, llmEscalation: "NO_LLM_NEEDED" },
      overrideReason: "INSUFFICIENT_EVIDENCE",
    });
  },
);

it("preserves independently reliable fresh sold-out inventory when forecast sales quality is low", () => {
  const context = contextFixture(
    evidenceFixture({
      sampleSize: 0,
      dataStatus: "INSUFFICIENT",
      issues: [issue("LOW_SAMPLE")],
      facts: { ...facts, availableUnits: 0, salesUnits: null, estimatedHoursRemaining: null },
    }),
    "LOW",
  );
  const result = value(gate(context).evaluate(requestFixture(context)));
  expect(result).toMatchObject({
    effective: {
      severity: "CRITICAL",
      notificationRoute: "NOTIFY_NOW",
      attentionPriority: "URGENT",
      llmEscalation: "NO_LLM_NEEDED",
    },
    overrideReason: "INSUFFICIENT_EVIDENCE",
  });
  expect(result.effective.reasonCodes).toContain("CONFIRMED_STOCKOUT");
});

it("does not manufacture a sold-out fact from missing, stale or conflicting inventory", () => {
  const candidates = [
    { facts: { ...facts, availableUnits: null, inventoryStatus: "UNAVAILABLE" } },
    { facts: { ...facts, availableUnits: 0, inventoryStatus: "STALE" } },
    {
      dataStatus: "INSUFFICIENT",
      issues: [issue("SOURCE_INCONSISTENT")],
      facts: { ...facts, availableUnits: 0 },
    },
  ];
  for (const patch of candidates) {
    const context = contextFixture(evidenceFixture(patch), "LOW");
    const result = value(gate(context).evaluate(requestFixture(context)));
    expect(result.effective.llmEscalation).toBe("NO_LLM_NEEDED");
    expect(result.effective.reasonCodes).not.toContain("CONFIRMED_STOCKOUT");
  }
});

const baselinePeriod = {
  ...period,
  periodStart: "2026-10-18T00:00:00Z",
  periodEnd: "2026-10-18T01:00:00Z",
};
function baselineFixture(patch: object = {}) {
  const measure = { kind: "REFUND_COHORT_ORDER_RATE", unit: "basisPoints" };
  return {
    status: "AVAILABLE",
    alignment: "ALIGNED",
    measure,
    aggregation: "EXACT_MEDIAN",
    version: eventPolicy.baselineVersion,
    period: baselinePeriod,
    median: 1000,
    mad: 0,
    sampleSize: 4,
    coverageBasisPoints: 10000,
    sourceReferences: [
      { ...source, period: baselinePeriod, observedAt: baselinePeriod.periodEnd, measure },
    ],
    ...patch,
  };
}
function rate(numerator: number, denominator: number) {
  return { numerator, denominator, valueBasisPoints: (numerator / denominator) * 10000, period };
}
function refundEvidence(baseline: object | null = baselineFixture()): EventEvidenceV1 {
  const observedAt = "2026-10-27T01:00:00Z";
  return evidenceFixture({
    eventType: "REFUND_SPIKE",
    entity: { kind: "STORE" },
    observedAt,
    sourceWatermark: observedAt,
    baselineVersion: baseline === null ? null : eventPolicy.baselineVersion,
    baselineAlignment: baseline === null ? "MISSING" : "ALIGNED",
    baseline,
    facts: {
      paymentCohort: period,
      observedThrough: observedAt,
      maturityHours: 48,
      paidCohortOrders: 100,
      refundedOrders: 20,
      currentRate: rate(20, 100),
      baselineRate: null,
      affectedSkuShare: rate(0, 20),
      reasonCounts: [],
      skuConcentration: [],
    },
  });
}
it("allows supported DEEP only with sufficient pinned baseline, fresh evidence and eligible budget", () => {
  const context = contextFixture(refundEvidence());
  expect(
    value(gate(context).evaluate(requestFixture(context, { severity: "HIGH" }))),
  ).toMatchObject({
    effective: { llmEscalation: "DEEP_REASONING_REQUIRED" },
    overrideReason: null,
  });
});
it.each([
  null,
  baselineFixture({ sampleSize: 3 }),
  baselineFixture({ coverageBasisPoints: 8000 }),
  baselineFixture({ status: "STALE", median: null, mad: null }),
])(
  "blocks comparative DEEP for missing, insufficient, partial or stale baseline %#",
  (baseline) => {
    const context = contextFixture(refundEvidence(baseline));
    expect(value(gate(context).evaluate(requestFixture(context)))).toMatchObject({
      effective: {
        severity: "HIGH",
        llmEscalation: "NO_LLM_NEEDED",
        evidenceSufficiency: "INSUFFICIENT_DATA",
      },
      overrideReason: "INSUFFICIENT_EVIDENCE",
    });
  },
);
it("does not accept a baseline with a different metric as refund evidence", () => {
  const measure = { kind: "PAID_REVENUE", unit: "minorCNY" };
  const baseline = baselineFixture({
    measure,
    sourceReferences: [
      { ...source, period: baselinePeriod, observedAt: baselinePeriod.periodEnd, measure },
    ],
  });
  const context = contextFixture(refundEvidence(baseline));
  const result = value(gate(context).evaluate(requestFixture(context)));
  expect(result.effective).toMatchObject({
    llmEscalation: "NO_LLM_NEEDED",
    evidenceSufficiency: "AMBIGUOUS",
  });
  expect(result.effective.reasonCodes).toContain("CONFLICTING_DATA");
});

it.each([
  "INSUFFICIENT_SAMPLE",
  "MISSING_DATA",
  "STALE_DATA",
  "CONFLICTING_DATA",
  "PARTIAL_COVERAGE",
] as const)("blocks contradictory provider DEEP carrying the %s limitation", (reason) => {
  const context = contextFixture();
  const result = value(gate(context).evaluate(requestFixture(context, { reasonCodes: [reason] })));
  expect(result).toMatchObject({
    effective: { llmEscalation: "NO_LLM_NEEDED" },
    overrideReason: "INSUFFICIENT_EVIDENCE",
  });
});

it("rejects changed immutable reference identities even with unchanged evidence content", () => {
  const context = contextFixture();
  for (const key of ["id", "version"] as const) {
    const reference = { ...context.evidence.reference, [key]: "replacement" };
    const current = EvaluationContextSchema.parse({
      ...context,
      evidence: { ...context.evidence, reference },
      event: { ...context.event, currentEvidence: reference },
    });
    expect(gate(current).evaluate(requestFixture(context))).toEqual({
      ok: false,
      code: "CONFLICT",
    });
  }
});

it("captures detached immutable labels without freezing or mutating the host's objects", () => {
  const context = structuredClone(contextFixture());
  const request = structuredClone(requestFixture(context));
  const before = JSON.stringify(request);
  const result = value(gate(context).evaluate(request));
  expect(JSON.stringify(request)).toBe(before);
  expect(Object.isFrozen(context)).toBe(false);
  expect(Object.isFrozen(request.suggestion)).toBe(false);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.effective)).toBe(true);
  expect(Object.isFrozen(result.effective.reasonCodes)).toBe(true);
});

it("cannot bypass the current host cohort maturity requirement through evidence metadata", () => {
  const original = refundEvidence();
  if (original.eventType !== "REFUND_SPIKE") throw new Error("refund fixture expected");
  const observedAt = "2026-10-25T02:00:00Z";
  const evidence = evidenceFixture({
    ...original,
    observedAt,
    sourceWatermark: observedAt,
    facts: { ...original.facts, observedThrough: observedAt, maturityHours: 0 },
  });
  const context = contextFixture(evidence);
  expect(value(gate(context).evaluate(requestFixture(context)))).toMatchObject({
    effective: { llmEscalation: "NO_LLM_NEEDED", reasonCodes: ["INSUFFICIENT_SAMPLE"] },
    overrideReason: "INSUFFICIENT_EVIDENCE",
  });
});

function refundCohortEvidence(paidCohortOrders: number): EventEvidenceV1 {
  const original = refundEvidence();
  if (original.eventType !== "REFUND_SPIKE") throw new Error("refund fixture expected");
  return evidenceFixture({
    ...original,
    facts: {
      ...original.facts,
      paidCohortOrders,
      refundedOrders: paidCohortOrders,
      currentRate: rate(paidCohortOrders, paidCohortOrders),
      affectedSkuShare: rate(0, paidCohortOrders),
    },
  });
}

it.each([1, ruleset.refund.minimumSampleSize - 1])(
  "blocks DEEP for an actual refund cohort of %i despite sufficient aggregate samples",
  (paidCohortOrders) => {
    const context = contextFixture(refundCohortEvidence(paidCohortOrders), "CRITICAL");
    expect(context.evidence.evidence.sampleSize).toBe(100);
    expect(value(gate(context).evaluate(requestFixture(context)))).toMatchObject({
      effective: {
        severity: "CRITICAL",
        llmEscalation: "NO_LLM_NEEDED",
        evidenceSufficiency: "INSUFFICIENT_DATA",
        reasonCodes: ["INSUFFICIENT_SAMPLE"],
      },
      overrideReason: "INSUFFICIENT_EVIDENCE",
    });
  },
);

it("allows DEEP at the inclusive actual refund cohort sample minimum", () => {
  const context = contextFixture(refundCohortEvidence(ruleset.refund.minimumSampleSize));
  expect(
    value(gate(context).evaluate(requestFixture(context, { severity: "HIGH" }))),
  ).toMatchObject({
    effective: {
      severity: "HIGH",
      llmEscalation: "DEEP_REASONING_REQUIRED",
      evidenceSufficiency: "SUFFICIENT",
    },
    overrideReason: null,
  });
});

function nullableRate(numerator: number | null, denominator: number | null) {
  return {
    numerator,
    denominator,
    period,
    valueBasisPoints:
      numerator === null || denominator === null || denominator === 0
        ? null
        : Math.round((numerator / denominator) * 10000),
  };
}
function cancellationEvidence(
  cohortOrders: number | null,
  paid: number | null = 1,
  pending: number | null = 0,
  sampleSize = 100,
): EventEvidenceV1 {
  const measure = { kind: "CANCELLED_ORDER_RATE", unit: "basisPoints" };
  const baseline = baselineFixture({
    measure,
    sourceReferences: [
      { ...source, period: baselinePeriod, observedAt: baselinePeriod.periodEnd, measure },
    ],
  });
  const total = paid === null || pending === null ? null : paid + pending;
  return evidenceFixture({
    eventType: "CANCELLED_ORDER_SPIKE",
    entity: { kind: "STORE" },
    sampleSize,
    baseline,
    baselineAlignment: "ALIGNED",
    baselineVersion: eventPolicy.baselineVersion,
    sourceReferences: [{ ...source, measure }],
    facts: {
      cohort: period,
      cohortOrders,
      paidCancelledOrders: paid,
      pendingCancelledOrders: pending,
      currentRate: nullableRate(total, cohortOrders),
      baselineRate: null,
      reasonCounts: [],
    },
  });
}
it.each([
  [null, 1, 0],
  [100, null, 0],
  [100, 0, null],
] as const)(
  "blocks cancellation DEEP when an actual cohort/count fact is missing %#",
  (cohort, paid, pending) => {
    const context = contextFixture(cancellationEvidence(cohort, paid, pending), "CRITICAL");
    expect(value(gate(context).evaluate(requestFixture(context)))).toMatchObject({
      effective: {
        severity: "CRITICAL",
        llmEscalation: "NO_LLM_NEEDED",
        evidenceSufficiency: "INSUFFICIENT_DATA",
        reasonCodes: ["MISSING_DATA"],
      },
      overrideReason: "INSUFFICIENT_EVIDENCE",
    });
  },
);
it.each([1, 19, 20])("blocks cancellation aggregate/actual cohort disagreement at %i", (cohort) => {
  const context = contextFixture(cancellationEvidence(cohort));
  expect(value(gate(context).evaluate(requestFixture(context)))).toMatchObject({
    effective: {
      llmEscalation: "NO_LLM_NEEDED",
      evidenceSufficiency: "AMBIGUOUS",
      reasonCodes: ["CONFLICTING_DATA"],
    },
    overrideReason: "INSUFFICIENT_EVIDENCE",
  });
});
it.each([1, 19])("blocks a coherent actual cancellation cohort below minimum at %i", (cohort) => {
  const context = contextFixture(cancellationEvidence(cohort, 1, 0, cohort));
  expect(value(gate(context).evaluate(requestFixture(context)))).toMatchObject({
    effective: { llmEscalation: "NO_LLM_NEEDED", reasonCodes: ["INSUFFICIENT_SAMPLE"] },
    overrideReason: "INSUFFICIENT_EVIDENCE",
  });
});
it("preserves DEEP for a coherent cancellation cohort exactly at its current sample minimum", () => {
  const context = contextFixture(cancellationEvidence(20, 1, 0, 20));
  expect(
    value(gate(context).evaluate(requestFixture(context, { severity: "HIGH" }))),
  ).toMatchObject({
    effective: { llmEscalation: "DEEP_REASONING_REQUIRED", evidenceSufficiency: "SUFFICIENT" },
    overrideReason: null,
  });
});

const primaryFinancialFacts = {
  paidRevenueMinor: 10000,
  netRevenueMinor: null,
  grossMerchandiseMinor: 10000,
  grossProfitMinor: null,
  contributionMinor: 500,
  discountMinor: 1000,
  spendMinor: null,
  costCoverageBasisPoints: 10000,
  feeCoverageBasisPoints: 10000,
  profitDeltaMinor: null,
  attributionVersion: null,
  contributions: [],
  skuContributions: [],
  discountRate: nullableRate(1000, 10000),
  promotionPeriod: period,
};
const prerequisiteFacts = {
  INVENTORY_STAGNATION: {
    availableUnits: 100,
    salesUnits: 100,
    salesWindow: period,
    salesWindowHours: 1,
    holdingDays: 90,
    demandCoverageDays: 1 / 24,
    listedAt: "2026-07-01T00:00:00Z",
    inventoryCostMinor: null,
    costCoverageBasisPoints: 0,
  },
  PROFIT_MARGIN_DROP: primaryFinancialFacts,
  UNUSUAL_DISCOUNT: {
    ...primaryFinancialFacts,
    grossProfitMinor: null,
    contributionMinor: null,
    costCoverageBasisPoints: 0,
    feeCoverageBasisPoints: 0,
  },
  REVENUE_DROP: {
    ...primaryFinancialFacts,
    grossProfitMinor: null,
    contributionMinor: null,
    costCoverageBasisPoints: 0,
    feeCoverageBasisPoints: 0,
  },
  ROAS_DROP: {
    spendMinor: 1000,
    attributedRevenueMinor: 2000,
    impressions: null,
    clicks: null,
    attributedOrders: null,
    attributionCoverageBasisPoints: 10000,
    roas: nullableRate(2000, 1000),
  },
  AD_SPEND_SPIKE: {
    spendMinor: 1000,
    attributedRevenueMinor: null,
    impressions: null,
    clicks: null,
    attributedOrders: null,
    attributionCoverageBasisPoints: 0,
    roas: nullableRate(null, 1000),
  },
  CONVERSION_DROP: {
    visitors: 100,
    paidOrders: 10,
    cart: null,
    checkout: null,
    conversion: nullableRate(10, 100),
    baselineConversion: null,
    priceChangeBasisPoints: null,
    priceEffectiveAt: null,
    variantAvailabilityBasisPoints: null,
    relationship: "CORRELATION_ONLY",
  },
  PRODUCT_BREAKOUT: {
    salesUnits: 100,
    salesWindow: period,
    salesWindowHours: 1,
    salesUnitsPerHour: 100,
    conversion: nullableRate(20, 100),
    grossProfitMinor: null,
    netRevenueMinor: null,
    costCoverageBasisPoints: 0,
    listedAt: "2026-07-01T00:00:00Z",
  },
  SYNC_FAILURE: {
    lastSuccessAt: null,
    lagSeconds: null,
    typedErrorCode: "AUTH_EXPIRED",
    affectedResourceKind: "INVENTORY",
  },
} as const;
type PrerequisiteVariant = keyof typeof prerequisiteFacts;
const primaryMeasures = {
  INVENTORY_STAGNATION: null,
  PROFIT_MARGIN_DROP: { kind: "CONTRIBUTION", unit: "minorCNY" },
  UNUSUAL_DISCOUNT: null,
  REVENUE_DROP: { kind: "PAID_REVENUE", unit: "minorCNY" },
  ROAS_DROP: { kind: "ROAS", unit: "basisPoints" },
  AD_SPEND_SPIKE: { kind: "AD_SPEND", unit: "minorCNY" },
  CONVERSION_DROP: { kind: "CONVERSION_RATE", unit: "basisPoints" },
  PRODUCT_BREAKOUT: { kind: "PAID_UNITS", unit: "units" },
  SYNC_FAILURE: null,
} as const;
function primaryEvidence(eventType: PrerequisiteVariant, patch: object = {}): EventEvidenceV1 {
  const measure = primaryMeasures[eventType];
  const baseline =
    measure === null
      ? null
      : baselineFixture({
          measure,
          sourceReferences: [
            { ...source, period: baselinePeriod, observedAt: baselinePeriod.periodEnd, measure },
          ],
        });
  const entity =
    eventType === "SYNC_FAILURE"
      ? { kind: "CONNECTION", connectionId: binding.connectionId }
      : eventType === "ROAS_DROP" || eventType === "AD_SPEND_SPIKE"
        ? { kind: "CAMPAIGN", externalCampaignId: "campaign-a" }
        : eventType === "PRODUCT_BREAKOUT" || eventType === "INVENTORY_STAGNATION"
          ? { kind: "SKU", externalSkuId: "sku-a" }
          : { kind: "STORE" };
  return evidenceFixture({
    eventType,
    entity,
    baseline,
    baselineAlignment: baseline === null ? "MISSING" : "ALIGNED",
    baselineVersion: baseline === null ? null : eventPolicy.baselineVersion,
    sourceReferences: [{ ...source, measure }],
    facts: { ...prerequisiteFacts[eventType], ...patch },
  });
}
function primaryContext(eventType: PrerequisiteVariant, patch: object = {}) {
  return contextFixture(
    primaryEvidence(eventType, patch),
    eventType === "PRODUCT_BREAKOUT" ? "LOW" : "CRITICAL",
  );
}
const missingPrimaryFacts = [
  ["INVENTORY_STAGNATION", { availableUnits: null }],
  ["INVENTORY_STAGNATION", { salesUnits: null }],
  ["INVENTORY_STAGNATION", { holdingDays: null }],
  ["INVENTORY_STAGNATION", { demandCoverageDays: null }],
  ["INVENTORY_STAGNATION", { listedAt: null }],
  ["PROFIT_MARGIN_DROP", { contributionMinor: null }],
  ["UNUSUAL_DISCOUNT", { discountMinor: null, discountRate: nullableRate(null, 10000) }],
  ["UNUSUAL_DISCOUNT", { grossMerchandiseMinor: null, discountRate: nullableRate(1000, null) }],
  ["UNUSUAL_DISCOUNT", { promotionPeriod: null }],
  ["REVENUE_DROP", { paidRevenueMinor: null }],
  ["ROAS_DROP", { spendMinor: null, roas: nullableRate(2000, null) }],
  ["ROAS_DROP", { attributedRevenueMinor: null, roas: nullableRate(null, 1000) }],
  ["AD_SPEND_SPIKE", { spendMinor: null, roas: nullableRate(null, null) }],
  ["CONVERSION_DROP", { visitors: null, conversion: nullableRate(10, null) }],
  ["CONVERSION_DROP", { paidOrders: null, conversion: nullableRate(null, 100) }],
  ["PRODUCT_BREAKOUT", { salesUnits: null, salesUnitsPerHour: null }],
  ["PRODUCT_BREAKOUT", { conversion: nullableRate(null, 100) }],
  ["PRODUCT_BREAKOUT", { conversion: nullableRate(20, null) }],
  ["PRODUCT_BREAKOUT", { listedAt: null }],
] as const;
it.each(missingPrimaryFacts)("blocks DEEP for missing primary %s facts %#", (eventType, patch) => {
  const context = primaryContext(eventType, patch);
  expect(value(gate(context).evaluate(requestFixture(context)))).toMatchObject({
    effective: {
      severity: context.event.severityFloor,
      llmEscalation: "NO_LLM_NEEDED",
      evidenceSufficiency: "INSUFFICIENT_DATA",
      reasonCodes: ["MISSING_DATA"],
    },
    overrideReason: "INSUFFICIENT_EVIDENCE",
  });
});
it.each(Object.keys(prerequisiteFacts) as PrerequisiteVariant[])(
  "retains supported %s DEEP with primary facts while optional context remains null",
  (eventType) => {
    const context = primaryContext(eventType);
    expect(
      value(
        gate(context).evaluate(requestFixture(context, { severity: context.event.severityFloor })),
      ),
    ).toMatchObject({
      effective: { llmEscalation: "DEEP_REASONING_REQUIRED", evidenceSufficiency: "SUFFICIENT" },
      overrideReason: null,
    });
  },
);
it.each([
  ["INVENTORY_STAGNATION", { salesUnits: 19, demandCoverageDays: 100 / 19 / 24 }],
  ["CONVERSION_DROP", { visitors: 99, conversion: nullableRate(10, 99) }],
  ["PRODUCT_BREAKOUT", { conversion: nullableRate(19, 100) }],
] as const)("applies current %s raw primary sample prerequisites %#", (eventType, patch) => {
  const context = primaryContext(eventType, patch);
  expect(value(gate(context).evaluate(requestFixture(context)))).toMatchObject({
    effective: { llmEscalation: "NO_LLM_NEEDED", reasonCodes: ["INSUFFICIENT_SAMPLE"] },
    overrideReason: "INSUFFICIENT_EVIDENCE",
  });
});
it.each([
  ["PROFIT_MARGIN_DROP", { costCoverageBasisPoints: 0 }],
  ["PROFIT_MARGIN_DROP", { feeCoverageBasisPoints: 0 }],
  ["ROAS_DROP", { attributionCoverageBasisPoints: 0 }],
] as const)("requires coverage of the selected primary %s observation %#", (eventType, patch) => {
  const context = primaryContext(eventType, patch);
  expect(value(gate(context).evaluate(requestFixture(context)))).toMatchObject({
    effective: { llmEscalation: "NO_LLM_NEEDED", reasonCodes: ["PARTIAL_COVERAGE"] },
    overrideReason: "INSUFFICIENT_EVIDENCE",
  });
});

it.each([
  ["INVENTORY_STAGNATION", { salesUnits: 20, demandCoverageDays: 5 / 24 }],
  ["CONVERSION_DROP", { visitors: 100, paidOrders: 0, conversion: nullableRate(0, 100) }],
  ["PRODUCT_BREAKOUT", { conversion: nullableRate(20, 100) }],
  ["REVENUE_DROP", { paidRevenueMinor: 0 }],
  ["UNUSUAL_DISCOUNT", { discountMinor: 0, discountRate: nullableRate(0, 10000) }],
  ["ROAS_DROP", { attributedRevenueMinor: 0, roas: nullableRate(0, 1000) }],
] as const)(
  "retains known %s primary facts at inclusive eligibility or zero-value boundaries %#",
  (eventType, patch) => {
    const context = primaryContext(eventType, patch);
    expect(
      value(
        gate(context).evaluate(requestFixture(context, { severity: context.event.severityFloor })),
      ),
    ).toMatchObject({
      effective: { llmEscalation: "DEEP_REASONING_REQUIRED", evidenceSufficiency: "SUFFICIENT" },
      overrideReason: null,
    });
  },
);

function grossProfitContext(patch: object = {}) {
  const original = primaryEvidence("PROFIT_MARGIN_DROP", {
    grossProfitMinor: 500,
    contributionMinor: null,
    feeCoverageBasisPoints: 0,
    ...patch,
  });
  const measure = { kind: "GROSS_PROFIT", unit: "minorCNY" };
  return contextFixture(
    evidenceFixture({
      ...original,
      baseline: baselineFixture({
        measure,
        sourceReferences: [
          { ...source, period: baselinePeriod, observedAt: baselinePeriod.periodEnd, measure },
        ],
      }),
      sourceReferences: [{ ...source, measure }],
    }),
  );
}
it.each([
  [{}, "DEEP_REASONING_REQUIRED", null],
  [{ grossProfitMinor: null }, "NO_LLM_NEEDED", "MISSING_DATA"],
  [{ costCoverageBasisPoints: 0 }, "NO_LLM_NEEDED", "PARTIAL_COVERAGE"],
] as const)(
  "uses the pinned gross-profit primary measure without requiring contribution/fees %#",
  (patch, escalation, reason) => {
    const context = grossProfitContext(patch);
    const result = value(gate(context).evaluate(requestFixture(context, { severity: "HIGH" })));
    expect(result.effective.llmEscalation).toBe(escalation);
    expect(result.overrideReason).toBe(reason === null ? null : "INSUFFICIENT_EVIDENCE");
    if (reason !== null) expect(result.effective.reasonCodes).toEqual([reason]);
  },
);

it.each([999, 1 + Number.EPSILON * 5, 1 - Number.EPSILON * 5])(
  "blocks conflicting stockout coverage diagnostic %s against raw one-hour coverage",
  (estimatedHoursRemaining) => {
    const context = contextFixture(
      evidenceFixture({ facts: { ...facts, estimatedHoursRemaining } }),
      "CRITICAL",
    );
    expect(value(gate(context).evaluate(requestFixture(context)))).toMatchObject({
      effective: {
        severity: "CRITICAL",
        llmEscalation: "NO_LLM_NEEDED",
        evidenceSufficiency: "AMBIGUOUS",
        reasonCodes: ["CONFLICTING_DATA"],
      },
      overrideReason: "INSUFFICIENT_EVIDENCE",
    });
  },
);
it.each([999, 0, 1 / 24 + Number.EPSILON])(
  "blocks conflicting stagnation diagnostic %s against raw one-hour coverage",
  (demandCoverageDays) => {
    const context = primaryContext("INVENTORY_STAGNATION", { demandCoverageDays });
    expect(value(gate(context).evaluate(requestFixture(context)))).toMatchObject({
      effective: {
        severity: "CRITICAL",
        llmEscalation: "NO_LLM_NEEDED",
        evidenceSufficiency: "AMBIGUOUS",
        reasonCodes: ["CONFLICTING_DATA"],
      },
      overrideReason: "INSUFFICIENT_EVIDENCE",
    });
  },
);
it.each([1, 1 + Number.EPSILON * 4, 1 - Number.EPSILON * 4, null])(
  "accepts supported stockout diagnostic %s including exact detector rounding tolerance and nullable context",
  (estimatedHoursRemaining) => {
    const context = contextFixture(
      evidenceFixture({
        facts: { ...facts, estimatedHoursRemaining, supplierLeadTimeHours: null },
      }),
    );
    expect(
      value(gate(context).evaluate(requestFixture(context, { severity: "HIGH" }))),
    ).toMatchObject({
      effective: { llmEscalation: "DEEP_REASONING_REQUIRED", evidenceSufficiency: "SUFFICIENT" },
      overrideReason: null,
    });
  },
);
it.each([1 / 624, 1 / 26 / 24])(
  "accepts supported stagnation rational or P03 producer rounding %s",
  (demandCoverageDays) => {
    const context = primaryContext("INVENTORY_STAGNATION", {
      availableUnits: 1,
      salesUnits: 26,
      demandCoverageDays,
    });
    expect(
      value(gate(context).evaluate(requestFixture(context, { severity: "CRITICAL" }))),
    ).toMatchObject({
      effective: { llmEscalation: "DEEP_REASONING_REQUIRED", evidenceSufficiency: "SUFFICIENT" },
      overrideReason: null,
    });
  },
);
it("preserves independent sold-out urgency while a conflicting forecast diagnostic blocks DEEP", () => {
  const context = contextFixture(
    evidenceFixture({ facts: { ...facts, availableUnits: 0, estimatedHoursRemaining: 999 } }),
  );
  expect(value(gate(context).evaluate(requestFixture(context)))).toMatchObject({
    effective: {
      severity: "CRITICAL",
      notificationRoute: "NOTIFY_NOW",
      attentionPriority: "URGENT",
      llmEscalation: "NO_LLM_NEEDED",
      evidenceSufficiency: "AMBIGUOUS",
      reasonCodes: ["CONFIRMED_STOCKOUT", "CONFLICTING_DATA"],
    },
    overrideReason: "INSUFFICIENT_EVIDENCE",
  });
});

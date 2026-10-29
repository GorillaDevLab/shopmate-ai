import { expect, it } from "vitest";
import {
  DecisionResultSchema,
  EventEvidenceV1Schema,
  EvaluationContextSchema,
  EventTypeSchema,
  SanitizedDecisionInputSchema,
  createEventFingerprint,
  type DecisionControl,
  type DecisionLabels,
  type DecisionPortResult,
  type EvaluationContext,
  type EventEvidenceV1,
  type InventoryRefundRuleEvaluator,
  type SanitizedDecisionInput,
} from "@shopmate/contracts";
import { DEFAULT_EVENT_RULE_POLICY } from "../events/event-rule-policy.js";
import { DEFAULT_DECISION_RULESET } from "./decision-ruleset.js";
import {
  CanonicalHostEvidenceHash,
  DefaultDecisionInputSanitizer,
} from "./decision-input-sanitizer.js";
import { PureInventoryRefundRuleEvaluator } from "./inventory-refund-rules.js";
import {
  RulesDecisionProvider,
  type RulesDecisionProviderOptions,
  type PreparedDecisionInputAssurance,
} from "./rules-decision.provider.js";

const period = {
  periodStart: "2026-10-24T00:00:00Z",
  periodEnd: "2026-10-24T01:00:00Z",
  timezone: "Asia/Shanghai",
  currency: "CNY",
} as const;
const previous = {
  ...period,
  periodStart: "2026-10-17T00:00:00Z",
  periodEnd: "2026-10-17T01:00:00Z",
};
const labels: DecisionLabels = {
  severity: "MEDIUM",
  notificationRoute: "DAILY_BRIEF",
  llmEscalation: "SIMPLE_EXPLANATION",
  evidenceSufficiency: "SUFFICIENT",
  attentionPriority: "NORMAL_PRIORITY",
  reasonCodes: ["PROFIT_MARGIN_DROP"],
};
function profit(): SanitizedDecisionInput {
  return SanitizedDecisionInputSchema.parse({
    schemaVersion: 1,
    correlationId: "57a1befc-02cb-4acc-8a1a-6975b2016240",
    eventType: "PROFIT_MARGIN_DROP",
    period,
    observedAt: period.periodEnd,
    sourceWatermark: period.periodEnd,
    dataStatus: "VERIFIED",
    sampleSize: 30,
    coverageBasisPoints: 10000,
    qualityReasons: [],
    baseline: baseline(),
    facts: financialFacts(),
  });
}
function baseline() {
  return {
    status: "AVAILABLE",
    alignment: "ALIGNED",
    measure: { kind: "CONTRIBUTION", unit: "minorCNY" },
    aggregation: "EXACT_MEDIAN",
    period: previous,
    median: 10000,
    mad: 100,
    sampleSize: 4,
    coverageBasisPoints: 10000,
  } as const;
}
function financialFacts() {
  return {
    paidRevenueMinor: 60000,
    netRevenueMinor: 58000,
    grossMerchandiseMinor: 70000,
    grossProfitMinor: 20000,
    contributionMinor: 7000,
    discountMinor: 7000,
    spendMinor: 5000,
    costCoverageBasisPoints: 10000,
    feeCoverageBasisPoints: 10000,
    profitDeltaMinor: -3000,
    contributions: [
      { kind: "VOLUME", amountMinor: 1000 },
      { kind: "PRICE_DISCOUNT", amountMinor: -1500 },
      { kind: "SKU_MIX", amountMinor: -500 },
      { kind: "COGS", amountMinor: -1000 },
      { kind: "ADVERTISING", amountMinor: -1000 },
      { kind: "RESIDUAL", amountMinor: 0 },
    ],
    discountRate: { numerator: 7000, denominator: 70000, valueBasisPoints: 1000, period },
    promotionPeriod: null,
  };
}
function control(): DecisionControl {
  return {
    timeDomain: "SECURITY_UTC",
    deadlineAt: "2026-10-29T01:01:00Z",
    signal: new AbortController().signal,
  };
}
const specialRules: InventoryRefundRuleEvaluator = {
  evaluate: (input, ruleset) => ({
    schemaVersion: 1,
    correlationId: input.correlationId,
    status: "EVALUATED",
    rulesetVersion: ruleset.version,
    labels: ruleset.defaultLabels,
    confidenceMetadata: null,
  }),
};
function options(input = profit()): RulesDecisionProviderOptions {
  const prepared = JSON.stringify(input);
  return {
    ruleset: DEFAULT_DECISION_RULESET,
    policy: DEFAULT_EVENT_RULE_POLICY,
    defaults: EventTypeSchema.options.map((eventType) => ({ eventType, labels })),
    specialRules,
    // Component fixture only: a real host must check full evidence hash and trusted scope.
    assurance: {
      verify: (candidate, pins) =>
        JSON.stringify(candidate) === prepared &&
        pins.rulesetVersion === "decision-rules-v1" &&
        pins.eventPolicyVersion === "event-policy-v1"
          ? { ok: true, value: undefined }
          : { ok: false, code: "HASH_MISMATCH" },
    },
    clock: { timeDomain: "SECURITY_UTC", now: () => "2026-10-29T01:00:00Z" },
  };
}
async function evaluate(
  input: SanitizedDecisionInput,
  overrides: Partial<RulesDecisionProviderOptions> = {},
) {
  return new RulesDecisionProvider({ ...options(input), ...overrides }).evaluate(input, control());
}

it("returns a deterministic immutable bundle with DEEP only for sufficient composite profit", async () => {
  const input = profit();
  const before = JSON.stringify(input);
  const result = await evaluate(input);
  expect(result).toEqual({
    schemaVersion: 1,
    correlationId: input.correlationId,
    rulesetVersion: "decision-rules-v1",
    status: "EVALUATED",
    labels: { ...labels, llmEscalation: "DEEP_REASONING_REQUIRED" },
    confidenceMetadata: null,
  });
  expect(await evaluate(input)).toEqual(result);
  expect(DecisionResultSchema.safeParse(result).success).toBe(true);
  expect(JSON.stringify(input)).toBe(before);
  expect(Object.isFrozen(result)).toBe(true);
});

it("never accepts DEEP from configured defaults or the inventory/refund component", async () => {
  const input = stock();
  expect(
    await evaluate(input, {
      specialRules: {
        evaluate: (candidate, ruleset) => ({
          schemaVersion: 1,
          correlationId: candidate.correlationId,
          status: "EVALUATED",
          rulesetVersion: ruleset.version,
          labels: { ...labels, llmEscalation: "DEEP_REASONING_REQUIRED" },
          confidenceMetadata: null,
        }),
      },
    }),
  ).toMatchObject({ labels: { llmEscalation: "NO_LLM_NEEDED" } });
  const config = options(revenue(30000));
  const defaults = config.defaults.map((row) => ({
    ...row,
    labels: { ...row.labels, llmEscalation: "DEEP_REASONING_REQUIRED" as const },
  }));
  expect(await evaluate(revenue(30000), { defaults })).toMatchObject({
    labels: { llmEscalation: "SIMPLE_EXPLANATION" },
  });
});

function stock(): SanitizedDecisionInput {
  return SanitizedDecisionInputSchema.parse({
    ...profit(),
    eventType: "STOCKOUT_RISK",
    baseline: null,
    sampleSize: 0,
    dataStatus: "INSUFFICIENT",
    qualityReasons: ["LOW_SAMPLE", "LEAD_TIME_MISSING"],
    facts: {
      availableUnits: 0,
      salesUnits: null,
      salesWindow: period,
      salesWindowHours: 1,
      estimatedHoursRemaining: null,
      supplierLeadTimeHours: null,
      safetyBufferHours: null,
      inboundETA: null,
      inventoryObservedAt: period.periodEnd,
      inventoryAgeSeconds: 0,
      inventoryStatus: "VERIFIED",
    },
  });
}

it("retains an independent reliable sold-out fact through the real special component", async () => {
  expect(
    await evaluate(stock(), { specialRules: new PureInventoryRefundRuleEvaluator() }),
  ).toMatchObject({
    labels: {
      severity: "CRITICAL",
      notificationRoute: "NOTIFY_NOW",
      attentionPriority: "URGENT",
      evidenceSufficiency: "SUFFICIENT",
      llmEscalation: "NO_LLM_NEEDED",
      reasonCodes: ["CONFIRMED_STOCKOUT"],
    },
  });
});

it("caps opportunity labels at INFO/LOW and low priority without granting authority", async () => {
  const input = SanitizedDecisionInputSchema.parse({
    ...profit(),
    eventType: "PRODUCT_BREAKOUT",
    baseline: { ...baseline(), measure: { kind: "PAID_UNITS", unit: "units" } },
    facts: {
      salesUnits: 50,
      salesWindow: period,
      salesWindowHours: 1,
      salesUnitsPerHour: 50,
      conversion: { numerator: 30, denominator: 100, valueBasisPoints: 3000, period },
      grossProfitMinor: 7000,
      netRevenueMinor: 15000,
      costCoverageBasisPoints: 10000,
      listedAt: "2026-09-24T01:00:00Z",
    },
  });
  const defaults = options(input).defaults.map((row) => ({
    ...row,
    labels: { ...labels, severity: "CRITICAL" as const, attentionPriority: "URGENT" as const },
  }));
  const result = await evaluate(input, { defaults });
  expect(result).toMatchObject({ labels: { severity: "LOW", attentionPriority: "LOW_PRIORITY" } });
  expect(DecisionResultSchema.safeParse(result).success).toBe(true);
});

function value<T>(result: DecisionPortResult<T>): T {
  if (!result.ok) throw new Error(`Fixture preparation failed: ${result.code}`);
  return result.value;
}

const hasher = new CanonicalHostEvidenceHash();
const sanitizer = new DefaultDecisionInputSanitizer(hasher);
const binding = {
  organizationId: "org-rules",
  workspaceId: "workspace-rules",
  storeId: "store-rules",
  connectionId: "connection-rules",
  externalStoreId: "external-rules",
};
const actor = {
  userId: "user-rules",
  merchantId: "merchant-rules",
  organizationId: binding.organizationId,
  workspaceId: binding.workspaceId,
  role: "VIEWER",
  permissions: ["tenant:read"],
} as const;

function trustedEvidence(): EventEvidenceV1 {
  const source = {
    kind: "NORMALIZED_AGGREGATE",
    id: "source-rules",
    version: "source-v1",
    hash: "source-hash",
    binding,
    definitionVersion: "metrics-v1",
    period,
    observedAt: period.periodEnd,
    measure: null,
  } as const;
  return EventEvidenceV1Schema.parse({
    schemaVersion: 1,
    binding,
    ...period,
    observedAt: period.periodEnd,
    sourceWatermark: period.periodEnd,
    dataStatus: "VERIFIED",
    sampleSize: 30,
    coverageBasisPoints: 10000,
    issues: [],
    definitionVersion: "metrics-v1",
    baselineVersion: "robust-baseline-v1",
    baselineAlignment: "ALIGNED",
    baseline: {
      ...baseline(),
      version: "robust-baseline-v1",
      sourceReferences: [{ ...source, period: previous, measure: baseline().measure }],
    },
    sourceReferences: [source],
    eventType: "PROFIT_MARGIN_DROP",
    entity: { kind: "STORE" },
    facts: { ...financialFacts(), attributionVersion: "profit-delta-v1", skuContributions: [] },
  });
}

function trustedContext(evidence = trustedEvidence()): EvaluationContext {
  const reference = {
    schemaVersion: 1,
    id: "evidence-rules",
    version: "evidence-v1",
    hash: value(hasher.hash(evidence)),
    binding: evidence.binding,
    eventType: evidence.eventType,
    entity: evidence.entity,
    definitionVersion: evidence.definitionVersion,
    baselineVersion: evidence.baselineVersion,
  } as const;
  return EvaluationContextSchema.parse({
    schemaVersion: 1,
    correlationId: profit().correlationId,
    requestId: "request-rules",
    actor,
    event: {
      schemaVersion: 1,
      id: "event-rules",
      binding: evidence.binding,
      eventType: evidence.eventType,
      entity: evidence.entity,
      fingerprint: createEventFingerprint(reference),
      severityFloor: "MEDIUM",
      rulePolicyVersion: "event-policy-v1",
      state: "OPEN",
      revision: 1,
      firstSeenAt: period.periodEnd,
      lastSeenAt: period.periodEnd,
      currentEvidence: reference,
    },
    evidence: { reference, evidence },
  });
}

/** Test host only: captures authenticated context, immutable full-evidence hash and exact projection. */
function hostAssurance(current: () => EvaluationContext): PreparedDecisionInputAssurance {
  const context = current();
  const snapshot = JSON.stringify(context);
  const prepared = JSON.stringify(value(sanitizer.sanitize(context)));
  const digest = value(hasher.hash(context.evidence.evidence));
  return {
    verify: (input, pins) => {
      const active = current();
      const projection = sanitizer.sanitize(active);
      const hash = hasher.hash(active.evidence.evidence);
      return projection.ok &&
        hash.ok &&
        hash.value === digest &&
        JSON.stringify(active) === snapshot &&
        JSON.stringify(projection.value) === prepared &&
        JSON.stringify(input) === prepared &&
        pins.rulesetVersion === "decision-rules-v1" &&
        pins.eventPolicyVersion === active.event.rulePolicyVersion
        ? { ok: true, value: undefined }
        : { ok: false, code: "HASH_MISMATCH" };
    },
  };
}

it("composes actual full-evidence hashing, sanitization and rules without adding hash to the DTO", async () => {
  const context = trustedContext();
  const input = value(sanitizer.sanitize(context));
  const result = await evaluate(input, {
    assurance: hostAssurance(() => context),
    specialRules: new PureInventoryRefundRuleEvaluator(),
  });
  expect(result).toMatchObject({
    status: "EVALUATED",
    labels: { llmEscalation: "DEEP_REASONING_REQUIRED" },
  });
  expect(Object.keys(input)).not.toContain("evidenceHash");
  expect(Object.keys(result)).not.toContain("evidenceHash");
});

it("rejects altered hidden scope/source evidence even when its sanitized projection is identical", async () => {
  let active = trustedContext();
  const input = value(sanitizer.sanitize(active));
  const provider = new RulesDecisionProvider({
    ...options(input),
    assurance: hostAssurance(() => active),
  });
  const evidence = active.evidence.evidence;
  active = trustedContext(
    EventEvidenceV1Schema.parse({
      ...evidence,
      sourceReferences: evidence.sourceReferences.map((source) => ({
        ...source,
        version: "source-v2",
      })),
    }),
  );
  expect(value(sanitizer.sanitize(active))).toEqual(input);
  expect(await provider.evaluate(input, control())).toMatchObject({
    status: "UNAVAILABLE",
    code: "INVALID_RESULT",
  });
});

it("fails closed when complete prepared content, correlation or policy pins differ", async () => {
  const input = profit();
  const provider = new RulesDecisionProvider(options(input));
  for (const patch of [
    { sampleSize: 31 },
    { correlationId: "57a1befc-02cb-4acc-8a1a-6975b2016241" },
    { observedAt: "2026-10-24T01:00:01Z" },
  ]) {
    expect(await provider.evaluate({ ...input, ...patch }, control())).toMatchObject({
      status: "UNAVAILABLE",
      code: "INVALID_RESULT",
    });
  }
  const config = options(input);
  expect(
    await evaluate(input, { ...config, policy: { ...config.policy, version: "event-policy-v2" } }),
  ).toMatchObject({ status: "UNAVAILABLE", code: "INVALID_RESULT" });
});

it("uses security UTC deadline and cancellation without consulting business evidence time", async () => {
  const provider = new RulesDecisionProvider(options());
  const abort = new AbortController();
  abort.abort();
  expect(await provider.evaluate(profit(), { ...control(), signal: abort.signal })).toMatchObject({
    status: "UNAVAILABLE",
    code: "ABORTED",
  });
  expect(
    await provider.evaluate(profit(), { ...control(), deadlineAt: "2026-10-29T01:00:00Z" }),
  ).toMatchObject({ status: "UNAVAILABLE", code: "TIMEOUT" });
});

it("rejects unsupported schemas, extensions and malformed controls", async () => {
  const provider = new RulesDecisionProvider(options());
  const invalid = { ...profit(), schemaVersion: 2 } as unknown as SanitizedDecisionInput;
  expect(await provider.evaluate(invalid, control())).toMatchObject({
    status: "UNAVAILABLE",
    code: "UNSUPPORTED_SCHEMA",
  });
  expect(
    await provider.evaluate(
      { ...profit(), token: "untrusted" } as unknown as SanitizedDecisionInput,
      control(),
    ),
  ).toMatchObject({ status: "UNAVAILABLE", code: "INVALID_RESULT" });
  const malformed = { ...control(), deadlineAt: "tomorrow" };
  expect(await provider.evaluate(profit(), malformed)).toMatchObject({
    status: "UNAVAILABLE",
    code: "INVALID_RESULT",
  });
});

it("captures strict immutable server defaults and rejects incomplete or duplicate mappings", async () => {
  const config = structuredClone({
    ruleset: options().ruleset,
    policy: options().policy,
    defaults: options().defaults.map((row) => ({ ...row, labels: { ...row.labels } })),
  });
  const provider = new RulesDecisionProvider({ ...options(), ...config });
  config.defaults[4]!.labels.severity = "CRITICAL";
  expect(await provider.evaluate(profit(), control())).toMatchObject({
    labels: { severity: "MEDIUM" },
  });
  expect(() => new RulesDecisionProvider({ ...options(), defaults: [] })).toThrow();
  expect(
    () =>
      new RulesDecisionProvider({
        ...options(),
        defaults: [...options().defaults, options().defaults[0]!],
      }),
  ).toThrow();
  expect(
    () => new RulesDecisionProvider({ ...options(), policy: { ...options().policy, rules: [] } }),
  ).toThrow();
});

it("turns assurance and clock exceptions into closed unavailable results", async () => {
  expect(
    await evaluate(profit(), {
      assurance: {
        verify: () => {
          throw new Error("host unavailable");
        },
      },
    }),
  ).toMatchObject({ status: "UNAVAILABLE", code: "PROVIDER_FAILURE" });
  expect(
    await evaluate(profit(), { clock: { timeDomain: "SECURITY_UTC", now: () => "invalid" } }),
  ).toMatchObject({ status: "UNAVAILABLE", code: "INVALID_RESULT" });
});

it.each([
  [{ sampleSize: 19 }, "INSUFFICIENT_SAMPLE", "INSUFFICIENT_DATA"],
  [{ observedAt: "2026-10-24T02:00:01Z" }, "STALE_DATA", "INSUFFICIENT_DATA"],
  [{ baseline: null }, "MISSING_DATA", "INSUFFICIENT_DATA"],
  [
    { dataStatus: "INSUFFICIENT", qualityReasons: ["SOURCE_INCONSISTENT"] },
    "CONFLICTING_DATA",
    "AMBIGUOUS",
  ],
  [
    { dataStatus: "INSUFFICIENT", qualityReasons: ["LOW_SAMPLE"] },
    "INSUFFICIENT_SAMPLE",
    "INSUFFICIENT_DATA",
  ],
  [
    { dataStatus: "INSUFFICIENT", coverageBasisPoints: 8999, qualityReasons: ["PARTIAL_COVERAGE"] },
    "PARTIAL_COVERAGE",
    "INSUFFICIENT_DATA",
  ],
] as const)("gates untrustworthy profit evidence %j", async (patch, reason, sufficiency) => {
  const input = SanitizedDecisionInputSchema.parse({ ...profit(), ...patch });
  expect(await evaluate(input)).toMatchObject({
    status: "EVALUATED",
    labels: {
      severity: "INFO",
      notificationRoute: "IGNORE",
      llmEscalation: "NO_LLM_NEEDED",
      evidenceSufficiency: sufficiency,
      attentionPriority: "LOW_PRIORITY",
      reasonCodes: [reason],
    },
  });
});

function revenue(amount = 58000, mad = 100) {
  const input = profit();
  return SanitizedDecisionInputSchema.parse({
    ...input,
    eventType: "REVENUE_DROP",
    baseline: {
      ...baseline(),
      measure: { kind: "PAID_REVENUE", unit: "minorCNY" },
      median: 60000,
      mad,
    },
    facts: { ...financialFacts(), paidRevenueMinor: amount },
  });
}

it("does not upgrade ordinary aligned weekday/hour revenue variation", async () => {
  expect(await evaluate(revenue(58000, 3000))).toMatchObject({
    labels: {
      severity: "INFO",
      llmEscalation: "NO_LLM_NEEDED",
      reasonCodes: ["NORMAL_SEASONALITY"],
    },
  });
  expect(await evaluate(revenue())).toMatchObject({
    labels: { severity: "INFO", reasonCodes: ["NO_MATERIAL_CHANGE"] },
  });
});

it("rejects falsely aligned weekdays, wrong measures and poor baseline quality", async () => {
  const input = revenue(30000);
  const before = input.baseline!;
  for (const [patch, reason] of [
    [
      {
        period: {
          ...previous,
          periodStart: "2026-10-16T00:00:00Z",
          periodEnd: "2026-10-16T01:00:00Z",
        },
      },
      "CONFLICTING_DATA",
    ],
    [{ measure: { kind: "CONTRIBUTION", unit: "minorCNY" } }, "CONFLICTING_DATA"],
    [{ sampleSize: 3 }, "INSUFFICIENT_SAMPLE"],
    [{ coverageBasisPoints: 8999 }, "PARTIAL_COVERAGE"],
  ] as const) {
    const candidate = SanitizedDecisionInputSchema.parse({
      ...input,
      baseline: { ...before, ...patch },
    });
    expect(await evaluate(candidate)).toMatchObject({
      labels: { llmEscalation: "NO_LLM_NEEDED", reasonCodes: [reason] },
    });
  }
});

it("cannot use LLM to fill missing profit cost or contribution facts", async () => {
  for (const patch of [{ costCoverageBasisPoints: 9999 }, { contributionMinor: null }]) {
    const input = SanitizedDecisionInputSchema.parse({
      ...profit(),
      facts: { ...financialFacts(), ...patch },
    });
    expect(await evaluate(input)).toMatchObject({
      labels: {
        evidenceSufficiency: "INSUFFICIENT_DATA",
        llmEscalation: "NO_LLM_NEEDED",
        reasonCodes: ["MISSING_DATA"],
      },
    });
  }
});

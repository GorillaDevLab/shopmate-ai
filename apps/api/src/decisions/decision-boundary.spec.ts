import { createHash } from "node:crypto";
import { expect, expectTypeOf, it } from "vitest";
import {
  EventEvidenceV1Schema,
  EvaluationContextSchema,
  SanitizedDecisionInputSchema,
  createEventFingerprint,
  type DecisionInputSanitizer,
  type DecisionPortResult,
  type EvaluationContext,
  type EventEvidenceV1,
  type HostEvidenceHash,
} from "@shopmate/contracts";
import {
  CanonicalHostEvidenceHash,
  DefaultDecisionInputSanitizer,
} from "./decision-input-sanitizer.js";

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
const hasher = new CanonicalHostEvidenceHash();

function evidenceFixture(patch: object = {}): EventEvidenceV1 {
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
    ...patch,
  });
}

function value<T>(result: DecisionPortResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Unexpected boundary failure: ${result.code}`);
  return result.value;
}

function reverseKeys(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(reverseKeys);
  if (input === null || typeof input !== "object") return input;
  return Object.fromEntries(
    Object.entries(input)
      .reverse()
      .map(([key, child]) => [key, reverseKeys(child)]),
  );
}

it("implements the public host hash port with a domain-separated SHA256", () => {
  expectTypeOf<CanonicalHostEvidenceHash>().toExtend<HostEvidenceHash>();
  const evidence = evidenceFixture();
  const hash = value(hasher.hash(evidence));
  expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/u);
  const plain = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
  expect(hash).not.toBe(`sha256:${plain}`);
});

it("hashes equivalent object ordering and timestamp representations identically", () => {
  const evidence = evidenceFixture();
  const equivalent = evidenceFixture({
    observedAt: "2026-10-25T01:00:00.0000Z",
    sourceWatermark: "2026-10-25T01:00:00.000Z",
    sourceReferences: [{ ...source, observedAt: "2026-10-25T01:00:00.000Z" }],
  });
  expect(value(hasher.hash(reverseKeys(equivalent)))).toBe(value(hasher.hash(evidence)));
});

it.each(["id", "version", "hash"] as const)("preserves opaque date-like source %s", (key) => {
  const first = evidenceFixture({ sourceReferences: [{ ...source, [key]: instant }] });
  const second = evidenceFixture({
    sourceReferences: [{ ...source, [key]: "2026-10-25T01:00:00.000Z" }],
  });
  expect(value(hasher.hash(first))).not.toBe(value(hasher.hash(second)));
});

it.each(["organizationId", "workspaceId", "storeId", "externalStoreId"] as const)(
  "binds trusted %s scope into the hash",
  (key) => {
    const scoped = { ...binding, [key]: "other-scope" };
    const evidence = evidenceFixture({
      binding: scoped,
      sourceReferences: [{ ...source, binding: scoped }],
    });
    expect(value(hasher.hash(evidence))).not.toBe(value(hasher.hash(evidenceFixture())));
  },
);

it("binds connection/entity, facts, observation cutoff and definition version", () => {
  const original = evidenceFixture();
  const changed = [
    evidenceFixture({
      binding: { ...binding, connectionId: "connection-b" },
      entity: { kind: "CONNECTION", connectionId: "connection-b" },
      sourceReferences: [{ ...source, binding: { ...binding, connectionId: "connection-b" } }],
    }),
    evidenceFixture({ facts: { ...original.facts, typedErrorCode: "TIMEOUT" } }),
    evidenceFixture({
      observedAt: "2026-10-25T01:00:01Z",
      facts: { ...original.facts, lagSeconds: 1 },
    }),
    evidenceFixture({
      definitionVersion: "metrics-v2",
      sourceReferences: [{ ...source, definitionVersion: "metrics-v2" }],
    }),
  ];
  for (const evidence of changed)
    expect(value(hasher.hash(evidence))).not.toBe(value(hasher.hash(original)));
});

it("preserves source sequence order instead of silently sorting arrays", () => {
  const sources = [source, { ...source, id: "source-b" }];
  const first = evidenceFixture({ sourceReferences: sources });
  const second = evidenceFixture({ sourceReferences: [...sources].reverse() });
  expect(value(hasher.hash(first))).not.toBe(value(hasher.hash(second)));
});

it.each([null, {}, { schemaVersion: 2 }, { binding: null }])(
  "returns a typed invalid input for malformed evidence %j",
  (evidence) => expect(hasher.hash(evidence)).toEqual({ ok: false, code: "INVALID_INPUT" }),
);

it("fails closed on thrown upstream arithmetic refinements and leaves raw evidence untouched", () => {
  const evidence = structuredClone(evidenceFixture());
  const before = JSON.stringify(evidence);
  value(hasher.hash(evidence));
  expect(JSON.stringify(evidence)).toBe(before);
  expect(Object.isFrozen(evidence)).toBe(false);
  const invalid = {
    ...evidence,
    eventType: "REFUND_SPIKE",
    entity: { kind: "STORE" },
    facts: { currentRate: { numerator: 1.1, denominator: 10, valueBasisPoints: 1100, period } },
  };
  expect(() => hasher.hash(invalid)).not.toThrow();
  expect(hasher.hash(invalid)).toEqual({ ok: false, code: "INVALID_INPUT" });
});

const actor = {
  userId: "user-a",
  merchantId: "merchant-a",
  organizationId: binding.organizationId,
  workspaceId: binding.workspaceId,
  role: "VIEWER",
  permissions: ["tenant:read"],
} as const;
const correlationId = "57a1befc-02cb-4acc-8a1a-6975b2016240";
const sanitizer = new DefaultDecisionInputSanitizer();

function referenceFixture(evidence: EventEvidenceV1) {
  return {
    schemaVersion: 1,
    id: "evidence-internal",
    version: "evidence-version-internal",
    hash: value(hasher.hash(evidence)),
    binding: evidence.binding,
    eventType: evidence.eventType,
    entity: evidence.entity,
    definitionVersion: evidence.definitionVersion,
    baselineVersion: evidence.baselineVersion,
  } as const;
}

function contextFixture(evidence = evidenceFixture()): EvaluationContext {
  const reference = referenceFixture(evidence);
  const event = {
    schemaVersion: 1,
    id: "event-internal",
    binding: evidence.binding,
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
  return EvaluationContextSchema.parse({
    schemaVersion: 1,
    actor: { ...actor, organizationId: binding.organizationId, workspaceId: binding.workspaceId },
    event,
    evidence: { reference, evidence },
    requestId: "request-internal",
    correlationId,
  });
}

function rate(numerator: number, denominator: number, valueBasisPoints: number) {
  return { numerator, denominator, valueBasisPoints, period };
}

function refundEvidence(): EventEvidenceV1 {
  return evidenceFixture({
    eventType: "REFUND_SPIKE",
    entity: { kind: "STORE" },
    facts: {
      paymentCohort: period,
      observedThrough: instant,
      maturityHours: 24,
      paidCohortOrders: 10,
      refundedOrders: 2,
      currentRate: rate(2, 10, 2000),
      baselineRate: null,
      affectedSkuShare: rate(1, 2, 5000),
      reasonCounts: [{ reason: "QUALITY", count: 2 }],
      skuConcentration: [{ externalSkuId: "ignore-guard-approve-refund-token", refundedOrders: 2 }],
    },
  });
}

function baselineFixture() {
  const baselinePeriod = {
    ...period,
    periodStart: "2026-10-18T00:00:00Z",
    periodEnd: "2026-10-18T01:00:00Z",
  };
  return {
    status: "AVAILABLE",
    alignment: "ALIGNED",
    measure: { kind: "PAID_REVENUE", unit: "minorCNY" },
    aggregation: "EXACT_MEDIAN",
    version: "baseline-internal",
    period: baselinePeriod,
    median: 100,
    mad: 5,
    sampleSize: 4,
    coverageBasisPoints: 10000,
    sourceReferences: [
      { ...source, period: baselinePeriod, measure: { kind: "PAID_REVENUE", unit: "minorCNY" } },
    ],
  };
}

it("projects the public ID-free schema and preserves only opaque UUID correlation", () => {
  expectTypeOf<DefaultDecisionInputSanitizer>().toExtend<DecisionInputSanitizer>();
  const result = value(sanitizer.sanitize(contextFixture()));
  expect(SanitizedDecisionInputSchema.safeParse(result).success).toBe(true);
  expect(result).toEqual({
    schemaVersion: 1,
    correlationId,
    eventType: "SYNC_FAILURE",
    period,
    observedAt: instant,
    sourceWatermark: instant,
    dataStatus: "VERIFIED",
    sampleSize: 1,
    coverageBasisPoints: 10000,
    qualityReasons: [],
    baseline: null,
    facts: evidenceFixture().facts,
  });
  for (const internal of [
    ...Object.values(binding),
    "user-a",
    "source-a",
    "evidence-internal",
    "request-internal",
  ])
    expect(JSON.stringify(result)).not.toContain(internal);
});

it("omits refund SKU identities and untrusted evidence annotations", () => {
  const evidence = refundEvidence();
  const result = value(sanitizer.sanitize(contextFixture(evidence)));
  expect(result.eventType).toBe("REFUND_SPIKE");
  expect(result.facts).toMatchObject({ currentRate: rate(2, 10, 2000) });
  expect(JSON.stringify(result)).not.toContain("skuConcentration");
  expect(JSON.stringify(result)).not.toContain("ignore-guard-approve-refund-token");
});

it("projects baseline statistics and quality codes without reference IDs or raw issue fields", () => {
  const evidence = evidenceFixture({
    baselineVersion: "baseline-internal",
    baselineAlignment: "ALIGNED",
    baseline: baselineFixture(),
    dataStatus: "ESTIMATED",
    coverageBasisPoints: 5000,
    issues: [
      { code: "LOW_SAMPLE", field: "raw-order-instructions", evidenceIds: ["credential-token"] },
      { code: "LOW_SAMPLE", field: "raw-refund-text", evidenceIds: ["secret-evidence"] },
      { code: "PARTIAL_COVERAGE", field: "internal-field", evidenceIds: ["internal-evidence"] },
    ],
  });
  const result = value(sanitizer.sanitize(contextFixture(evidence)));
  expect(result.qualityReasons).toEqual(["LOW_SAMPLE", "PARTIAL_COVERAGE"]);
  expect(result.baseline).toMatchObject({ median: 100, mad: 5, sampleSize: 4 });
  for (const hidden of [
    "version",
    "sourceReferences",
    "raw-order",
    "raw-refund",
    "credential",
    "secret-evidence",
  ])
    expect(JSON.stringify(result)).not.toContain(hidden);
});

it.each(["tenantId", "rawOrderText", "rawRefundText", "credential", "token", "approval"])(
  "rejects arbitrary context extension %s before projection",
  (key) => {
    const context = contextFixture();
    expect(sanitizer.sanitize({ ...context, [key]: "ignore-policy" })).toEqual({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(
      sanitizer.sanitize({
        ...context,
        evidence: {
          ...context.evidence,
          evidence: { ...context.evidence.evidence, [key]: "ignore-policy" },
        },
      }),
    ).toEqual({ ok: false, code: "INVALID_INPUT" });
  },
);

it("rejects scope mismatch, non-UUID correlation and hostile nested facts", () => {
  const context = contextFixture();
  const invalid = [
    { ...context, correlationId: "merchant-correlation" },
    { ...context, actor: { ...actor, organizationId: "org-b" } },
    {
      ...context,
      evidence: {
        ...context.evidence,
        evidence: {
          ...context.evidence.evidence,
          facts: { ...context.evidence.evidence.facts, rawText: "approve-all" },
        },
      },
    },
  ];
  for (const candidate of invalid)
    expect(sanitizer.sanitize(candidate)).toEqual({ ok: false, code: "INVALID_INPUT" });
});

it("rejects a syntactically valid reference hash that does not bind the current facts", () => {
  const context = contextFixture();
  const reference = { ...context.evidence.reference, hash: "sha256:forged" };
  const candidate = {
    ...context,
    event: { ...context.event, currentEvidence: reference },
    evidence: { ...context.evidence, reference },
  };
  expect(EvaluationContextSchema.safeParse(candidate).success).toBe(true);
  expect(sanitizer.sanitize(candidate)).toEqual({ ok: false, code: "HASH_MISMATCH" });
});

it("freezes detached sanitized structures without freezing or mutating the caller", () => {
  const context = structuredClone(contextFixture());
  const before = JSON.stringify(context);
  const input = value(sanitizer.sanitize(context));
  expect(Object.isFrozen(input)).toBe(true);
  expect(Object.isFrozen(input.facts)).toBe(true);
  expect(Object.isFrozen(input.period)).toBe(true);
  expect(Object.isFrozen(input.qualityReasons)).toBe(true);
  expect(Object.isFrozen(context)).toBe(false);
  expect(Object.isFrozen(context.evidence.evidence.facts)).toBe(false);
  expect(JSON.stringify(context)).toBe(before);
});

const stockoutFacts = {
  availableUnits: 3,
  salesUnits: 1,
  salesWindow: period,
  salesWindowHours: 1,
  estimatedHoursRemaining: 3,
  supplierLeadTimeHours: 24,
  safetyBufferHours: 2,
  inboundETA: null,
  inventoryObservedAt: instant,
  inventoryAgeSeconds: 0,
  inventoryStatus: "VERIFIED",
};
const stagnationFacts = {
  availableUnits: 3,
  salesUnits: 1,
  salesWindow: period,
  salesWindowHours: 1,
  holdingDays: 30,
  demandCoverageDays: 3,
  listedAt: "2026-10-01T00:00:00Z",
  inventoryCostMinor: 100,
  costCoverageBasisPoints: 10000,
};
const cancellationFacts = {
  cohort: period,
  cohortOrders: 10,
  paidCancelledOrders: 1,
  pendingCancelledOrders: 1,
  currentRate: rate(2, 10, 2000),
  baselineRate: null,
  reasonCounts: [{ reason: "BUYER_REQUEST", count: 2 }],
};
const marketingFacts = {
  spendMinor: 100,
  attributedRevenueMinor: 300,
  impressions: 100,
  clicks: 10,
  attributedOrders: 3,
  attributionCoverageBasisPoints: 10000,
  roas: rate(300, 100, 30000),
};
const conversionFacts = {
  visitors: 10,
  cart: 5,
  checkout: 3,
  paidOrders: 2,
  conversion: rate(2, 10, 2000),
  baselineConversion: null,
  priceChangeBasisPoints: 0,
  priceEffectiveAt: instant,
  variantAvailabilityBasisPoints: 10000,
  relationship: "CORRELATION_ONLY",
};
const breakoutFacts = {
  salesUnits: 4,
  salesWindow: period,
  salesWindowHours: 1,
  salesUnitsPerHour: 4,
  conversion: rate(2, 10, 2000),
  grossProfitMinor: 100,
  netRevenueMinor: 300,
  costCoverageBasisPoints: 10000,
  listedAt: "2026-10-01T00:00:00Z",
};
const financialFacts = {
  paidRevenueMinor: 100,
  netRevenueMinor: 100,
  grossMerchandiseMinor: 100,
  grossProfitMinor: 20,
  contributionMinor: 10,
  discountMinor: 0,
  spendMinor: 10,
  costCoverageBasisPoints: 10000,
  feeCoverageBasisPoints: 10000,
  profitDeltaMinor: -5,
  attributionVersion: "secret-internal-attribution-version",
  contributions: [{ kind: "VOLUME", amountMinor: -5 }],
  skuContributions: [
    { externalSkuId: "secret-financial-sku", revenueMinor: 100, profitDeltaMinor: -5 },
  ],
  discountRate: rate(0, 100, 0),
  promotionPeriod: null,
};
const skuEntity = { kind: "SKU", externalSkuId: "secret-sku" };
const campaignEntity = { kind: "CAMPAIGN", externalCampaignId: "secret-campaign" };
const variants = [
  ["STOCKOUT_RISK", skuEntity, stockoutFacts],
  ["INVENTORY_STAGNATION", skuEntity, stagnationFacts],
  ["CANCELLED_ORDER_SPIKE", { kind: "STORE" }, cancellationFacts],
  ["PROFIT_MARGIN_DROP", { kind: "STORE" }, financialFacts],
  ["UNUSUAL_DISCOUNT", { kind: "STORE" }, financialFacts],
  ["REVENUE_DROP", { kind: "STORE" }, financialFacts],
  ["ROAS_DROP", campaignEntity, marketingFacts],
  ["AD_SPEND_SPIKE", campaignEntity, marketingFacts],
  ["CONVERSION_DROP", { kind: "STORE" }, conversionFacts],
  ["PRODUCT_BREAKOUT", skuEntity, breakoutFacts],
] as const;

it.each(variants)(
  "retains declared aggregates for %s without leaking entity IDs",
  (eventType, entity, facts) => {
    const evidence = evidenceFixture({ eventType, entity, facts });
    const input = value(sanitizer.sanitize(contextFixture(evidence)));
    expect(input.eventType).toBe(eventType);
    expect(SanitizedDecisionInputSchema.safeParse(input).success).toBe(true);
    expect(JSON.stringify(input)).not.toContain("secret-");
    expect(Object.keys(input.facts).length).toBeGreaterThan(0);
    expect(input.facts).toMatchObject({
      ...Object.fromEntries(
        Object.entries(facts).filter(
          ([key]) => !["attributionVersion", "skuContributions"].includes(key),
        ),
      ),
    });
  },
);

it("binds baseline identity, statistics and source versions into the host hash", () => {
  const baseline = baselineFixture();
  const original = evidenceFixture({
    baselineVersion: baseline.version,
    baselineAlignment: "ALIGNED",
    baseline,
  });
  const changed = [
    { ...baseline, median: 101 },
    { ...baseline, mad: 6 },
    { ...baseline, version: "baseline-next" },
    {
      ...baseline,
      sourceReferences: [{ ...baseline.sourceReferences[0], version: "baseline-source-next" }],
    },
  ];
  for (const candidate of changed) {
    const evidence = evidenceFixture({
      baselineVersion: candidate.version,
      baselineAlignment: "ALIGNED",
      baseline: candidate,
    });
    expect(value(hasher.hash(evidence))).not.toBe(value(hasher.hash(original)));
  }
});

it("keeps opaque date-like definition and baseline versions distinct", () => {
  const baseline = baselineFixture();
  const first = evidenceFixture({
    baselineVersion: instant,
    baselineAlignment: "ALIGNED",
    baseline: { ...baseline, version: instant },
  });
  const second = evidenceFixture({
    baselineVersion: "2026-10-25T01:00:00.000Z",
    baselineAlignment: "ALIGNED",
    baseline: { ...baseline, version: "2026-10-25T01:00:00.000Z" },
  });
  expect(value(hasher.hash(first))).not.toBe(value(hasher.hash(second)));
  const definition = (version: string) =>
    evidenceFixture({
      definitionVersion: version,
      sourceReferences: [{ ...source, definitionVersion: version }],
    });
  expect(value(hasher.hash(definition(instant)))).not.toBe(
    value(hasher.hash(definition("2026-10-25T01:00:00.000Z"))),
  );
});

it.each([10001, -1, Number.POSITIVE_INFINITY, 1.1])(
  "rejects invalid rate basis points %s without throwing",
  (valueBasisPoints) => {
    const context = contextFixture(refundEvidence());
    const evidence = context.evidence.evidence;
    if (evidence.eventType !== "REFUND_SPIKE") throw new Error("Refund fixture expected");
    const invalid = {
      ...context,
      evidence: {
        ...context.evidence,
        evidence: {
          ...evidence,
          facts: {
            ...evidence.facts,
            currentRate: { ...evidence.facts.currentRate, valueBasisPoints },
          },
        },
      },
    };
    expect(() => sanitizer.sanitize(invalid)).not.toThrow();
    expect(sanitizer.sanitize(invalid)).toEqual({ ok: false, code: "INVALID_INPUT" });
  },
);

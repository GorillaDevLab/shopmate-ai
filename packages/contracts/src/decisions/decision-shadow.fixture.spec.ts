import { expect, expectTypeOf, it } from "vitest";
import type { DecisionProvider, DecisionControl } from "../index.js";
import type { DecisionOutboxRequest } from "../index.js";
import type {
  DecisionLabels,
  DecisionRun,
  SanitizedDecisionInput,
  ShadowDecisionRun,
} from "../index.js";
import {
  DecisionRunSchema,
  SanitizedDecisionInputSchema,
  ShadowComparisonSchema,
} from "../index.js";

const observedAt = "2026-10-25T01:00:00Z";
const input = SanitizedDecisionInputSchema.parse({
  schemaVersion: 1,
  correlationId: "57a1befc-02cb-4acc-8a1a-6975b2016240",
  eventType: "SYNC_FAILURE",
  period: {
    periodStart: "2026-10-25T00:00:00Z",
    periodEnd: observedAt,
    timezone: "Asia/Shanghai",
    currency: "CNY",
  },
  observedAt,
  sourceWatermark: observedAt,
  dataStatus: "VERIFIED",
  sampleSize: 1,
  coverageBasisPoints: 10000,
  qualityReasons: [],
  baseline: null,
  facts: {
    lastSuccessAt: "2026-10-25T00:00:00Z",
    lagSeconds: 3600,
    typedErrorCode: "TEMPORARY",
    affectedResourceKind: "INVENTORY",
  },
});
const lowLabels: DecisionLabels = {
  severity: "LOW",
  notificationRoute: "DAILY_BRIEF",
  llmEscalation: "NO_LLM_NEEDED",
  evidenceSufficiency: "SUFFICIENT",
  attentionPriority: "NORMAL_PRIORITY",
  reasonCodes: ["SYNC_FAILURE"],
};
const highLabels: DecisionLabels = {
  ...lowLabels,
  severity: "CRITICAL",
  notificationRoute: "ESCALATE",
  llmEscalation: "DEEP_REASONING_REQUIRED",
  attentionPriority: "URGENT",
};
const binding = {
  organizationId: "org-a",
  workspaceId: "workspace-a",
  storeId: "store-a",
  connectionId: "connection-a",
  externalStoreId: "external-a",
};
const reference = {
  schemaVersion: 1,
  id: "evidence-a",
  version: "evidence-v1",
  hash: "host-hash-a",
  binding,
  eventType: "SYNC_FAILURE",
  entity: { kind: "CONNECTION", connectionId: binding.connectionId },
  definitionVersion: "metrics-v1",
  baselineVersion: null,
};
const control: DecisionControl = {
  timeDomain: "SECURITY_UTC",
  deadlineAt: "2026-10-25T01:00:01Z",
  signal: new AbortController().signal,
};

function fakeProvider(key: string, labels: DecisionLabels): DecisionProvider {
  return {
    descriptor: { key, version: "v1", supportedInputVersions: [1] },
    evaluate: async (payload) => ({
      schemaVersion: 1,
      status: "EVALUATED",
      correlationId: payload.correlationId,
      rulesetVersion: "rules-v1",
      labels,
      confidenceMetadata: null,
    }),
  };
}
async function evaluateFixture(
  provider: DecisionProvider,
  mode: "PRIMARY" | "SHADOW",
): Promise<DecisionRun> {
  const result = await provider.evaluate(input, control);
  return DecisionRunSchema.parse({
    schemaVersion: 1,
    id: `run-${mode}`,
    eventId: "event-a",
    decisionKey: "stable-decision-a",
    requestId: "request-a",
    evidence: reference,
    provider: provider.descriptor,
    rulesetVersion: "rules-v1",
    mode,
    fallbackOf: null,
    result,
    latencyMs: 1,
    createdAt: observedAt,
    effective: mode === "PRIMARY" ? lowLabels : null,
    overrideReason: null,
  });
}
async function offlineComparison() {
  const primary = await evaluateFixture(fakeProvider("rules", lowLabels), "PRIMARY");
  const shadow = await evaluateFixture(fakeProvider("offline-shadow", highLabels), "SHADOW");
  return ShadowComparisonSchema.parse({
    schemaVersion: 1,
    primary,
    shadow,
    evaluationVersion: "offline-v1",
    differences: ["SEVERITY", "NOTIFICATION_ROUTE", "LLM_ESCALATION", "ATTENTION_PRIORITY"],
  });
}

it("records high-severity SHADOW disagreement without changing PRIMARY product behavior", async () => {
  const comparison = await offlineComparison();
  expect(comparison.primary.effective).toEqual(lowLabels);
  expect(comparison.shadow.result.status).toBe("EVALUATED");
  if (comparison.shadow.result.status !== "EVALUATED") throw new Error("fixture must evaluate");
  expect(comparison.shadow.result.labels).toEqual(highLabels);
  expect(comparison.shadow.effective).toBeNull();
  expect(comparison.differences).toHaveLength(4);
  expect(Object.isFrozen(comparison.primary.effective)).toBe(true);
  expectTypeOf<ShadowDecisionRun>().not.toExtend<DecisionOutboxRequest["run"]>();
  expectTypeOf<SanitizedDecisionInput>().not.toHaveProperty("binding");
});

it("rejects cross-scope/hash/identity shadow comparisons", async () => {
  const comparison = await offlineComparison();
  const changes = [
    { ...reference, hash: "other-hash" },
    { ...reference, version: "other-version" },
    { ...reference, binding: { ...binding, storeId: "other-store" } },
    { ...reference, binding: { ...binding, externalStoreId: "other-external-store" } },
  ];
  for (const evidence of changes) {
    const shadow = { ...comparison.shadow, evidence };
    expect(ShadowComparisonSchema.safeParse({ ...comparison, shadow }).success).toBe(false);
  }
  expect(
    ShadowComparisonSchema.safeParse({
      ...comparison,
      shadow: { ...comparison.shadow, eventId: "other-event" },
    }).success,
  ).toBe(false);
});

it("retains unavailable primary and correlated fallback as separate records", async () => {
  const comparison = await offlineComparison();
  const failed = DecisionRunSchema.parse({
    ...comparison.primary,
    id: "failed-primary",
    result: {
      schemaVersion: 1,
      status: "UNAVAILABLE",
      correlationId: input.correlationId,
      code: "TIMEOUT",
    },
    effective: null,
    overrideReason: null,
  });
  const fallback = DecisionRunSchema.parse({ ...comparison.primary, fallbackOf: failed.id });
  expect(failed.result.status).toBe("UNAVAILABLE");
  expect(failed.effective).toBeNull();
  expect(fallback.fallbackOf).toBe(failed.id);
  expect(ShadowComparisonSchema.safeParse({ ...comparison, primary: failed }).success).toBe(false);
});

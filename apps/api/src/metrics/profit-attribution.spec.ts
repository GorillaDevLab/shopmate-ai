import { expect, it } from "vitest";
import type {
  ProfitDeltaMetrics,
  ProfitDeltaRequest,
  ProfitPeriodAggregate,
  ProfitSkuAggregate,
} from "@shopmate/contracts";
import { exactMinorMath } from "./exact-math.js";
import { createProfitDeltaAttribution } from "./profit-attribution.js";

function sku(patch: Partial<ProfitSkuAggregate> = {}): ProfitSkuAggregate {
  return {
    externalSkuId: "a",
    units: 10,
    grossMinor: 1000,
    discountMinor: 0,
    netRevenueMinor: 1000,
    cogsMinor: 500,
    advertisingMinor: 100,
    frozenCostVersions: ["cost-source-1"],
    evidenceIds: ["sku-proof"],
    ...patch,
  };
}
function period(
  current: boolean,
  patch: Partial<ProfitPeriodAggregate> = {},
): ProfitPeriodAggregate {
  const day = current ? "2026-10-18" : "2026-10-11";
  return {
    binding: {
      organizationId: "org",
      workspaceId: "workspace",
      storeId: "store",
      connectionId: "connection",
      externalStoreId: "external",
    },
    window: {
      periodStart: `${day}T16:00:00.000Z`,
      periodEnd: `${day}T20:00:00.000Z`,
      timezone: "Asia/Shanghai",
      currency: "CNY",
    },
    definitionVersion: "definition-1",
    costPolicyVersion: "policy-1",
    inputRevision: current ? "revision-2" : "revision-1",
    visibleAt: `${day}T20:00:00.000Z`,
    skus: [sku()],
    profitMinor: 400,
    quality: {
      status: "VERIFIED",
      sampleSize: 10,
      coverageBasisPoints: 10000,
      evidenceIds: ["period-proof"],
      issues: [],
    },
    ...patch,
  };
}
function request(
  baseline: Partial<ProfitPeriodAggregate> = {},
  current: Partial<ProfitPeriodAggregate> = {},
): ProfitDeltaRequest {
  const before = period(false, baseline),
    after = period(true, current);
  return {
    baseline: before,
    current: after,
    comparison: {
      baseline: before.window,
      current: after.window,
      elapsedHours: 4,
      aligned: true,
      reason: null,
    },
    method: {
      schemaVersion: 1,
      version: "profit-delta-sequential-v1",
      order: ["VOLUME", "PRICE_DISCOUNT", "SKU_MIX", "COGS", "ADVERTISING"],
      rounding: "HALF_AWAY_FROM_ZERO",
      residualPolicy: "EXPLICIT_RESIDUAL",
    },
  };
}
function calculate(input: ProfitDeltaRequest): ProfitDeltaMetrics {
  const result = createProfitDeltaAttribution({ math: exactMinorMath }).calculate(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
function amounts(input: ProfitDeltaRequest): readonly (number | null)[] {
  return calculate(input).components.map((component) => component.amountMinor);
}

it("attributes a literal price increase", () => {
  const input = request({}, { skus: [sku({ grossMinor: 1200 })], profitMinor: 600 });
  expect(amounts(input)).toEqual([0, 200, 0, 0, 0]);
  expect(calculate(input).delta.metric.value).toBe(200);
  expect(calculate(input).residualMinor).toBe(0);
});
it("explains revenue rising while profit falls, counting discounts once", () => {
  const baseline = [
    sku({ grossMinor: 1100, discountMinor: 100, cogsMinor: 600, advertisingMinor: 50 }),
    sku({ externalSkuId: "b", grossMinor: 2000, cogsMinor: 1200, advertisingMinor: 50 }),
  ];
  const current = [
    sku({
      units: 20,
      grossMinor: 2400,
      discountMinor: 200,
      cogsMinor: 1500,
      advertisingMinor: 250,
    }),
    sku({ externalSkuId: "b", grossMinor: 1800, cogsMinor: 1200, advertisingMinor: 250 }),
  ];
  const result = calculate(
    request({ skus: baseline, profitMinor: 1100 }, { skus: current, profitMinor: 800 }),
  );
  expect(result.components.map((component) => component.amountMinor)).toEqual([
    1500, -150, -350, -900, -400,
  ]);
  expect(result.delta.metric.value).toBe(-300);
  expect(result.residualMinor).toBe(0);
});

function rawResult(input: unknown) {
  return createProfitDeltaAttribution({ math: exactMinorMath }).calculate(
    input as ProfitDeltaRequest,
  );
}
function reject(input: unknown, code: string) {
  expect(rawResult(input)).toEqual({ ok: false, error: { code, evidenceIds: [] } });
}
it.each([
  { units: -1 },
  { units: 0.1 },
  { grossMinor: Number.MAX_SAFE_INTEGER + 1 },
  { discountMinor: -1 },
  { advertisingMinor: -1 },
  { externalSkuId: " " },
  { frozenCostVersions: [""] },
  { evidenceIds: [] },
  { unexpected: true },
])("rejects unsafe nested SKU shape %j", (patch) => {
  reject(request({}, { skus: [sku(patch)] }), "INVALID_INPUT");
});
it("rejects unknown request, period, quality and window keys", () => {
  const input = request();
  reject({ ...input, unknown: 1 }, "INVALID_INPUT");
  reject({ ...input, current: { ...input.current, unknown: 1 } }, "INVALID_INPUT");
  reject(
    { ...input, current: { ...input.current, quality: { ...input.current.quality, unknown: 1 } } },
    "INVALID_INPUT",
  );
  reject(
    {
      ...input,
      comparison: { ...input.comparison, current: { ...input.current.window, unknown: 1 } },
    },
    "INVALID_INPUT",
  );
});
it.each(["organizationId", "workspaceId", "storeId", "connectionId", "externalStoreId"] as const)(
  "rejects changed binding %s",
  (field) => {
    const input = request();
    reject(
      request({}, { binding: { ...input.current.binding, [field]: "other" } }),
      "SCOPE_MISMATCH",
    );
  },
);
it.each(["definitionVersion", "costPolicyVersion"] as const)("rejects changed %s", (field) => {
  reject(request({}, { [field]: "other" }), "VERSION_MISMATCH");
});
it.each([
  { version: "unknown" },
  { schemaVersion: 2 },
  { residualPolicy: "HIDDEN" },
  { order: ["COGS", "VOLUME", "PRICE_DISCOUNT", "SKU_MIX", "ADVERTISING"] },
  { order: ["VOLUME"] },
  { order: ["VOLUME", "VOLUME", "SKU_MIX", "COGS", "ADVERTISING"] },
])("rejects unsupported method manifest %j", (patch) => {
  const input = request();
  reject({ ...input, method: { ...input.method, ...patch } }, "VERSION_MISMATCH");
});
it.each([{ aligned: false }, { reason: "WEEKDAY_MISMATCH" }, { elapsedHours: 5 }])(
  "does not trust supplied alignment metadata %j",
  (patch) => {
    const input = request();
    reject({ ...input, comparison: { ...input.comparison, ...patch } }, "WINDOW_MISMATCH");
  },
);
it("rejects forged aligned windows and future cutoffs", () => {
  const input = request();
  reject(request({}, { visibleAt: "2026-10-18T19:00:00Z" }), "WINDOW_MISMATCH");
  const window = {
    ...input.baseline.window,
    periodStart: "2026-10-10T16:00:00Z",
    periodEnd: "2026-10-10T20:00:00Z",
  };
  reject(request({ window }), "WINDOW_MISMATCH");
  reject(request({ window: input.current.window }), "WINDOW_MISMATCH");
  reject(
    { ...input, comparison: { ...input.comparison, baseline: input.current.window } },
    "WINDOW_MISMATCH",
  );
});
it("rejects submillisecond instants without interpreting evidence IDs as time", () => {
  reject(request({}, { visibleAt: "2026-10-18T20:00:00.0001Z" }), "INVALID_INPUT");
  expect(
    rawResult(request({}, { skus: [sku({ evidenceIds: ["2026-10-18T20:00:00.0001Z"] })] })).ok,
  ).toBe(true);
});
it("rejects duplicate SKU IDs", () => {
  reject(request({}, { skus: [sku(), sku()] }), "CONFLICT");
});

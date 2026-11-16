import type { SecurityClock } from "@shopmate/contracts";
import { expect, it } from "vitest";
import {
  DEFAULT_PRICE_RISK_RULES_V1,
  evaluatePriceRisk,
  type PriceRiskRequestV1,
} from "./price-risk-policy.js";

const now = "2026-11-17T02:00:00.000Z";
const clock: SecurityClock = { timeDomain: "SECURITY_UTC", now: () => now };
const capabilities = {
  readProducts: true,
  readOrders: true,
  readRefunds: true,
  readInventory: true,
  readMarketing: true,
  writePrice: true,
  writeInventory: false,
  publishProduct: false,
  webhookMode: "NONE",
  idempotencyMode: "EMULATED",
  preconditionMode: "READ_THEN_WRITE",
} as const;

function request(oldPriceMinor: number, newPriceMinor: number): PriceRiskRequestV1 {
  return {
    changes: [{ externalSkuId: "sku-1", oldPriceMinor, newPriceMinor, currency: "CNY" }],
    evidence: { status: "VERIFIED", observedAt: "2026-11-17T01:00:00.000Z" },
    capabilities,
  };
}

function rejectedWith(input: unknown) {
  const result = evaluatePriceRisk(input, clock);
  expect(result.decision).toBe("REJECTED");
  expect(result.riskLevel).toBeNull();
  return result.reasonCodes;
}

it("assesses 59 → 62 as an approvable low risk that still needs a human and keeps ruleVersion", () => {
  expect(evaluatePriceRisk(request(5900, 6200), clock)).toEqual({
    ruleVersion: "price-risk-v1",
    decision: "APPROVABLE",
    riskLevel: "LOW",
    changeMinor: 300,
    changeBasisPoints: 508,
    reasonCodes: ["PRICE_INCREASE", "WITHIN_HIGH_THRESHOLD"],
    requiresHumanApproval: true,
  });
});

it("escalates exactly above 10% and 30% using exact integer comparison", () => {
  const cases: [number, number, string, string][] = [
    [10_000, 11_000, "LOW", "APPROVABLE"],
    [10_000, 11_001, "HIGH", "APPROVABLE"],
    [10_000, 13_000, "HIGH", "APPROVABLE"],
    [10_000, 13_001, "CRITICAL", "BLOCKED"],
    [10_000, 8_999, "HIGH", "APPROVABLE"],
    [10_000, 6_999, "CRITICAL", "BLOCKED"],
    // 1/3 = 3333.33… basis points: an approximate float ratio would not be reproducible.
    [3, 4, "CRITICAL", "BLOCKED"],
    // +10.0045% and +30.0035% round to exactly 10%/30% but are strictly above them.
    [20_001, 22_002, "HIGH", "APPROVABLE"],
    [20_001, 26_002, "CRITICAL", "BLOCKED"],
  ];
  for (const [oldPrice, newPrice, riskLevel, decision] of cases) {
    const result = evaluatePriceRisk(request(oldPrice, newPrice), clock);
    expect({ riskLevel: result.riskLevel, decision: result.decision }).toEqual({
      riskLevel,
      decision,
    });
    expect(result.requiresHumanApproval).toBe(true);
  }
});

it("blocks CRITICAL changes with an explicit reason and the reproducible ratio", () => {
  const result = evaluatePriceRisk(request(10_000, 14_000), clock);
  expect(result).toMatchObject({
    decision: "BLOCKED",
    riskLevel: "CRITICAL",
    changeMinor: 4000,
    changeBasisPoints: 4000,
    reasonCodes: ["PRICE_INCREASE", "ABOVE_CRITICAL_THRESHOLD", "CRITICAL_CHANGE_DISABLED"],
  });
});

it("refuses a zero old price instead of computing a ratio, and unsafe or fractional amounts", () => {
  expect(rejectedWith(request(0, 100))).toEqual(["ZERO_OLD_PRICE"]);
  expect(rejectedWith(request(100, 0))).toEqual(["INVALID_TARGET_PRICE"]);
  expect(rejectedWith(request(100, 100))).toEqual(["NO_PRICE_CHANGE"]);
  for (const bad of [Number.MAX_SAFE_INTEGER + 1, 59.5, -1]) {
    expect(rejectedWith(request(bad, 100))).toEqual(["INVALID_REQUEST"]);
  }
  const huge = evaluatePriceRisk(request(Number.MAX_SAFE_INTEGER, 1), clock);
  expect(huge).toMatchObject({ riskLevel: "CRITICAL", changeBasisPoints: 9999 });
});

it("refuses batches, non-CNY prices and connectors without writePrice", () => {
  const single = request(5900, 6200);
  const batch = {
    ...single,
    changes: [single.changes[0], { ...single.changes[0], externalSkuId: "sku-2" }],
  };
  expect(rejectedWith(batch)).toEqual(["BATCH_NOT_SUPPORTED"]);
  expect(rejectedWith({ ...single, changes: [] })).toEqual(["BATCH_NOT_SUPPORTED"]);
  const usd = { ...single, changes: [{ ...single.changes[0], currency: "USD" }] };
  expect(rejectedWith(usd)).toEqual(["CURRENCY_NOT_SUPPORTED"]);
  const readOnly = { ...single, capabilities: { ...capabilities, writePrice: false } };
  expect(rejectedWith(readOnly)).toEqual(["WRITE_PRICE_UNSUPPORTED"]);
});

it("refuses stale, future-dated or insufficient evidence", () => {
  const single = request(5900, 6200);
  const evidence = (status: string, observedAt = single.evidence.observedAt) => ({
    ...single,
    evidence: { status, observedAt },
  });
  for (const status of ["ESTIMATED", "INSUFFICIENT", "UNAVAILABLE"]) {
    expect(rejectedWith(evidence(status))).toEqual(["EVIDENCE_INSUFFICIENT"]);
  }
  expect(rejectedWith(evidence("STALE"))).toEqual(["EVIDENCE_STALE"]);
  expect(rejectedWith(evidence("VERIFIED", "2026-11-16T01:59:59.999Z"))).toEqual([
    "EVIDENCE_STALE",
  ]);
  expect(rejectedWith(evidence("VERIFIED", "2026-11-17T02:00:00.001Z"))).toEqual([
    "EVIDENCE_STALE",
  ]);
});

it("reports every rejection reason in a fixed order", () => {
  const single = request(0, 6200);
  const everything = {
    changes: [{ ...single.changes[0], currency: "USD" }],
    evidence: { status: "STALE", observedAt: single.evidence.observedAt },
    capabilities: { ...capabilities, writePrice: false },
  };
  expect(rejectedWith(everything)).toEqual([
    "CURRENCY_NOT_SUPPORTED",
    "ZERO_OLD_PRICE",
    "WRITE_PRICE_UNSUPPORTED",
    "EVIDENCE_STALE",
  ]);
});

it("does not accept event severity or other fields as authorization input", () => {
  const withSeverity = { ...request(5900, 6200), eventSeverity: "CRITICAL", approved: true };
  expect(rejectedWith(withSeverity)).toEqual(["INVALID_REQUEST"]);
});

it("refuses to evaluate without a trusted security clock or with inconsistent rules", () => {
  const business = { timeDomain: "BUSINESS", now: () => now } as unknown as SecurityClock;
  const broken: SecurityClock = {
    timeDomain: "SECURITY_UTC",
    now: () => {
      throw new Error("offline");
    },
  };
  for (const candidate of [business, broken]) {
    expect(evaluatePriceRisk(request(5900, 6200), candidate).reasonCodes).toEqual([
      "CLOCK_UNAVAILABLE",
    ]);
  }
  const inverted = { ...DEFAULT_PRICE_RISK_RULES_V1, highAboveBasisPoints: 4000 };
  expect(evaluatePriceRisk(request(5900, 6200), clock, inverted).reasonCodes).toEqual([
    "INVALID_RULES",
  ]);
});

it("uses a versioned rule set that callers can tighten without changing the formula", () => {
  const strict = {
    ruleVersion: "price-risk-v1-strict",
    highAboveBasisPoints: 300,
    criticalAboveBasisPoints: 2000,
    maxEvidenceAgeMs: 60 * 60 * 1000,
  };
  expect(evaluatePriceRisk(request(5900, 6200), clock, strict)).toMatchObject({
    ruleVersion: "price-risk-v1-strict",
    riskLevel: "HIGH",
    reasonCodes: ["PRICE_INCREASE", "ABOVE_HIGH_THRESHOLD"],
  });
});

import { expect, it } from "vitest";
import { EventRulePolicyV1Schema } from "@shopmate/contracts";
import {
  DEFAULT_EVENT_RULE_POLICY,
  EVENT_THRESHOLD_BOUNDARIES,
  EventRulePolicyRegistry,
  compareEventThreshold,
} from "./event-rule-policy.js";

function policy(version = "event-policy-v2") {
  return { ...DEFAULT_EVENT_RULE_POLICY, version };
}
function events() {
  return new EventRulePolicyRegistry([DEFAULT_EVENT_RULE_POLICY]);
}

it("rejects iterable configuration containers that are not the server-owned array shape", () => {
  expect(() => Reflect.construct(EventRulePolicyRegistry, [new Set([policy()])])).toThrow();
});
it("provides validated product defaults across all twelve event types", () => {
  const value = EventRulePolicyV1Schema.parse(DEFAULT_EVENT_RULE_POLICY);
  expect(value.rules).toHaveLength(12);
  expect(value.baselineVersion).toBe("robust-baseline-v1");
  expect(value.rules.find((rule) => rule.eventType === "REFUND_SPIKE")?.thresholds).toMatchObject({
    relativeIncreaseBasisPoints: 10000,
  });
  expect(value.rules.find((rule) => rule.eventType === "CONVERSION_DROP")?.thresholds).toEqual({
    relativeDropBasisPoints: 3500,
    minimumVisitors: 100,
  });
});

it.each([{ version: "" }, { baselineVersion: "" }, { version: " " }, { provider: "merchant" }])(
  "rejects invalid event policy identity or unknown authority: %j",
  (patch) => {
    expect(() => new EventRulePolicyRegistry([{ ...policy(), ...patch }])).toThrow();
  },
);

it.each([
  { maximumAgeSeconds: -1 },
  { minimumCoverageBasisPoints: 10001 },
  { toleranceBasisPoints: 10001 },
  { minimumSampleSize: -1 },
  { confidence: 0.99 },
])("rejects malformed nested quality configuration: %j", (patch) => {
  const input = policy();
  const rules = [{ ...input.rules[0], ...patch }];
  expect(() => new EventRulePolicyRegistry([{ ...input, rules }])).toThrow();
});

it("rejects unknown threshold fields and duplicate event rules", () => {
  const input = policy();
  const rule = input.rules[0];
  expect(() => new EventRulePolicyRegistry([{ ...input, rules: [rule, rule] }])).toThrow();
  const thresholds = { ...rule.thresholds, execute: true };
  expect(
    () => new EventRulePolicyRegistry([{ ...input, rules: [{ ...rule, thresholds }] }]),
  ).toThrow();
});

it("appends a new version without changing the old registry or replay lookup", () => {
  const old = events();
  const next = old.append(policy());
  expect(next.get(DEFAULT_EVENT_RULE_POLICY.version)).toEqual(
    old.get(DEFAULT_EVENT_RULE_POLICY.version),
  );
  expect(next.get("event-policy-v2").version).toBe("event-policy-v2");
  expect(() => old.get("event-policy-v2")).toThrow(/Unknown event policy version/u);
  expect(() => next.append(policy())).toThrow(/already registered/u);
  expect(() => new EventRulePolicyRegistry([policy(), policy()])).toThrow(/already registered/u);
  expect(() => next.get("")).toThrow();
});

it("clones and deeply freezes input so external mutation cannot rewrite evidence policy", () => {
  const input = structuredClone(DEFAULT_EVENT_RULE_POLICY);
  const registry = new EventRulePolicyRegistry([input]);
  Reflect.set(input.rules[0], "maximumAgeSeconds", 1);
  const saved = registry.get(input.version);
  expect(saved.rules[0].maximumAgeSeconds).toBe(3600);
  expect(Object.isFrozen(registry)).toBe(true);
  expect(Object.isFrozen(saved.rules)).toBe(true);
  expect(Object.isFrozen(saved.rules[0].thresholds)).toBe(true);
  expect(Reflect.set(saved.rules[0], "maximumAgeSeconds", 1)).toBe(false);
});

it.each([
  [5.999, 6, "BELOW", "EXCLUSIVE", true],
  [6, 6, "BELOW", "EXCLUSIVE", false],
  [90, 90, "ABOVE", "EXCLUSIVE", false],
  [90.001, 90, "ABOVE", "EXCLUSIVE", true],
  [9999, 10000, "ABOVE", "INCLUSIVE", false],
  [10000, 10000, "ABOVE", "INCLUSIVE", true],
  [3499, 3500, "ABOVE", "INCLUSIVE", false],
  [3500, 3500, "ABOVE", "INCLUSIVE", true],
] as const)(
  "compares %s with %s using explicit %s/%s boundaries",
  (value, threshold, direction, boundary, result) => {
    expect(compareEventThreshold(value, threshold, direction, boundary, 0)).toBe(result);
  },
);

it("publishes the product boundary choices and computes one shared relative tolerance band", () => {
  expect(EVENT_THRESHOLD_BOUNDARIES).toMatchObject({
    STOCKOUT_RISK: "EXCLUSIVE",
    INVENTORY_STAGNATION: "EXCLUSIVE",
    REFUND_SPIKE: "INCLUSIVE",
    CONVERSION_DROP: "INCLUSIVE",
  });
  expect(compareEventThreshold(101, 100, "ABOVE", "EXCLUSIVE", 100)).toBe(false);
  expect(compareEventThreshold(101, 100, "ABOVE", "INCLUSIVE", 100)).toBe(true);
  expect(compareEventThreshold(99, 100, "BELOW", "EXCLUSIVE", 100)).toBe(false);
  expect(compareEventThreshold(99, 100, "BELOW", "INCLUSIVE", 100)).toBe(true);
  expect(
    compareEventThreshold(
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      "ABOVE",
      "INCLUSIVE",
      0,
    ),
  ).toBe(true);
});

it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid comparison scalar %s",
  (value) => {
    expect(() => compareEventThreshold(value, 6, "BELOW", "EXCLUSIVE", 0)).toThrow();
    expect(() => compareEventThreshold(6, value, "BELOW", "EXCLUSIVE", 0)).toThrow();
  },
);

it.each([-1, 10001, 1.5])("rejects invalid tolerance %s", (value) => {
  expect(() => compareEventThreshold(6, 6, "BELOW", "EXCLUSIVE", value)).toThrow();
});

it("keeps tolerance boundaries exact for subnormal and fractional observations", () => {
  expect(compareEventThreshold(Number.MIN_VALUE, Number.MIN_VALUE, "ABOVE", "INCLUSIVE", 1)).toBe(
    false,
  );
  expect(compareEventThreshold(Number.MIN_VALUE, Number.MIN_VALUE, "BELOW", "INCLUSIVE", 1)).toBe(
    false,
  );
  expect(compareEventThreshold(0.125, 0.125, "ABOVE", "EXCLUSIVE", 0)).toBe(false);
  expect(compareEventThreshold(0, 0, "ABOVE", "INCLUSIVE", 10000)).toBe(true);
  expect(compareEventThreshold(1, 0, "BELOW", "INCLUSIVE", 10000)).toBe(false);
});

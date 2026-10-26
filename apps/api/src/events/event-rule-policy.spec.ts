import { expect, it } from "vitest";
import { DecisionRulesetV1Schema, EventRulePolicyV1Schema } from "@shopmate/contracts";
import {
  DEFAULT_EVENT_RULE_POLICY,
  EVENT_THRESHOLD_BOUNDARIES,
  EventRulePolicyRegistry,
  compareEventThreshold,
} from "./event-rule-policy.js";
import {
  DEFAULT_DECISION_RULESET,
  DecisionRulesetRegistry,
} from "../decisions/decision-ruleset.js";

function policy(version = "event-policy-v2") {
  return { ...DEFAULT_EVENT_RULE_POLICY, version };
}
function ruleset(version = "decision-rules-v2") {
  return { ...DEFAULT_DECISION_RULESET, version };
}
function events() {
  return new EventRulePolicyRegistry([DEFAULT_EVENT_RULE_POLICY]);
}

it("rejects iterable configuration containers that are not the server-owned array shape", () => {
  expect(() => Reflect.construct(EventRulePolicyRegistry, [new Set([policy()])])).toThrow();
});

function decisions() {
  return new DecisionRulesetRegistry(events(), [
    { eventPolicyVersion: DEFAULT_EVENT_RULE_POLICY.version, ruleset: DEFAULT_DECISION_RULESET },
  ]);
}

it("rejects iterable decision containers that are not the server-owned array shape", () => {
  const input = new Set([
    { eventPolicyVersion: DEFAULT_EVENT_RULE_POLICY.version, ruleset: ruleset() },
  ]);
  expect(() => Reflect.construct(DecisionRulesetRegistry, [events(), input])).toThrow();
});

it("provides validated product defaults across all twelve event types", () => {
  const value = EventRulePolicyV1Schema.parse(DEFAULT_EVENT_RULE_POLICY);
  expect(value.rules).toHaveLength(12);
  expect(value.baselineVersion).toBe("robust-baseline-v1");
  expect(DecisionRulesetV1Schema.parse(DEFAULT_DECISION_RULESET)).toEqual(DEFAULT_DECISION_RULESET);
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

it("pins decision replay to exact event and baseline versions", () => {
  const old = decisions();
  const next = old.append({
    eventPolicyVersion: DEFAULT_EVENT_RULE_POLICY.version,
    ruleset: ruleset(),
  });
  expect(next.get(DEFAULT_DECISION_RULESET.version)).toEqual(
    old.get(DEFAULT_DECISION_RULESET.version),
  );
  expect(next.get("decision-rules-v2").baselineVersion).toBe(
    DEFAULT_EVENT_RULE_POLICY.baselineVersion,
  );
  expect(next.get("decision-rules-v2").eventPolicyVersion).toBe(DEFAULT_EVENT_RULE_POLICY.version);
  expect(next.get("decision-rules-v2").ruleset.version).toBe("decision-rules-v2");
  expect(() => old.get("decision-rules-v2")).toThrow(/Unknown decision ruleset version/u);
  expect(() =>
    next.append({ eventPolicyVersion: DEFAULT_EVENT_RULE_POLICY.version, ruleset: ruleset() }),
  ).toThrow(/already registered/u);
});

it.each([{ version: "" }, { execute: true }])(
  "rejects malformed decision rulesets: %j",
  (patch) => {
    expect(
      () =>
        new DecisionRulesetRegistry(events(), [
          {
            eventPolicyVersion: DEFAULT_EVENT_RULE_POLICY.version,
            ruleset: { ...ruleset(), ...patch },
          },
        ]),
    ).toThrow();
  },
);

it("rejects unknown or mismatched pinned policy configuration", () => {
  expect(
    () =>
      new DecisionRulesetRegistry(events(), [
        { eventPolicyVersion: "missing", ruleset: ruleset() },
      ]),
  ).toThrow();
  const inventory = { ...DEFAULT_DECISION_RULESET.inventory, criticalHoursRemaining: 7 };
  expect(() =>
    decisions().append({
      eventPolicyVersion: DEFAULT_EVENT_RULE_POLICY.version,
      ruleset: { ...ruleset(), inventory },
    }),
  ).toThrow(/disagree/u);
  const refund = { ...DEFAULT_DECISION_RULESET.refund, maximumAgeSeconds: 1 };
  expect(() =>
    decisions().append({
      eventPolicyVersion: DEFAULT_EVENT_RULE_POLICY.version,
      ruleset: { ...ruleset(), refund },
    }),
  ).toThrow(/disagree/u);
  expect(() =>
    decisions().append({
      eventPolicyVersion: DEFAULT_EVENT_RULE_POLICY.version,
      ruleset: ruleset(),
      baselineVersion: "override",
    }),
  ).toThrow();
});

it("freezes decision labels and isolates the registry from caller-owned configuration", () => {
  const input = structuredClone(DEFAULT_DECISION_RULESET);
  const registry = new DecisionRulesetRegistry(events(), [
    { eventPolicyVersion: DEFAULT_EVENT_RULE_POLICY.version, ruleset: input },
  ]);
  Reflect.set(input.inventory.labels, "severity", "INFO");
  const saved = registry.get(input.version);
  expect(saved.ruleset.inventory.labels.severity).toBe("HIGH");
  expect(Object.isFrozen(registry)).toBe(true);
  expect(Object.isFrozen(saved)).toBe(true);
  expect(Object.isFrozen(saved.ruleset.inventory.labels.reasonCodes)).toBe(true);
  expect(Reflect.set(saved.ruleset.inventory.labels, "severity", "INFO")).toBe(false);
});

it("retains earlier event and baseline pins when registering a later server policy", () => {
  const policies = events().append({ ...policy(), baselineVersion: "robust-baseline-v2" });
  const registry = new DecisionRulesetRegistry(policies, [
    { eventPolicyVersion: DEFAULT_EVENT_RULE_POLICY.version, ruleset: DEFAULT_DECISION_RULESET },
  ]).append({ eventPolicyVersion: "event-policy-v2", ruleset: ruleset() });
  expect(registry.get(DEFAULT_DECISION_RULESET.version).baselineVersion).toBe("robust-baseline-v1");
  expect(registry.get("decision-rules-v2").baselineVersion).toBe("robust-baseline-v2");
  expect(registry.get(DEFAULT_DECISION_RULESET.version).ruleset).toEqual(DEFAULT_DECISION_RULESET);
});

it("requires a new matching decision version when a product threshold changes", () => {
  const rules = policy().rules.map((rule) =>
    rule.eventType === "STOCKOUT_RISK"
      ? { ...rule, thresholds: { ...rule.thresholds, criticalHoursRemaining: 4 } }
      : rule,
  );
  const policies = events().append({ ...policy(), rules });
  const registry = new DecisionRulesetRegistry(policies, [
    { eventPolicyVersion: DEFAULT_EVENT_RULE_POLICY.version, ruleset: DEFAULT_DECISION_RULESET },
  ]);
  const inventory = { ...DEFAULT_DECISION_RULESET.inventory, criticalHoursRemaining: 4 };
  const updated = registry.append({
    eventPolicyVersion: "event-policy-v2",
    ruleset: { ...ruleset(), inventory },
  });
  expect(
    updated.get(DEFAULT_DECISION_RULESET.version).ruleset.inventory.criticalHoursRemaining,
  ).toBe(6);
  expect(updated.get("decision-rules-v2").ruleset.inventory.criticalHoursRemaining).toBe(4);
  expect(() =>
    registry.append({ eventPolicyVersion: "event-policy-v2", ruleset: ruleset() }),
  ).toThrow(/disagree/u);
});

it.each([{ maximumAgeSeconds: -1 }, { minimumCoverageBasisPoints: 10001 }, { confidence: 1 }])(
  "rejects malformed nested decision configuration: %j",
  (patch) => {
    const inventory = { ...DEFAULT_DECISION_RULESET.inventory, ...patch };
    expect(() =>
      decisions().append({
        eventPolicyVersion: DEFAULT_EVENT_RULE_POLICY.version,
        ruleset: { ...ruleset(), inventory },
      }),
    ).toThrow();
  },
);

it("rejects absent policy rules and unsupported decision tolerance semantics", () => {
  const missing = new EventRulePolicyRegistry([{ ...policy(), rules: [policy().rules[0]] }]);
  expect(
    () =>
      new DecisionRulesetRegistry(missing, [
        { eventPolicyVersion: "event-policy-v2", ruleset: ruleset() },
      ]),
  ).toThrow(/requires stockout and refund/u);
  const rules = policy().rules.map((rule) => ({ ...rule, toleranceBasisPoints: 1 }));
  const tolerant = new EventRulePolicyRegistry([{ ...policy(), rules }]);
  expect(
    () =>
      new DecisionRulesetRegistry(tolerant, [
        { eventPolicyVersion: "event-policy-v2", ruleset: ruleset() },
      ]),
  ).toThrow(/disagree/u);
});

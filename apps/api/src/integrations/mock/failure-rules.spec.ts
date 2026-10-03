import { describe, expect, it } from "vitest";
import { selectMockReadFailure } from "./failure-rules.js";

const at = "2026-01-02T00:00:00Z";
const rule = {
  id: "rule-a",
  priority: 10,
  startsAt: at,
  endsAt: "2026-01-03T00:00:00Z",
  methods: ["getStore"],
  effect: { kind: "FAIL", code: "TEMPORARY", retryAfterMs: null },
};

describe("deterministic mock read failure selection", () => {
  it("selects only the highest priority then code-unit smallest ID independent of ordering", () => {
    const rules = [rule, { ...rule, id: "a", priority: 11 }, { ...rule, id: "Z", priority: 11 }];
    const expected = { ruleId: "Z", effect: rule.effect };
    expect(selectMockReadFailure(rules, "getStore", at)).toEqual(expected);
    expect(selectMockReadFailure([...rules].reverse(), "getStore", at)).toEqual(expected);
  });

  it("uses an inclusive start and exclusive end and only matching read methods", () => {
    expect(selectMockReadFailure([rule], "getStore", at)?.ruleId).toBe("rule-a");
    expect(selectMockReadFailure([rule], "getStore", rule.endsAt)).toBeNull();
    expect(selectMockReadFailure([rule], "getStore", "2026-01-01T23:59:59.999Z")).toBeNull();
    expect(selectMockReadFailure([rule], "getOrder", at)).toBeNull();
    expect(selectMockReadFailure([], "getStore", at)).toBeNull();
  });

  it("normalizes equivalent offset spellings and freezes the selected decision and effect", () => {
    const selected = selectMockReadFailure(
      [{ ...rule, startsAt: "2026-01-02T08:00:00+08:00" }],
      "getStore",
      "2026-01-01T19:00:00-05:00",
    );
    expect(selected).toEqual({ ruleId: "rule-a", effect: rule.effect });
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected?.effect)).toBe(true);
  });

  it.each([
    null,
    {},
    [rule, rule],
    Array.from({ length: 33 }, (_, index) => ({ ...rule, id: `r${index}` })),
    [{ ...rule, id: "bad id" }],
    [{ ...rule, priority: -1 }],
    [{ ...rule, priority: 1001 }],
    [{ ...rule, priority: 1.5 }],
    [{ ...rule, methods: [] }],
    [{ ...rule, methods: ["getStore", "getStore"] }],
    [{ ...rule, methods: ["updatePrice"] }],
    [{ ...rule, tenant: "secret" }],
    [{ ...rule, effect: { ...rule.effect, oracle: "secret" } }],
    [{ ...rule, startsAt: "2026-02-30T00:00:00Z" }],
    [{ ...rule, startsAt: "0000-01-01T00:00:00Z" }],
    [{ ...rule, startsAt: "0001-01-01T00:00:00+14:00" }],
    [{ ...rule, endsAt: at }],
    [{ ...rule, endsAt: "2026-01-01T00:00:00Z" }],
    [{ ...rule, effect: { kind: "FAIL", code: "ABORTED", retryAfterMs: null } }],
    [{ ...rule, effect: { kind: "FAIL", code: "RATE_LIMIT", retryAfterMs: null } }],
    [{ ...rule, effect: { kind: "FAIL", code: "RATE_LIMIT", retryAfterMs: 0 } }],
    [{ ...rule, effect: { kind: "FAIL", code: "RATE_LIMIT", retryAfterMs: 86400001 } }],
    [{ ...rule, effect: { ...rule.effect, retryAfterMs: 1 } }],
    [{ ...rule, effect: { kind: "DELAY", delayMs: 0 } }],
    [{ ...rule, effect: { kind: "DELAY", delayMs: 30001 } }],
    [{ ...rule, effect: { kind: "DELAY", delayMs: 1.5 } }],
  ])("rejects malformed server rules without revealing their input: %j", (rules) => {
    expect(() => selectMockReadFailure(rules, "getStore", at)).toThrow("INVALID_RESPONSE");
  });

  it.each(["bad", null, "0000-01-01T00:00:00Z", "2026-02-30T00:00:00Z"])(
    "rejects invalid business timestamps even when no rules match: %j",
    (clock) => {
      expect(() => selectMockReadFailure([], "getStore", clock)).toThrow("INVALID_RESPONSE");
    },
  );

  it.each([
    { kind: "FAIL", code: "RATE_LIMIT", retryAfterMs: 86400000 },
    { kind: "FAIL", code: "TIMEOUT", retryAfterMs: null },
    { kind: "FAIL", code: "AUTH_EXPIRED", retryAfterMs: null },
    { kind: "FAIL", code: "INVALID_RESPONSE", retryAfterMs: null },
    { kind: "DELAY", delayMs: 30000 },
  ])("accepts the bounded standard effect %j", (effect) => {
    expect(
      selectMockReadFailure([{ ...rule, priority: 1000, effect }], "getStore", at)?.effect,
    ).toEqual(effect);
  });
});

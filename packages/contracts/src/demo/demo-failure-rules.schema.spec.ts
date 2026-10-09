import { describe, expect, it } from "vitest";
import { DemoFailureRuleCreateSchema, DemoFailureRuleRemoveSchema } from "../index.js";

const rule = {
  id: "rule-a",
  priority: 10,
  startsAt: "2026-01-01T00:00:00.000Z",
  endsAt: "2026-01-02T00:00:00.000Z",
  methods: ["getStore"],
  effect: { kind: "FAIL", code: "TEMPORARY", retryAfterMs: null },
};
describe("demo failure rule commands", () => {
  it("bounds duration and excludes caller ownership", () => {
    expect(DemoFailureRuleCreateSchema.safeParse({ expectedRevision: 0, rule }).success).toBe(true);
    expect(
      DemoFailureRuleCreateSchema.safeParse({
        expectedRevision: 0,
        rule: { ...rule, endsAt: "2026-03-01T00:00:00.000Z" },
      }).success,
    ).toBe(false);
    expect(
      DemoFailureRuleCreateSchema.safeParse({ expectedRevision: 0, rule, actorUserId: "owner" })
        .success,
    ).toBe(false);
  });
  it("requires explicit session and rule confirmation for removal", () => {
    expect(
      DemoFailureRuleRemoveSchema.safeParse({
        expectedRevision: 1,
        confirmSessionId: "session-a",
        ruleId: "rule-a",
      }).success,
    ).toBe(true);
    expect(
      DemoFailureRuleRemoveSchema.safeParse({ expectedRevision: 1, ruleId: "rule-a" }).success,
    ).toBe(false);
  });
  it("rejects accessors, custom prototypes and excessive controls without invoking input", () => {
    let called = false;
    const input = {
      expectedRevision: 0,
      get rule() {
        called = true;
        return rule;
      },
    };
    expect(DemoFailureRuleCreateSchema.safeParse(input).success).toBe(false);
    expect(called).toBe(false);
    expect(
      DemoFailureRuleCreateSchema.safeParse(Object.create({ expectedRevision: 0, rule })).success,
    ).toBe(false);
    expect(
      DemoFailureRuleCreateSchema.safeParse({
        expectedRevision: 0,
        rule: { ...rule, methods: Array(10000).fill("getStore") },
      }).success,
    ).toBe(false);
  });
  it("rejects throwing proxy reflection without exposing its exception", () => {
    const input = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("secret controls");
        },
      },
    );
    expect(DemoFailureRuleCreateSchema.safeParse(input).success).toBe(false);
  });
});

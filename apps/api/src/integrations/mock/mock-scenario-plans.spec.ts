import { describe, expect, it } from "vitest";
import { createScenarioPlan } from "./mock-scenario-plans.js";
import { config } from "./mock-source-group.fixture.js";
import { MockConfigSchema } from "./mock-config.js";
describe("frozen causal scenario plans", () => {
  it("owns all fifteen bounded plans without runtime conclusions", () => {
    for (let n = 1; n <= 15; n++) {
      const id = `SCENARIO_${String(n).padStart(3, "0")}`;
      const plan = createScenarioPlan(config, id, 3, 9);
      expect(Object.isFrozen(plan)).toBe(true);
      expect(JSON.stringify(plan)).not.toMatch(/expected|reasoning|decision/u);
      expect(MockConfigSchema.safeParse({ ...config, scenarioPlan: plan }).success).toBe(true);
    }
  });
  it("rejects foreign, unknown, excessive and out-of-calendar input", () => {
    expect(() => createScenarioPlan(config, "SCENARIO_999", 3, 9)).toThrow();
    expect(() => createScenarioPlan(config, "SCENARIO_001", 3, 99)).toThrow();
    const plan = createScenarioPlan(config, "SCENARIO_001", 3, 9);
    expect(
      MockConfigSchema.safeParse({ ...config, scenarioPlan: { ...plan, extra: 1 } }).success,
    ).toBe(false);
    expect(
      MockConfigSchema.safeParse({
        ...config,
        scenarioPlan: { ...plan, externalStoreId: "foreign" },
      }).success,
    ).toBe(false);
  });
});

import { expect, it } from "vitest";
import { DemoScenarioLoadSchema } from "./demo-scenario.schema.js";
const command = {
  scenarioId: "SCENARIO_008",
  confirmSessionId: "session-a",
  expectedRevision: 0,
  expectedGeneration: 0,
  observedAt: "2026-01-01T16:00:00.000Z",
};
it("accepts only bounded scenario load commands and normalizes the clock", () => {
  expect(DemoScenarioLoadSchema.parse(command)).toEqual(command);
  expect(
    DemoScenarioLoadSchema.parse({ ...command, observedAt: "2026-01-02T00:00:00+08:00" })
      .observedAt,
  ).toBe(command.observedAt);
  for (const change of [
    { scenarioId: "SCENARIO_016" },
    { expectedGeneration: -1 },
    { expectedRevision: 2147483647 },
    { startDay: 9, endDay: 3 },
    { endDay: 366 },
    { organizationId: "foreign" },
    { observedAt: "0000-01-01T00:00:00Z" },
  ])
    expect(DemoScenarioLoadSchema.safeParse({ ...command, ...change }).success).toBe(false);
});

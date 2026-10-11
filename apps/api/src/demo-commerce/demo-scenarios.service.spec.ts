import { expect, it, vi } from "vitest";
import { DemoScenariosService } from "./demo-scenarios.service.js";
import { actor, access, record, repository } from "../../test/helpers/demo-commerce.fixture.js";
const command = {
  scenarioId: "SCENARIO_008",
  confirmSessionId: "session-a",
  expectedRevision: 0,
  expectedGeneration: 0,
  observedAt: "2026-01-13T16:00:00.000Z",
  startDay: 3,
  endDay: 9,
};
function fixture(enabled = true) {
  const sessions = repository();
  const scenarios = {
    findDemoScenarios: vi.fn(async () => null),
    loadDemoScenario: vi.fn(async () => ({ status: "CONFLICT" as const })),
  };
  return {
    sessions,
    scenarios,
    service: new DemoScenariosService(sessions, scenarios, {
      enabled,
      origin: "https://demo.example.com",
    }),
  };
}
it("builds only owned frozen configuration and passes explicit generation confirmation", async () => {
  const { scenarios, service } = fixture();
  await expect(service.load(actor, "store-a", command)).rejects.toMatchObject({ status: 409 });
  expect(scenarios.loadDemoScenario).toHaveBeenCalledWith(
    actor,
    "store-a",
    expect.objectContaining({
      confirmSessionId: "session-a",
      expectedGeneration: 0,
      expectedRevision: 0,
      generatorVersion: "mock-source-v2",
      config: expect.objectContaining({
        binding: record().config.binding,
        scenarioPlan: expect.objectContaining({
          scenarioId: "SCENARIO_008",
          externalStoreId: "mock:store-a",
        }),
      }),
    }),
  );
});
it("denies disabled demo, viewers, spoofed scope and wrong confirmation before a write", async () => {
  const disabled = fixture(false);
  await expect(disabled.service.load(actor, "store-a", command)).rejects.toMatchObject({
    status: 404,
  });
  const { service, sessions, scenarios } = fixture();
  for (const change of [
    { organizationId: "foreign" },
    { confirmSessionId: "wrong" },
    { observedAt: "2025-01-01T16:00:00Z" },
    { endDay: 30 },
    { observedAt: "2026-02-05T16:00:00.000Z" },
  ])
    await expect(service.load(actor, "store-a", { ...command, ...change })).rejects.toMatchObject({
      status: 400,
    });
  vi.mocked(sessions.findDemoStore).mockResolvedValue({ ...access, role: "VIEWER" });
  await expect(service.load(actor, "store-a", command)).rejects.toMatchObject({ status: 403 });
  expect(scenarios.loadDemoScenario).not.toHaveBeenCalled();
});
it.each(Array.from({ length: 15 }, (_, index) => `SCENARIO_${String(index + 1).padStart(3, "0")}`))(
  "builds the approved owned %s plan without accepting client-provided mutations",
  async (scenarioId) => {
    const { service, scenarios } = fixture();
    await expect(service.load(actor, "store-a", { ...command, scenarioId })).rejects.toMatchObject({
      status: 409,
    });
    expect(scenarios.loadDemoScenario).toHaveBeenCalledWith(
      actor,
      "store-a",
      expect.objectContaining({
        config: expect.objectContaining({
          scenarioPlan: expect.objectContaining({ scenarioId, externalStoreId: "mock:store-a" }),
        }),
      }),
    );
  },
);

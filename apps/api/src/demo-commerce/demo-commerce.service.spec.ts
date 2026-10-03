import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { DemoCommerceService } from "./demo-commerce.service.js";
import { configHash } from "./demo-commerce.record.js";
import {
  actor,
  access,
  command,
  record,
  repository,
} from "../../test/helpers/demo-commerce.fixture.js";
import { GENERATOR_VERSION } from "../integrations/mock/mock-config.js";

function service(repo = repository(), enabled = true) {
  return new DemoCommerceService(repo, {
    enabled,
    origin: enabled ? "https://demo.example.com" : null,
  });
}
async function rejects(action: Promise<unknown>, status: number) {
  await expect(action).rejects.toSatisfy(
    (e: unknown) => e instanceof HttpException && e.getStatus() === status,
  );
}
describe("demo controls service", () => {
  it("creates with trusted binding and emits a strict safe view", async () => {
    const repo = repository();
    const view = await service(repo).create(actor, "store-a", command);
    expect(Object.keys(view).sort()).toEqual(
      [
        "id",
        "storeId",
        "connectionId",
        "profile",
        "seed",
        "generatorVersion",
        "configHash",
        "clockNow",
        "clockRevision",
        "revision",
        "generation",
        "status",
      ].sort(),
    );
    expect(repo.createDemoSession).toHaveBeenCalledWith(
      actor,
      "store-a",
      expect.objectContaining({
        externalStoreId: "mock:store-a",
        generatorVersion: GENERATOR_VERSION,
      }),
    );
  });
  it("hides disabled controls before database access", async () => {
    const repo = repository();
    await rejects(service(repo, false).get(actor, "store-a"), 404);
    expect(repo.findDemoSession).not.toHaveBeenCalled();
  });
  it.each(["create", "advance", "reset", "disconnect"] as const)(
    "uses fresh role for %s",
    async (method) => {
      const repo = repository();
      vi.mocked(repo.findDemoStore).mockResolvedValue({ ...access, role: "VIEWER" });
      await rejects(
        service(repo)[method](
          actor,
          "store-a",
          method === "create"
            ? command
            : method === "advance"
              ? { expectedRevision: 0, durationMs: 1 }
              : method === "disconnect"
                ? { expectedRevision: 0, confirmSessionId: "session-a" }
                : { ...command, expectedRevision: 0, confirmSessionId: "session-a" },
        ),
        403,
      );
    },
  );
  it("rejects command and path spoofing", async () => {
    const s = service();
    await rejects(s.create(actor, "store-a", { ...command, workspaceId: "foreign" }), 400);
    await rejects(s.get(actor, "../store-a"), 400);
  });
  it("rejects confirmation before mutation", async () => {
    const repo = repository();
    await rejects(
      service(repo).disconnect(actor, "store-a", {
        expectedRevision: 0,
        confirmSessionId: "wrong",
      }),
      400,
    );
    expect(repo.disconnectDemoSession).not.toHaveBeenCalled();
  });
  it.each(["CONFLICT", "NOT_FOUND"] as const)("maps DB result %s", async (status) => {
    const repo = repository();
    vi.mocked(repo.advanceDemoSession).mockResolvedValue({ status });
    await rejects(
      service(repo).advance(actor, "store-a", { expectedRevision: 0, durationMs: 1 }),
      status === "CONFLICT" ? 409 : 404,
    );
  });
  it("sanitizes database failures", async () => {
    const repo = repository();
    vi.mocked(repo.findDemoSession).mockRejectedValue(new Error("secret SQL attacker"));
    const result = service(repo).get(actor, "store-a");
    await rejects(result, 503);
    await expect(result).rejects.not.toThrow("attacker");
  });
  it("normalizes JSONB ordering before checking hash", async () => {
    const repo = repository();
    const r = record();
    r.config = Object.fromEntries(Object.entries(r.config).reverse()) as typeof r.config;
    vi.mocked(repo.findDemoSession).mockResolvedValue(r);
    expect(await service(repo).get(actor, "store-a")).toHaveProperty("configHash", r.configHash);
  });
  it("rejects persisted year-zero history even with a matching source hash", async () => {
    const repo = repository();
    const r = record();
    r.config = { ...r.config, historyStart: "0000-01-01T16:00:00.000Z" };
    r.configHash = configHash(r.config);
    vi.mocked(repo.findDemoSession).mockResolvedValue(r);
    await rejects(service(repo).get(actor, "store-a"), 503);
  });
  it("sanitizes malformed mutation results", async () => {
    const repo = repository();
    vi.mocked(repo.advanceDemoSession).mockResolvedValue({
      status: "UNKNOWN",
    } as unknown as Awaited<ReturnType<typeof repo.advanceDemoSession>>);
    await rejects(
      service(repo).advance(actor, "store-a", { expectedRevision: 0, durationMs: 1 }),
      503,
    );
  });
  it.each([
    { configHash: "0".repeat(64) },
    { clockNow: new Date("invalid") },
    { generation: -1 },
    { generatorVersion: "unknown" },
    { userId: "other" },
    { storeId: "other" },
    { role: "unknown" },
    { clockNow: new Date("0000-01-01T00:00:00Z") },
  ])("rejects corrupt record %j", async (patch) => {
    const repo = repository();
    vi.mocked(repo.findDemoSession).mockResolvedValue({ ...record(), ...patch } as ReturnType<
      typeof record
    >);
    await rejects(service(repo).get(actor, "store-a"), 503);
  });
});

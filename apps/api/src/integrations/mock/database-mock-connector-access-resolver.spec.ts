import { describe, expect, it, vi } from "vitest";
import { actor, record, repository } from "../../../test/helpers/demo-commerce.fixture.js";
import { DatabaseMockConnectorAccessResolver } from "./database-mock-connector-access-resolver.js";
import { DemoCommerceConnectorHost } from "../../demo-commerce/demo-commerce-connector.host.js";
import { PersistentMockClock } from "./persistent-mock-clock.js";
const identity = { ...actor, permissions: [] };
const options = () => ({
  requestId: "read-a",
  deadlineAt: new Date(Date.now() + 5000).toISOString(),
});
describe("database connector composition", () => {
  it("invalidates a connector when its persisted session is replaced with identical configuration", async () => {
    const repo = repository();
    let current = record();
    vi.mocked(repo.findDemoSession).mockImplementation(async () => current);
    const host = new DemoCommerceConnectorHost(repo, {
      enabled: true,
      origin: "https://demo.example.com",
    });
    const opened = await host.open(identity, "store-a", options());
    if (!opened.ok) throw new Error(opened.error.code);
    expect(await opened.data.getStore(options())).toMatchObject({ ok: true });
    current = { ...current, id: "session-replacement" };
    expect(await opened.data.getStore(options())).toMatchObject({
      ok: false,
      error: { code: "AUTH_EXPIRED" },
    });
  });
  it("freshens persisted time using actual Factory and invalidates a reset connector", async () => {
    const repo = repository();
    let current = record();
    vi.mocked(repo.findDemoSession).mockImplementation(async () => current);
    const host = new DemoCommerceConnectorHost(repo, {
      enabled: true,
      origin: "https://demo.example.com",
    });
    const opened = await host.open(identity, "store-a", options());
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("open");
    expect(await opened.data.getStore(options())).toMatchObject({ ok: true });
    current = {
      ...current,
      clockNow: new Date("2026-01-15T00:00:00Z"),
      clockRevision: 1,
      revision: 1,
    };
    const result = await opened.data.listProducts(
      { until: "2026-01-15T00:00:00Z", limit: 1 },
      options(),
    );
    expect(result).toMatchObject({ ok: true });
    current = {
      ...current,
      generation: 1,
      clockRevision: 2,
      revision: 2,
      clockNow: new Date("2026-01-02T00:00:00Z"),
    };
    expect(await opened.data.getStore(options())).toMatchObject({
      ok: false,
      error: { code: "AUTH_EXPIRED" },
    });
  });
  it("cancels after fresh DB work without mutating clock", async () => {
    const repo = repository();
    const controller = new AbortController();
    vi.mocked(repo.findDemoSession).mockImplementation(async () => {
      controller.abort();
      return record();
    });
    const clock = new PersistentMockClock();
    const resolver = new DatabaseMockConnectorAccessResolver(repo, clock);
    await expect(
      resolver.resolve(identity, "store-a", { ...options(), signal: controller.signal }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(() => clock.snapshot()).toThrow("INVALID_RESPONSE");
  });
  it.each([
    { configHash: "0".repeat(64) },
    { storeId: "other" },
    { userId: "other" },
    { role: "UNKNOWN" },
  ])("rejects corruption before clock mutation %j", async (patch) => {
    const repo = repository();
    vi.mocked(repo.findDemoSession).mockResolvedValue({ ...record(), ...patch } as ReturnType<
      typeof record
    >);
    const clock = new PersistentMockClock();
    const resolver = new DatabaseMockConnectorAccessResolver(repo, clock);
    await expect(resolver.resolve(identity, "store-a", options())).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    expect(() => clock.snapshot()).toThrow("INVALID_RESPONSE");
  });
  it("returns no access after disconnect", async () => {
    const repo = repository();
    vi.mocked(repo.findDemoSession).mockResolvedValue({ ...record(), status: "DISCONNECTED" });
    expect(
      await new DatabaseMockConnectorAccessResolver(repo, new PersistentMockClock()).resolve(
        identity,
        "store-a",
        options(),
      ),
    ).toBeNull();
  });
  it("sanitizes DB faults", async () => {
    const repo = repository();
    vi.mocked(repo.findDemoSession).mockRejectedValue(new Error("secret"));
    await expect(
      new DatabaseMockConnectorAccessResolver(repo, new PersistentMockClock()).resolve(
        identity,
        "store-a",
        options(),
      ),
    ).rejects.toMatchObject({ code: "TEMPORARY", message: "TEMPORARY" });
  });
  it("checks deadline before lookup", async () => {
    const repo = repository();
    await expect(
      new DatabaseMockConnectorAccessResolver(repo, new PersistentMockClock()).resolve(
        identity,
        "store-a",
        { ...options(), deadlineAt: new Date(0).toISOString() },
      ),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(repo.findDemoSession).not.toHaveBeenCalled();
  });
  it("checks a deadline reached during DB work before clock mutation", async () => {
    const repo = repository();
    const clock = new PersistentMockClock();
    const call = { ...options(), deadlineAt: new Date(Date.now() + 20).toISOString() };
    vi.mocked(repo.findDemoSession).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return record();
    });
    await expect(
      new DatabaseMockConnectorAccessResolver(repo, clock).resolve(identity, "store-a", call),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(() => clock.snapshot()).toThrow("INVALID_RESPONSE");
  });
  it("rejects regressing persisted clock revisions and generations", async () => {
    const repo = repository();
    const clock = new PersistentMockClock();
    clock.refresh({ now: record().clockNow.toISOString(), revision: 2, generation: 1 });
    const resolver = new DatabaseMockConnectorAccessResolver(repo, clock);
    vi.mocked(repo.findDemoSession).mockResolvedValue({
      ...record(),
      generation: 1,
      clockRevision: 1,
    });
    await expect(resolver.resolve(identity, "store-a", options())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    vi.mocked(repo.findDemoSession).mockResolvedValue({ ...record(), clockRevision: 3 });
    await expect(resolver.resolve(identity, "store-a", options())).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
    });
    expect(clock.snapshot().revision).toBe(2);
  });
});

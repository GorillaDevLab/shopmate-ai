import { afterEach, describe, expect, it, vi } from "vitest";

const factory = vi.hoisted(() => vi.fn());
vi.mock("@shopmate/database/mock-platform-read", () => ({ createMockSourceReadPorts: factory }));
const module = await import("./database-persistent-read-ports.js").catch(() => null);
const actor = { userId: "user", merchantId: "merchant" };
const scope = {
  organizationId: "org",
  workspaceId: "workspace",
  storeId: "store",
  connectionId: "connection",
  externalStoreId: "mock/store",
  sessionId: "session",
  generation: 0,
};
const request = {
  kind: "PRODUCT" as const,
  requestedUntil: "2026-01-01T00:00:00.000Z",
  businessNow: "2026-01-01T00:00:00.000Z",
  limit: 1,
  contextHash: "a".repeat(64),
};
const options = {
  requestId: "request",
  deadlineAt: "2026-01-01T00:00:00.000Z",
  signal: new AbortController().signal,
};
afterEach(() => vi.clearAllMocks());

describe("server persistent source provider", () => {
  it("creates one lazy reader, forwards bound server scope and closes once", async () => {
    expect(module).not.toBeNull();
    if (!module) throw new Error("provider required");
    const read = vi.fn(async () => null),
      close = vi.fn(async () => undefined);
    const bind = vi.fn(() => ({ read }));
    factory.mockReturnValue({ bind, close });
    const provider = new module.DatabasePersistentReadPorts();
    expect(factory).not.toHaveBeenCalled();
    const port = provider.bind(actor, scope);
    provider.bind(actor, scope);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenCalledWith(actor, scope);
    await expect(port.read(request, options)).resolves.toBeNull();
    expect(read).toHaveBeenCalledWith(request, {
      signal: options.signal,
      deadlineAt: options.deadlineAt,
    });
    await provider.onModuleDestroy();
    await provider.onModuleDestroy();
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => provider.bind(actor, scope)).toThrow("TEMPORARY");
  });
  it.each([
    ["SOURCE_INPUT", "INVALID_INPUT"],
    ["SOURCE_ABORTED", "ABORTED"],
    ["SOURCE_DEADLINE", "TIMEOUT"],
    ["SOURCE_INTEGRITY", "INVALID_RESPONSE"],
    ["SOURCE_STORAGE", "TEMPORARY"],
    ["SOURCE_CREDENTIALS", "TEMPORARY"],
  ])("translates %s to fixed connector %s without source internals", async (code, expected) => {
    expect(module).not.toBeNull();
    if (!module) throw new Error("provider required");
    factory.mockReturnValue({
      bind: () => ({
        read: async () => {
          throw Object.assign(new Error("private sql/token"), { code });
        },
      }),
      close: async () => undefined,
    });
    const provider = new module.DatabasePersistentReadPorts();
    await expect(provider.bind(actor, scope).read(request, options)).rejects.toMatchObject({
      code: expected,
      message: expected,
    });
  });
});

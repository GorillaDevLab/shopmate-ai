import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import type { SourceReadPorts } from "@shopmate/database/mock-platform-read";
import { runSyncWorker, type SyncWorkerDependencies } from "./cli.js";
import { waitForNextSyncPass } from "./cli.js";
const env = {
  APP_ENV: "demo",
  ENABLE_DEMO_MODE: "true",
  SYNC_WORKER_GRANT_ID: "grant-a",
  SYNC_WORKER_DATABASE_URL: "postgres://sync-login:password@localhost/test",
  MOCK_PLATFORM_READ_DATABASE_URL: "postgres://reader-login:password@localhost/test",
  MOCK_SOURCE_CURSOR_KEY: "test-only-key".repeat(4),
};
function fixture() {
  const signals = new EventEmitter();
  const source = { close: vi.fn(async () => undefined), bind: vi.fn() } as SourceReadPorts;
  const close = vi.fn(async () => undefined);
  const pass = vi.fn(async () => ({
    status: "WAITING" as const,
    reason: "WAITING_PUBLICATION" as const,
    created: [],
    outcomes: [],
  }));
  const connect = vi.fn(
    async () => ({ close }) as unknown as Awaited<ReturnType<SyncWorkerDependencies["connect"]>>,
  );
  const dependencies: SyncWorkerDependencies = {
    signals,
    source: vi.fn(() => source),
    connect,
    coordinator: vi.fn(() => ({ pass })),
    poll: vi.fn(async () => undefined),
    report: vi.fn(),
  };
  return { dependencies, signals, source, close, pass, connect };
}
it.each([
  {},
  { ...env, APP_ENV: "production" },
  { ...env, ENABLE_DEMO_MODE: "false" },
  { ...env, SYNC_WORKER_GRANT_ID: "foreign identity" },
  { ...env, SYNC_WORKER_DATABASE_URL: "https://localhost" },
  { ...env, MOCK_PLATFORM_READ_DATABASE_URL: undefined },
  { ...env, MOCK_PLATFORM_READ_DATABASE_URL: env.SYNC_WORKER_DATABASE_URL },
  { ...env, MOCK_SOURCE_CURSOR_KEY: "short" },
  { ...env, MOCK_SOURCE_CURSOR_KEY: "a".repeat(4097) },
])("rejects unsafe startup before resource construction", async (input) => {
  const f = fixture();
  await expect(runSyncWorker(input, ["--once"], f.dependencies)).rejects.toThrow();
  expect(f.dependencies.source).not.toHaveBeenCalled();
  expect(f.connect).not.toHaveBeenCalled();
});
it.each([[["--target", "tomorrow"]], [["--once", "--once"]], [["--user", "user-a"]]])(
  "rejects unsupported arguments %j",
  async (args) => {
    const f = fixture();
    await expect(runSyncWorker(env, args, f.dependencies)).rejects.toThrow(
      "SYNC_WORKER_INVALID_ARGUMENTS",
    );
    expect(f.connect).not.toHaveBeenCalled();
  },
);
it("closes both resources and removes handlers on once completion", async () => {
  const f = fixture();
  await runSyncWorker(env, ["--once"], f.dependencies);
  expect(f.pass).toHaveBeenCalledTimes(1);
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.source.close).toHaveBeenCalledOnce();
  expect(f.dependencies.report).toHaveBeenCalledWith({
    status: "WAITING",
    reason: "WAITING_PUBLICATION",
    created: [],
    outcomes: [],
  });
  expect(f.signals.listenerCount("SIGINT")).toBe(0);
  expect(f.signals.listenerCount("SIGTERM")).toBe(0);
});
it("closes reader after backend startup rejection", async () => {
  const f = fixture();
  f.connect.mockRejectedValue(new Error("LOGIN_FAILED"));
  await expect(runSyncWorker(env, [], f.dependencies)).rejects.toThrow("LOGIN_FAILED");
  expect(f.source.close).toHaveBeenCalledOnce();
  expect(f.signals.listenerCount("SIGINT")).toBe(0);
});
it("stops daemon polling gracefully on SIGTERM", async () => {
  const f = fixture();
  f.dependencies.poll = vi.fn(async (signal) => {
    f.signals.emit("SIGTERM");
    expect(signal.aborted).toBe(true);
  });
  await runSyncWorker(env, [], f.dependencies);
  expect(f.pass).toHaveBeenCalledOnce();
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.source.close).toHaveBeenCalledOnce();
});
it("propagates authority failures and never retries them", async () => {
  const f = fixture();
  f.pass.mockRejectedValue(new Error("DENIED"));
  await expect(runSyncWorker(env, [], f.dependencies)).rejects.toThrow("DENIED");
  expect(f.pass).toHaveBeenCalledOnce();
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.source.close).toHaveBeenCalledOnce();
});
it("attempts both closes even if backend close rejects", async () => {
  const f = fixture();
  f.close.mockRejectedValue(new Error("CLOSE_FAILED"));
  await expect(runSyncWorker(env, ["--once"], f.dependencies)).rejects.toThrow(
    "SYNC_WORKER_CLEANUP_FAILED",
  );
  expect(f.source.close).toHaveBeenCalledOnce();
});
it("closes reader even when backend close throws synchronously", async () => {
  const f = fixture();
  f.close.mockImplementation(() => {
    throw new Error("CLOSE_THROWN");
  });
  await expect(runSyncWorker(env, ["--once"], f.dependencies)).rejects.toThrow(
    "SYNC_WORKER_CLEANUP_FAILED",
  );
  expect(f.source.close).toHaveBeenCalledOnce();
});
it("removes shutdown handlers when reader creation rejects", async () => {
  const f = fixture();
  vi.mocked(f.dependencies.source).mockImplementation(() => {
    throw new Error("READER_CONFIGURATION");
  });
  await expect(runSyncWorker(env, [], f.dependencies)).rejects.toThrow("READER_CONFIGURATION");
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.signals.listenerCount("SIGTERM")).toBe(0);
});
it("handles SIGINT during backend startup without running a pass", async () => {
  const f = fixture();
  f.connect.mockImplementation(async () => {
    f.signals.emit("SIGINT");
    return { close: f.close } as unknown as Awaited<ReturnType<SyncWorkerDependencies["connect"]>>;
  });
  await runSyncWorker(env, [], f.dependencies);
  expect(f.pass).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.source.close).toHaveBeenCalledOnce();
});
it("actual five second poll wakes immediately on stop", async () => {
  const controller = new AbortController();
  const waiting = waitForNextSyncPass(controller.signal);
  controller.abort();
  await expect(waiting).resolves.toBeUndefined();
});
it("built executable rejects missing environment cleanly", () => {
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../dist/main.js", import.meta.url))],
    { env: { SystemRoot: process.env.SystemRoot }, encoding: "utf8" },
  );
  expect(child.status).toBe(1);
  expect(child.stdout).toBe("");
  expect(child.stderr).toBe("SYNC_WORKER_FAILED\n");
});
it("built library import has no executable side effects", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const library = await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)}); for (const name of ["SyncCoordinator", "createSyncFailureRuleLoader", "runSyncWorker", "SyncPageRunner"]) { if (typeof library[name] !== "function") throw new Error("MISSING_EXPORT"); }`,
    ],
    { env: { SystemRoot: process.env.SystemRoot }, encoding: "utf8" },
  );
  expect(child.status).toBe(0);
  expect(child.stdout).toBe("");
  expect(child.stderr).toBe("");
});

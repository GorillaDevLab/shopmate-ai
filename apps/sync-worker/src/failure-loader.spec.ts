import { afterEach, expect, it, vi } from "vitest";
import type { SyncRuntimeBootstrap } from "@shopmate/database/sync-host";
import type { SyncRuntimeFailureRules } from "@shopmate/database/sync-host";
import { context } from "../test/work-fixtures.js";
import { createSyncFailureRuleLoader } from "./failure-loader.js";

const pinned: SyncRuntimeBootstrap = {
  ...context,
  merchantId: "merchant-a",
  businessNow: "2026-01-02T00:00:00.000Z",
  clockRevision: 1,
  sessionRevision: 1,
  config: { seed: 1 },
  configHash: "hash-a",
  generatorVersion: "v1",
  runtimeOpening: context.initialSince,
  state: "READY",
};
const actor = { userId: pinned.principalUserId, merchantId: pinned.merchantId };
const options = () => ({
  requestId: "fault-a",
  deadlineAt: new Date(Date.now() + 5000).toISOString(),
});
function fixture() {
  const rules = Object.freeze([]);
  const host = {
    runtimeBootstrap: vi.fn(async (): Promise<SyncRuntimeBootstrap | null> => pinned),
    runtimeFailureRules: vi.fn(
      async (): Promise<SyncRuntimeFailureRules | null> => ({ context: pinned, rules }),
    ),
  };
  return { host, rules, load: createSyncFailureRuleLoader(host, pinned) };
}
afterEach(() => vi.useRealTimers());
it("loads SDK immutable rules between fresh authority checks", async () => {
  const f = fixture();
  expect(await f.load(actor, pinned.scope, options())).toBe(f.rules);
  expect(f.host.runtimeBootstrap).toHaveBeenCalledTimes(2);
});
it("denies missing rules authority", async () => {
  const f = fixture();
  f.host.runtimeFailureRules.mockResolvedValue(null);
  await expect(f.load(actor, pinned.scope, options())).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
});
it("denies caller actor and full scope mismatches before reads", async () => {
  const f = fixture();
  await expect(
    f.load({ ...actor, merchantId: "foreign" }, pinned.scope, options()),
  ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  await expect(
    f.load(actor, { ...pinned.scope, externalStoreId: "foreign" }, options()),
  ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  expect(f.host.runtimeBootstrap).not.toHaveBeenCalled();
});
it("rejects expired and nonnative signal controls before reads", async () => {
  const f = fixture();
  await expect(
    f.load(actor, pinned.scope, {
      ...options(),
      deadlineAt: new Date(Date.now() - 1).toISOString(),
    }),
  ).rejects.toMatchObject({ code: "TIMEOUT" });
  await expect(
    f.load(actor, pinned.scope, { ...options(), signal: {} as AbortSignal }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(f.host.runtimeBootstrap).not.toHaveBeenCalled();
});
it.each([
  "grantId",
  "principalUserId",
  "merchantId",
  "provider",
  "initialSince",
  "configHash",
  "generatorVersion",
  "runtimeOpening",
] as const)("denies immutable %s drift", async (key) => {
  const f = fixture();
  f.host.runtimeBootstrap.mockResolvedValue({
    ...pinned,
    [key]: "changed",
  } as SyncRuntimeBootstrap);
  await expect(f.load(actor, pinned.scope, options())).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  expect(f.host.runtimeFailureRules).not.toHaveBeenCalled();
});
it("accepts fresh mutable revisions", async () => {
  const f = fixture();
  const current = {
    ...pinned,
    businessNow: "2026-01-03T00:00:00.000Z",
    clockRevision: 2,
    sessionRevision: 3,
  };
  f.host.runtimeBootstrap.mockResolvedValue(current);
  f.host.runtimeFailureRules.mockResolvedValue({ context: current, rules: f.rules });
  expect(await f.load(actor, pinned.scope, options())).toBe(f.rules);
});
it("denies revocation after a successful rules read", async () => {
  const f = fixture();
  f.host.runtimeBootstrap.mockResolvedValueOnce(pinned).mockResolvedValueOnce(null);
  await expect(f.load(actor, pinned.scope, options())).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
});
it("denies rules context drift", async () => {
  const f = fixture();
  f.host.runtimeFailureRules.mockResolvedValue({
    context: { ...pinned, scope: { ...pinned.scope, generation: 2 } },
    rules: f.rules,
  });
  await expect(f.load(actor, pinned.scope, options())).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
});
it("checks the original deadline after the SDK read", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.host.runtimeFailureRules.mockImplementation(async () => {
    vi.advanceTimersByTime(5001);
    return { context: pinned, rules: f.rules };
  });
  await expect(f.load(actor, pinned.scope, options())).rejects.toMatchObject({ code: "TIMEOUT" });
});
it("rejects hostile options without evaluating accessors or proxies", async () => {
  const f = fixture();
  const getter = vi.fn(() => "fault-a");
  const hostile = {
    ...options(),
    get requestId() {
      return getter();
    },
  };
  await expect(f.load(actor, pinned.scope, hostile)).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  await expect(f.load(actor, pinned.scope, new Proxy(options(), {}))).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  expect(getter).not.toHaveBeenCalled();
  expect(f.host.runtimeBootstrap).not.toHaveBeenCalled();
});

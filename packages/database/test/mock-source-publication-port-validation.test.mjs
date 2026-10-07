import assert from "node:assert/strict";
import test from "node:test";
const source = await import("../dist/src/mock-platform/index.js");
const scope = {
  organizationId: "org",
  workspaceId: "workspace",
  storeId: "store",
  sessionId: "session",
  connectionId: "connection",
  externalStoreId: "mock/store.1",
  generation: 0,
};
const lease = { scope, revision: "1", fence: "1", ownerId: "123e4567-e89b-42d3-a456-426614174000" };
const input = { expectedBaseRevision: "0", checkpointHash: "a".repeat(64) };

test("publication inputs validate before an unreachable database is contacted", async () => {
  const worker = source.createMockSourceWorker({
    MOCK_PLATFORM_WORKER_DATABASE_URL: "postgresql://source@127.0.0.1:1/test",
  });
  try {
    await assert.rejects(worker.publish({}, lease, input), { code: "SOURCE_INPUT" });
    for (const bad of [
      null,
      {},
      { ...lease, fence: "01" },
      { ...lease, ownerId: lease.ownerId.toUpperCase() },
      { ...lease, extra: true },
    ])
      await assert.rejects(worker.publish({ grantId: "g" }, bad, input), { code: "SOURCE_INPUT" });
    for (const bad of [
      null,
      {},
      { ...input, extra: true },
      { ...input, expectedBaseRevision: "01" },
      { ...input, checkpointHash: "invalid" },
    ])
      await assert.rejects(worker.publish({ grantId: "g" }, lease, bad), { code: "SOURCE_INPUT" });
  } finally {
    await worker.close();
  }
});

test("certificate read actors and scopes validate before an unreachable database is contacted", async () => {
  const reader = source.createMockSourceReader({
    MOCK_PLATFORM_READ_DATABASE_URL: "postgresql://source@127.0.0.1:1/test",
  });
  try {
    for (const actor of [null, {}, { userId: "u", merchantId: "m", grantId: "g" }])
      await assert.rejects(reader.findPublication(actor, scope), { code: "SOURCE_INPUT" });
    for (const bad of [
      null,
      { ...scope, generation: -1 },
      { ...scope, externalStoreId: "商".repeat(201) },
      { ...scope, bypass: true },
    ])
      await assert.rejects(reader.findPublication({ userId: "u", merchantId: "m" }, bad), {
        code: "SOURCE_INPUT",
      });
  } finally {
    await reader.close();
  }
});

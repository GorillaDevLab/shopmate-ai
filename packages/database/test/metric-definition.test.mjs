import assert from "node:assert/strict";
import test from "node:test";
import { ensureMetricDefinitions } from "../src/metric-definition.repository.ts";
const binding = {
  organizationId: "org",
  workspaceId: "workspace",
  storeId: "store",
  connectionId: "connection",
  externalStoreId: "external",
};
const actor = {
  userId: "user",
  merchantId: "merchant",
  organizationId: "org",
  workspaceId: "workspace",
  role: "OWNER",
  permissions: ["tenant:read"],
};
const entries = [
  {
    kind: "GMV",
    unit: "minorCNY",
    definitionVersion: "v1",
    definitionHash: `sha256:${"a".repeat(64)}`,
  },
];
function fixture(fail, mismatch = false) {
  const released = [];
  const client = {
    on() {},
    off() {},
    release(value) {
      released.push(value);
    },
    async query(sql) {
      if (sql === fail) throw new Error("ambiguous finish");
      return {
        rowCount: mismatch ? 0 : 1,
        rows: [{ unit: entries[0].unit, definitionHash: entries[0].definitionHash }],
      };
    },
  };
  return { options: { actor, pool: { connect: async () => client } }, released };
}
test("definition commit failure discards a client even if rollback succeeds", async () => {
  const f = fixture("COMMIT");
  assert.equal(
    (await ensureMetricDefinitions(f.options, binding, entries)).error.code,
    "SOURCE_UNAVAILABLE",
  );
  assert.deepEqual(f.released, [true]);
});
test("definition mismatch returns version failure only after clean rollback", async () => {
  const f = fixture("ROLLBACK", true);
  assert.equal(
    (await ensureMetricDefinitions(f.options, binding, entries)).error.code,
    "SOURCE_UNAVAILABLE",
  );
  assert.deepEqual(f.released, [true]);
});

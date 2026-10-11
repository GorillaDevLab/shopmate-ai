import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { URL } from "node:url";
import { encodeWorkerPage, workerDatabaseUrl } from "../src/sync-host/input.ts";

test("worker connection has no application database fallback", () => {
  assert.throws(() => workerDatabaseUrl({ DATABASE_URL: "postgres://operator@localhost/db" }), /SYNC_WORKER_CONFIGURATION/u);
  assert.equal(workerDatabaseUrl({ SYNC_WORKER_DATABASE_URL: "postgres://worker@localhost/db" }), "postgres://worker@localhost/db");
});
test("privileged worker export stays separate from application business modules", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.exports["./sync-host"]);
  assert.doesNotMatch(await readFile(new URL("../src/index.ts", import.meta.url), "utf8"), /sync-host/u);
  const api = new URL("../../../apps/api/src/", import.meta.url);
  for (const entry of await readdir(api, { recursive: true })) {
    if (!/\.(?:ts|tsx|mts|js)$/u.test(entry)) continue;
    assert.doesNotMatch(await readFile(new URL(entry.replaceAll("\\", "/"), api), "utf8"), /@shopmate\/database\/sync-host/u);
  }
});
test("closed bounded page boundary maps non-PostgreSQL text records to fixed quarantine candidates", () => {
  const page = { items: [{ title: "bad\u0000payload" }], nextCursor: null, observedAt: "2026-01-02T00:00:00.000Z", sourceWatermark: null };
  assert.deepEqual(JSON.parse(encodeWorkerPage("PRODUCTS", page)).items, [{}]);
  assert.deepEqual(JSON.parse(encodeWorkerPage("PRODUCTS", { ...page, items: [{ "bad\u0000key": 1 }, { refundMinor: Infinity }] })).items, [{}, {}]);
  assert.deepEqual(JSON.parse(encodeWorkerPage("PRODUCTS", { ...page, items: [{ externalStoreId: "owned", title: "bad\u0000text" }] })).items, [{ externalStoreId: "owned" }]);
  assert.throws(() => encodeWorkerPage("ORDERS", { ...page, items: Array(11).fill({}) }), /SYNC_PAGE_INVALID/u);
  assert.throws(() => encodeWorkerPage("PRODUCTS", { ...page, extra: true }), /SYNC_PAGE_INVALID/u);
  assert.throws(() => encodeWorkerPage("PRODUCTS", { ...page, nextCursor: "x".repeat(1025) }), /SYNC_PAGE_INVALID/u);
});

import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createAnalyticsDemo } from "../src/analytics-demo-data.ts";

test("seed defaults to offline dry run and refuses unconfirmed database writes", () => {
  const args = ["--import", "tsx", "src/analytics-demo-seed.ts", "--as-of=2026-09-13"];
  const env = { ...process.env, DATABASE_URL: "", DEMO_DATABASE_WRITE: "" };
  const preview = spawnSync(process.execPath, args, { env, encoding: "utf8" });
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).dryRun, true);
  const apply = spawnSync(process.execPath, [...args, "--apply"], { env, encoding: "utf8" });
  assert.equal(apply.status, 1);
  assert.match(apply.stderr, /独立演示数据库/);
});

test("rich demo is deterministic, tenant isolated and arithmetically consistent", () => {
  const data = createAnalyticsDemo("2026-09-13");
  assert.deepEqual(data, createAnalyticsDemo("2026-09-13"));
  assert.equal(data.length, 2);
  for (const tenant of data) {
    assert.equal(tenant.stores.length, 6);
    assert.equal(tenant.products.length, 30);
    assert.equal(tenant.skus.length, 60);
    assert.ok(tenant.orders.length >= 2800);
    assert.ok(tenant.orders.some((order) => order.status === "CANCELLED"));
    for (const order of tenant.orders) {
      assert.ok(tenant.stores.some((store) => store.id === order.storeId));
      assert.equal(
        order.totalCents,
        order.items.reduce((sum, item) => sum + item.quantity * item.unitCents, 0),
      );
      assert.ok(order.orderedAt.startsWith("2026-"));
      assert.ok(order.items.every((item) => tenant.skus.some((sku) => sku.id === item.skuId)));
    }
  }
  const ids = data.flatMap((tenant) => tenant.orders.map((order) => order.id));
  assert.equal(new Set(ids).size, ids.length);
});

test("new reference date reuses stable order IDs rather than accumulating duplicate data", () => {
  const before = createAnalyticsDemo("2026-09-13");
  const after = createAnalyticsDemo("2026-09-14");
  assert.deepEqual(
    before[0].orders.map((order) => order.id),
    after[0].orders.map((order) => order.id),
  );
  assert.notEqual(before[0].orders[0].orderedAt, after[0].orders[0].orderedAt);
  for (const invalid of ["2026-02-30", "", "today"])
    assert.throws(() => createAnalyticsDemo(invalid));
});

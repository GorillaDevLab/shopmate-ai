import assert from "node:assert/strict";
import test from "node:test";
import { createMetricFixture, closeMetricFixture, seedFacts, sourceSql, binding, window, cutoff } from "../helpers/metric-source-bundle-fixture.mjs";

let database;
test.before(async () => { database = await createMetricFixture(); await seedFacts(database); });
test.after(async () => { if (database) await closeMetricFixture(database); });
test("the normalized source archive is constrained and immutable", async () => {
  const table = await database.admin.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=to_regclass('public.metric_source_bundles')");
  assert.deepEqual(table.rows, [{ relrowsecurity: true, relforcerowsecurity: true }]);
  const capture = await database.admin.query("SELECT to_regprocedure('public.metric_source_capture(jsonb,jsonb,timestamp with time zone)') IS NOT NULL AS present");
  assert.equal(capture.rows[0].present, true);
});
async function capture(at = cutoff, inputWindow = window, scope = binding) {
  return (await sourceSql(database, "SELECT public.metric_source_capture($1,$2,$3) AS bundle", [scope, inputWindow, at])).rows[0].bundle;
}
test("restricted capture archives real normalized facts and complete receipt proof idempotently", async () => {
  const first = await capture();
  assert.ok(first);
  assert.equal(first.payload.orders[0].data.paidMinor, 100);
  assert.equal(first.payload.refunds[0].data.externalOrderId, "one");
  assert.equal(first.payload.prefixes.length, 4);
  assert.equal(first.payload.prefixes[0].receipts.length, 1);
  assert.deepEqual(await capture(), first);
  for (const operation of ["UPDATE public.metric_source_bundles SET payload=payload", "DELETE FROM public.metric_source_bundles", "TRUNCATE public.metric_source_bundles"])
    await assert.rejects(database.admin.query(operation), /Immutable metric source archive/u);
  await assert.rejects(sourceSql(database, "INSERT INTO public.metric_source_bundles DEFAULT VALUES"), /permission denied/u);
  await assert.rejects(sourceSql(database, 'SELECT * FROM sync_host."Job"'), /permission denied/u);
});
test("future, foreign and malformed capture requests fail closed", async () => {
  assert.equal(await capture("2026-01-03T00:00:00.000Z"), null);
  assert.equal(await capture(cutoff, window, { ...binding, externalStoreId: "foreign" }), null);
  assert.equal(await capture(cutoff, { ...window, injected: true }), null);
});

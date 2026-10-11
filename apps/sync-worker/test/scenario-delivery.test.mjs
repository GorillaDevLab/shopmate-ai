import assert from "node:assert/strict";
import test from "node:test";
import { SyncCoordinator, SyncCommerce, SyncPageRunner } from "../dist/index.js";
import {
  createScenarioFixture,
  closeScenarioFixture,
  prepareScenario,
  publishScenario,
  connectScenario,
} from "./scenario-fixture.mjs";
let f;
test.before(async () => {
  f = await createScenarioFixture();
});
test.after(async () => {
  if (f) await closeScenarioFixture(f);
});
const options = () => ({
  requestId: "delivery-test",
  deadlineAt: new Date(Date.now() + 25000).toISOString(),
});
async function snapshot(state) {
  return (
    await f.admin.query(
      `SELECT
  (SELECT jsonb_agg(to_jsonb(p) ORDER BY p."externalProductId") FROM commerce."ProductListing" p WHERE p."storeId"=$1) products,
  (SELECT jsonb_agg(to_jsonb(o) ORDER BY o."externalOrderId") FROM commerce."OrderListing" o WHERE o."storeId"=$1) orders,
  (SELECT jsonb_agg(to_jsonb(l) ORDER BY l."externalOrderId",l."externalLineId") FROM commerce."OrderLineListing" l WHERE l."storeId"=$1) lines,
  (SELECT jsonb_agg(to_jsonb(r) ORDER BY r."jobId",r."pageId") FROM sync_host."PageReceipt" r JOIN sync_host."Job" j ON j.id=r."jobId" WHERE j."storeId"=$1) receipts,
  (SELECT jsonb_agg(to_jsonb(c) ORDER BY c."jobId",c."pageId") FROM sync_host."CanonicalPageCommit" c WHERE c."storeId"=$1) commits,
  (SELECT jsonb_agg(to_jsonb(d) ORDER BY d."jobId",d."pageId",d.ordinal) FROM sync_host."CanonicalPageDecision" d WHERE d."storeId"=$1) decisions,
  (SELECT count(*)::int FROM sync_host."CanonicalQuarantine" q WHERE q."storeId"=$1) quarantines,
  (SELECT jsonb_agg(to_jsonb(j)-ARRAY['leaseUntil','leaseBackendPid','leaseBackendStart','leaseOwner','fence'] ORDER BY stream) FROM sync_host."Job" j WHERE j."storeId"=$1) jobs`,
      [state.scope.storeId],
    )
  ).rows[0];
}
test("LOAD 010 pipeline persists real multi-page source envelopes and drains terminal recovery while caught up", async () => {
  const state = await prepareScenario(f, "SCENARIO_010", {
    days: 3,
    startDay: 0,
    endDay: 1,
    productCount: 100,
    dailyOrders: 12,
  });
  await publishScenario(f, state);
  const host = await connectScenario(f, state);
  // Simulate original ACK visibility with replay delivery unavailable for this process only.
  const held = new Proxy(host, {
    get(target, key) {
      if (key === "pendingDeliveryReplays") return async () => [];
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const result = await new SyncCoordinator(held, f.sources).pass({
    maxPages: 1000,
    budgetMs: 120000,
  });
  assert.equal(result.outcomes.length, 5);
  assert.ok(result.outcomes.every((v) => v.reason === "SUCCEEDED"));
  const saved = (
    await f.admin.query(
      'SELECT * FROM sync_host."ScenarioDelivery" WHERE "runId"=$1 ORDER BY stream',
      [state.runId],
    )
  ).rows;
  assert.equal(saved.length, 5);
  assert.ok(saved.every((v) => v.attempts === 0));
  for (const stream of ["PRODUCTS", "ORDERS"]) {
    const job = result.outcomes.find((v) => v.job.stream === stream).job;
    assert.ok(job.pageCount > 1, `${stream} must be genuinely multi-page`);
    assert.ok(JSON.parse(saved.find((v) => v.stream === stream).pageBytes).nextCursor);
  }
  const before = await snapshot(state);
  await host.close();
  f.hosts.delete(host);
  const restarted = await connectScenario(f, state);
  const caught = await new SyncCoordinator(restarted, f.sources).pass();
  assert.equal(caught.reason, "CAUGHT_UP");
  assert.deepEqual(await restarted.pendingDeliveryReplays(), []);
  assert.deepEqual(await snapshot(state), before);
  assert.ok(
    (
      await f.admin.query('SELECT attempts FROM sync_host."ScenarioDelivery" WHERE "runId"=$1', [
        state.runId,
      ])
    ).rows.every((v) => v.attempts === 1),
  );
});
test("a restarted RUNNING replay cannot acquire a lease behind the generic runner's ownership tracking", async () => {
  const state = await prepareScenario(f, "SCENARIO_010", {
    days: 3,
    startDay: 0,
    endDay: 1,
    dailyOrders: 12,
  });
  await publishScenario(f, state);
  const host = await connectScenario(f, state),
    opened = await new SyncCommerce(host, f.sources).open(options());
  assert.equal(opened.ok, true);
  const wrapped = {
    claim: (job) => host.claim(job),
    renew: (job) => host.renew(job),
    fail: (job) => host.fail(job),
    commitPage: (...args) => host.commitDeliveryPage(...args),
  };
  const first = await new SyncPageRunner(
    wrapped,
    opened.data.connector,
    opened.data.bootstrap.runtimeOpening,
  ).run(await host.createWindow("ORDERS", state.until), { maxPages: 2 });
  assert.equal(first.job.status, "RUNNING");
  assert.equal((await host.pendingDeliveryReplays()).length, 1);
  await host.close();
  f.hosts.delete(host);
  await f.admin.query(
    'UPDATE sync_host."Job" SET "leaseUntil"=clock_timestamp()-interval \'1 second\' WHERE id=$1',
    [first.job.id],
  );
  const restarted = await connectScenario(f, state);
  const result = await new SyncCoordinator(restarted, f.sources).pass({
    maxPages: 1000,
    budgetMs: 120000,
  });
  assert.ok(result.outcomes.every((v) => v.reason === "SUCCEEDED"));
  assert.deepEqual(await restarted.pendingDeliveryReplays(), []);
});



import assert from "node:assert/strict";
import test from "node:test";
import { SyncCoordinator, SyncCommerce, createSyncFailureRuleLoader } from "../dist/index.js";
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
async function snapshot(state) {
  return (
    await f.admin.query(
      `SELECT
 (SELECT jsonb_agg(to_jsonb(r)) FROM sync_host."PageReceipt" r JOIN sync_host."Job" j ON j.id=r."jobId" WHERE j."storeId"=$1) receipts,
 (SELECT jsonb_agg(to_jsonb(o)) FROM commerce."OrderListing" o WHERE o."storeId"=$1) orders,
 (SELECT jsonb_agg(to_jsonb(j) ORDER BY stream) FROM sync_host."Job" j WHERE j."storeId"=$1) jobs`,
      [state.scope.storeId],
    )
  ).rows[0];
}
import { advanceScenario } from "./scenario-fixture.mjs";
import { selectMockReadFailure } from "../../api/dist/integrations/mock/failure-rules.js";
test("LOAD 009 activates a half-open business-clock interruption and restart preserves its expiry", async () => {
  const state = await prepareScenario(f, "SCENARIO_009", { days: 3, startDay: 0, endDay: 1 });
  await publishScenario(f, state);
  const host = await connectScenario(f, state);
  const rules = await host.runtimeFailureRules();
  assert.equal(rules.rules.length, 1, "LOAD 009 must expose its active interruption");
  const rule = rules.rules[0];
  assert.deepEqual(rule.methods, [
    "listProducts",
    "listOrders",
    "listRefunds",
    "getInventory",
    "getMarketingMetrics",
  ]);
  assert.equal(rule.startsAt, state.until);
  assert.equal(rule.endsAt, new Date(Date.parse(state.until) + 3600000).toISOString());
  assert.deepEqual(rule.effect, { kind: "FAIL", code: "TEMPORARY", retryAfterMs: null });
  assert.equal(
    selectMockReadFailure(
      rules.rules,
      "listOrders",
      new Date(Date.parse(state.until) - 1).toISOString(),
    ),
    null,
  );
  assert.equal(
    selectMockReadFailure(rules.rules, "listOrders", state.until).effect.code,
    "TEMPORARY",
  );
  assert.equal(selectMockReadFailure(rules.rules, "listOrders", rule.endsAt), null);
  assert.equal(selectMockReadFailure(rules.rules, "getStore", state.until), null);
  const options = () => ({
    requestId: "interrupt-read",
    deadlineAt: new Date(Date.now() + 25000).toISOString(),
  });
  const opened = await new SyncCommerce(
    host,
    f.sources,
    createSyncFailureRuleLoader(host, rules.context),
  ).open(options());
  assert.equal(opened.ok, true);
  assert.equal((await opened.data.connector.getStore(options())).ok, true);
  for (const method of rule.methods) {
    const result = await opened.data.connector[method](
      {
        ...(method === "getMarketingMetrics" ? { since: state.opening } : {}),
        until: state.until,
        limit: 10,
      },
      options(),
    );
    assert.deepEqual(result, { ok: false, error: { code: "TEMPORARY", retryAfterMs: null } });
  }
  await assert.rejects(new SyncCoordinator(host, f.sources).pass(), /SYNC_CONNECTOR_FAILED/);
  const failed = await snapshot(state);
  assert.equal(failed.receipts, null);
  assert.equal(failed.orders, null);
  assert.ok(failed.jobs.every((j) => j.pageCount === 0 && j.successfulThrough === null));
  const windows = failed.jobs.map((j) => ({ id: j.id, since: j.since, until: j.until }));
  await host.close();
  f.hosts.delete(host);
  const restarted = await connectScenario(f, state);
  assert.deepEqual((await restarted.runtimeFailureRules()).rules, rules.rules);
  await assert.rejects(new SyncCoordinator(restarted, f.sources).pass(), /SYNC_CONNECTOR_FAILED/);
  await advanceScenario(f, state, 3600000);
  assert.deepEqual((await restarted.runtimeFailureRules()).rules, []);
  const completed = await new SyncCoordinator(restarted, f.sources).pass({
    maxPages: 1000,
    budgetMs: 120000,
  });
  assert.equal(completed.outcomes.length, 5);
  assert.ok(completed.outcomes.every((v) => v.reason === "SUCCEEDED"));
  assert.deepEqual(
    (await snapshot(state)).jobs.map((j) => ({ id: j.id, since: j.since, until: j.until })),
    windows,
  );
});

test("009 reserves a combined 32-rule budget and keeps managed fault precedence explicit", async () => {
  const state = await prepareScenario(f, "SCENARIO_009", { days: 3, startDay: 0, endDay: 1 });
  const host = await connectScenario(f, state);
  await f.admin.query(
    'GRANT SELECT,INSERT,UPDATE ON demo."DemoFailureRule" TO scenario_pipeline_app',
  );
  await f.admin.query(
    'GRANT SELECT,INSERT ON demo."DemoFailureRuleAudit" TO scenario_pipeline_app',
  );
  await f.admin.query(
    'GRANT USAGE ON SEQUENCE demo."DemoFailureRuleAudit_id_seq" TO scenario_pipeline_app',
  );
  await f.admin.query(
    "GRANT EXECUTE ON FUNCTION demo.has_failure_rule_access(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,BOOLEAN) TO scenario_pipeline_app",
  );
  const actor = { userId: "source-human", merchantId: "source-merchant-a" };
  const rule = {
    id: "managed",
    priority: 999,
    startsAt: state.until,
    endsAt: new Date(Date.parse(state.until) + 7200000).toISOString(),
    methods: ["listOrders"],
    effect: { kind: "FAIL", code: "AUTH_EXPIRED", retryAfterMs: null },
  };
  for (const invalid of [
    { ...rule, priority: 1000 },
    { ...rule, id: "scenario-interrupt:collision" },
  ])
    assert.equal(
      (
        await f.repo.createDemoFailureRule(actor, state.scope.storeId, {
          expectedRevision: state.revision,
          rule: invalid,
        })
      ).status,
      "CONFLICT",
    );
  for (let n = 0; n < 31; n++) {
    const result = await f.repo.createDemoFailureRule(actor, state.scope.storeId, {
      expectedRevision: state.revision,
      rule: { ...rule, id: `managed-${n}` },
    });
    assert.equal(result.status, "WRITTEN");
    state.revision = result.view.revision;
  }
  const rules = (await host.runtimeFailureRules()).rules;
  assert.equal(rules.length, 32);
  assert.equal(new Set(rules.map((v) => v.id)).size, 32);
  assert.equal(selectMockReadFailure(rules, "listOrders", state.until).effect.code, "TEMPORARY");
  assert.equal(
    (
      await f.repo.createDemoFailureRule(actor, state.scope.storeId, {
        expectedRevision: state.revision,
        rule: { ...rule, id: "overflow" },
      })
    ).status,
    "CONFLICT",
  );
  assert.equal((await host.runtimeFailureRules()).rules.length, 32);
  await advanceScenario(f, state, 3600000);
  const after = (await host.runtimeFailureRules()).rules;
  assert.equal(after.length, 31);
  assert.equal(
    selectMockReadFailure(
      after,
      "listOrders",
      new Date(Date.parse(state.until) + 3600000).toISOString(),
    ).effect.code,
    "AUTH_EXPIRED",
  );
  await f.admin.query('UPDATE sync_host."WorkerGrant" SET status=$1 WHERE id=$2', [
    "REVOKED",
    state.grant,
  ]);
  assert.equal(await host.runtimeFailureRules(), null);
  await f.admin.query('UPDATE sync_host."WorkerGrant" SET status=$1 WHERE id=$2', [
    "ACTIVE",
    state.grant,
  ]);
  const reset = await f.repo.resetDemoSession(actor, state.scope.storeId, {
    expectedRevision: state.revision,
    config: state.config,
    configHash: (await host.runtimeBootstrap()).configHash,
    generatorVersion: "mock-source-v2",
    clockNow: new Date(state.until),
  });
  assert.equal(reset.status, "WRITTEN");
  assert.equal(await host.runtimeFailureRules(), null);
});

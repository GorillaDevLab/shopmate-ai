import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import process from "node:process";
import { URL } from "node:url";
import pg from "pg";
import { isolatedPostgres } from "../helpers/isolated-postgres.mjs";
import { DemoCommerceApiFixture } from "../helpers/demo-commerce-api-fixture.mjs";
import { grantControl } from "../helpers/mock-source-control-fixture.mjs";

const actor = { userId: "demo-api-user-a", merchantId: "demo-api-merchant-a" };
const storeId = "demo-api-store-a";
const rule = {
  id: "rule-a",
  priority: 1,
  startsAt: "2026-01-01T00:00:00.000Z",
  endsAt: "2026-01-02T00:00:00.000Z",
  methods: ["getStore"],
  effect: { kind: "FAIL", code: "TEMPORARY", retryAfterMs: null },
};
const binding = {
  organizationId: "legacy-org-demo-api-merchant-a",
  workspaceId: "legacy-workspace-demo-api-merchant-a",
  storeId,
  connectionId: "rules-connection",
  externalStoreId: "rules-external",
};
const input = {
  id: "rules-session",
  connectionId: binding.connectionId,
  externalStoreId: binding.externalStoreId,
  config: { binding, seed: 42 },
  configHash: "a".repeat(64),
  generatorVersion: "mock-source-v1",
  clockNow: new Date(rule.startsAt),
};
test("persistent failure rules use restricted current demo authority and atomic audit", async (t) => {
  const server = await isolatedPostgres();
  const admin = new pg.Client({ connectionString: server.url });
  const fixture = new DemoCommerceApiFixture(server.url);
  let repo;
  try {
    await admin.connect();
    const root = new URL("../../prisma/migrations/", import.meta.url);
    for (const name of (await readdir(root)).filter((name) => /^\d{14}_/u.test(name)).sort())
      await admin.query(await readFile(new URL(`${name}/migration.sql`, root), "utf8"));
    await fixture.initialize();
    await fixture.setMarker("DEMO");
    await grantControl(admin, "shopmate_failure_rules_test");
    assert.equal(
      (await admin.query("SELECT to_regclass('demo.\"DemoFailureRule\"') AS table")).rows[0].table,
      'demo."DemoFailureRule"',
    );
    await admin.query(
      'GRANT SELECT,INSERT,UPDATE ON demo."DemoFailureRule" TO shopmate_failure_rules_test',
    );
    await admin.query(
      'GRANT SELECT,INSERT ON demo."DemoFailureRuleAudit" TO shopmate_failure_rules_test',
    );
    await admin.query(
      'GRANT USAGE ON SEQUENCE demo."DemoFailureRuleAudit_id_seq" TO shopmate_failure_rules_test',
    );
    await admin.query(
      "GRANT EXECUTE ON FUNCTION demo.has_failure_rule_access(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,BOOLEAN) TO shopmate_failure_rules_test",
    );
    const url = new URL(server.url);
    url.username = "shopmate_failure_rules_test";
    process.env.DATABASE_URL = url.toString();
    repo = await import("../../dist/src/index.js");
    assert.equal((await repo.createDemoSession(actor, storeId, input)).status, "WRITTEN");
    await t.test("create survives reopening and increments revision once", async () => {
      assert.equal(
        (await repo.createDemoFailureRule(actor, storeId, { expectedRevision: 0, rule })).status,
        "WRITTEN",
      );
      await repo.disconnectPrismaClient();
      const view = await repo.findDemoFailureRules(actor, storeId);
      assert.equal(view.revision, 1);
      assert.deepEqual(view.rules, [rule]);
      assert.equal(
        (await admin.query('SELECT count(*)::int AS n FROM demo."DemoFailureRuleAudit"')).rows[0].n,
        1,
      );
    });
    await t.test("stale revision, confirmation and viewer cannot mutate", async () => {
      assert.equal(
        (
          await repo.createDemoFailureRule(actor, storeId, {
            expectedRevision: 0,
            rule: { ...rule, id: "other" },
          })
        ).status,
        "CONFLICT",
      );
      assert.equal(
        (
          await repo.removeDemoFailureRule(actor, storeId, {
            expectedRevision: 1,
            confirmSessionId: "wrong",
            ruleId: rule.id,
          })
        ).status,
        "CONFLICT",
      );
      await fixture.setRole("VIEWER");
      assert.equal(
        (
          await repo.createDemoFailureRule(actor, storeId, {
            expectedRevision: 1,
            rule: { ...rule, id: "other" },
          })
        ).status,
        "NOT_FOUND",
      );
      await fixture.setRole("OWNER");
      assert.equal((await repo.findDemoFailureRules(actor, storeId)).revision, 1);
    });
    await t.test("audit failure rolls back both rule and revision", async () => {
      await admin.query(
        "CREATE FUNCTION demo.suppress_failure_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$",
      );
      await admin.query(
        'CREATE TRIGGER suppress_failure_audit BEFORE INSERT ON demo."DemoFailureRuleAudit" FOR EACH ROW EXECUTE FUNCTION demo.suppress_failure_audit()',
      );
      assert.equal(
        (
          await repo.createDemoFailureRule(actor, storeId, {
            expectedRevision: 1,
            rule: { ...rule, id: "other" },
          })
        ).status,
        "CONFLICT",
      );
      await admin.query('DROP TRIGGER suppress_failure_audit ON demo."DemoFailureRuleAudit"');
      assert.deepEqual((await repo.findDemoFailureRules(actor, storeId)).rules, [rule]);
      assert.equal((await repo.findDemoFailureRules(actor, storeId)).revision, 1);
    });
    await t.test(
      "expiry follows business clock and reset never reactivates old generation",
      async () => {
        await repo.advanceDemoSession(actor, storeId, {
          expectedRevision: 1,
          durationMs: 86_400_000,
        });
        assert.deepEqual((await repo.findDemoFailureRules(actor, storeId)).rules, []);
        await repo.resetDemoSession(actor, storeId, { ...input, expectedRevision: 2 });
        assert.deepEqual((await repo.findDemoFailureRules(actor, storeId)).rules, []);
      },
    );
    await t.test(
      "confirmed removal is immutable, audited and isolated from old generation",
      async () => {
        assert.equal(
          (await repo.createDemoFailureRule(actor, storeId, { expectedRevision: 3, rule })).status,
          "WRITTEN",
        );
        assert.equal(
          (
            await repo.removeDemoFailureRule(actor, storeId, {
              expectedRevision: 4,
              confirmSessionId: input.id,
              ruleId: rule.id,
            })
          ).status,
          "WRITTEN",
        );
        assert.deepEqual((await repo.findDemoFailureRules(actor, storeId)).rules, []);
        assert.equal(
          (
            await repo.removeDemoFailureRule(actor, storeId, {
              expectedRevision: 5,
              confirmSessionId: input.id,
              ruleId: rule.id,
            })
          ).status,
          "CONFLICT",
        );
        assert.deepEqual(
          (await admin.query('SELECT kind FROM demo."DemoFailureRuleAudit" ORDER BY id')).rows.map(
            (row) => row.kind,
          ),
          ["CREATE", "CREATE", "REMOVE"],
        );
      },
    );
    await t.test(
      "capacity bounds current generation and concurrent revision has one winner",
      async () => {
        const commands = ["concurrent-a", "concurrent-b"].map((id) =>
          repo.createDemoFailureRule(actor, storeId, {
            expectedRevision: 5,
            rule: { ...rule, id },
          }),
        );
        assert.deepEqual((await Promise.all(commands)).map((result) => result.status).sort(), [
          "CONFLICT",
          "WRITTEN",
        ]);
        for (let index = 1; index < 32; index++)
          assert.equal(
            (
              await repo.createDemoFailureRule(actor, storeId, {
                expectedRevision: 5 + index,
                rule: { ...rule, id: `capacity-${index}` },
              })
            ).status,
            "WRITTEN",
          );
        assert.equal((await repo.findDemoFailureRules(actor, storeId)).rules.length, 32);
        assert.equal(
          (
            await repo.createDemoFailureRule(actor, storeId, {
              expectedRevision: 37,
              rule: { ...rule, id: "overflow" },
            })
          ).status,
          "CONFLICT",
        );
        assert.equal((await repo.findDemoFailureRules(actor, storeId)).revision, 37);
      },
    );
    await t.test(
      "worker login cannot mutate rules even with accidental table grants and human identity",
      async () => {
        await admin.query("CREATE ROLE failure_worker_login LOGIN NOSUPERUSER NOBYPASSRLS");
        await admin.query("GRANT shopmate_mock_source_worker TO failure_worker_login");
        await admin.query(
          'GRANT SELECT,INSERT,UPDATE ON demo."DemoFailureRule" TO failure_worker_login',
        );
        await admin.query(
          "GRANT EXECUTE ON FUNCTION demo.has_failure_rule_access(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,BOOLEAN) TO failure_worker_login",
        );
        const url = new URL(server.url);
        url.username = "failure_worker_login";
        const worker = new pg.Client({ connectionString: url.toString() });
        await worker.connect();
        try {
          await worker.query("BEGIN");
          await worker.query("SELECT set_config('app.user_id',$1,true)", [actor.userId]);
          await worker.query("SELECT demo.lock_source_control($1)", [input.id]);
          assert.equal(
            (await worker.query('UPDATE demo."DemoFailureRule" SET "removedRevision"=38')).rowCount,
            0,
          );
          await assert.rejects(
            worker.query(
              'INSERT INTO demo."DemoFailureRule" SELECT * FROM demo."DemoFailureRule" LIMIT 1',
            ),
            (error) => ["42501", "SM001"].includes(error.code),
          );
        } finally {
          await worker.query("ROLLBACK");
          await worker.end();
        }
      },
    );
    await t.test("audit cannot be updated or removed even with accidental grants", async () => {
      await admin.query(
        'GRANT UPDATE,DELETE ON demo."DemoFailureRuleAudit" TO shopmate_failure_rules_test',
      );
      const url = new URL(server.url);
      url.username = "shopmate_failure_rules_test";
      const client = new pg.Client({ connectionString: url.toString() });
      await client.connect();
      try {
        await client.query("SELECT set_config('app.user_id',$1,false)", [actor.userId]);
        assert.equal(
          (await client.query("UPDATE demo.\"DemoFailureRuleAudit\" SET kind='REMOVE'")).rowCount,
          0,
        );
        assert.equal((await client.query('DELETE FROM demo."DemoFailureRuleAudit"')).rowCount, 0);
      } finally {
        await client.end();
      }
    });
    await t.test("production and revoked membership deny fresh reads", async () => {
      await fixture.setMarker("PRODUCTION");
      assert.equal(await repo.findDemoFailureRules(actor, storeId), null);
      await fixture.setMarker("DEMO");
      await fixture.disableMembership();
      assert.equal(await repo.findDemoFailureRules(actor, storeId), null);
    });
  } finally {
    if (repo) await repo.disconnectPrismaClient();
    await fixture.close();
    await admin.end();
    await server.stop();
  }
});

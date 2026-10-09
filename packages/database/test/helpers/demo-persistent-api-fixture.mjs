import assert from "node:assert/strict";
import pg from "pg";
import { setTimeout } from "node:timers";
import { randomUUID } from "node:crypto";
import { DemoCommerceApiFixture } from "./demo-commerce-api-fixture.mjs";
import { eventFor } from "./mock-source-append-fixture.mjs";
import { loginUrl } from "./mock-platform-fixture.mjs";
import { createMockSourceWorker } from "../../dist/src/mock-platform/index.js";
import { requireIsolatedDatabaseUrl } from "./isolated-postgres.mjs";
import { validateScope, validateWorkerActor } from "../../dist/src/mock-platform/validation.js";

const principal = "persistent-api-source-worker";
export class DemoPersistentApiFixture extends DemoCommerceApiFixture {
  constructor(url) {
    super(url);
    this.url = url;
  }
  get readEnvironment() {
    return {
      MOCK_PLATFORM_READ_DATABASE_URL: loginUrl(this.url, "persistent_api_read_login"),
      MOCK_SOURCE_CURSOR_KEY: "p".repeat(32),
    };
  }
  async initialize() {
    await super.initialize();
    for (const [login, group] of [
      ["persistent_api_read_login", "shopmate_mock_source_reader"],
      ["persistent_api_worker_login", "shopmate_mock_source_worker"],
    ]) {
      if (!(await this.client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [login])).rowCount)
        await this.client.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOBYPASSRLS`);
      await this.client.query(`GRANT ${group} TO ${login}`);
    }
    for (const key of ["a", "b"]) {
      const organization = `legacy-org-demo-api-merchant-${key}`;
      await this.client.query(
        'INSERT INTO "OrganizationMember" (id,"organizationId","userId",role,"updatedAt") VALUES ($1,$2,$3,$4,now())',
        [`persistent-worker-${key}`, organization, principal, "VIEWER"],
      );
      await this.client.query(
        'INSERT INTO "WorkspaceMember" (id,"organizationId","workspaceId","userId") VALUES ($1,$2,$3,$4)',
        [
          `persistent-workspace-${key}`,
          organization,
          `legacy-workspace-demo-api-merchant-${key}`,
          principal,
        ],
      );
    }
    this.worker = createMockSourceWorker({
      MOCK_PLATFORM_WORKER_DATABASE_URL: loginUrl(this.url, "persistent_api_worker_login"),
    });
  }
  async reset() {
    requireIsolatedDatabaseUrl(this.url);
    // Operator-only teardown in the validated disposable database. Restore every protection
    // before normal API/worker operations; no source evidence is ever manufactured here.
    await this.client.query("BEGIN");
    try {
      await this.client.query("SET LOCAL session_replication_role='replica'");
      for (const table of [
        'mock_platform."EntityVersion"',
        'mock_platform."SourceEvent"',
        'mock_platform."BuildJob"',
        'mock_platform."Runtime"',
        'demo."MockWorkerGrant"',
      ])
        await this.client.query(`DELETE FROM ${table} WHERE "organizationId"=ANY($1::text[])`, [
          ["legacy-org-demo-api-merchant-a", "legacy-org-demo-api-merchant-b"],
        ]);
      await this.client.query("COMMIT");
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
    assert.equal(
      (await this.client.query("SHOW session_replication_role")).rows[0].session_replication_role,
      "origin",
    );
    await super.reset();
  }
  async publish(storeId, empty = false) {
    const scope = await this.sourceScope(storeId);
    const actor = await this.grantActor(scope);
    const initialized = await this.worker.initializeGeneration(actor, scope);
    assert.ok(["CREATED", "EXISTS"].includes(initialized.status));
    const claimed = await this.worker.claim(actor, scope);
    assert.equal(claimed.status, "CLAIMED");
    const lease = claimed.lease;
    const events = empty ? [] : this.events(scope, lease.targetTime);
    const appended = await this.worker.appendChunk(actor, lease, {
      expectedCheckpointHash: lease.checkpointHash,
      next: { processedThrough: lease.targetTime, sealed: true },
      events,
    });
    assert.equal(appended.status, "COMMITTED");
    const result = await this.worker.publish(actor, lease, {
      expectedBaseRevision: lease.baseRevision,
      checkpointHash: appended.checkpointHash,
    });
    assert.equal(result.status, "PUBLISHED");
    return result.publication;
  }
  async sourceScope(storeId) {
    assert.equal(
      (await this.client.query("SHOW session_replication_role")).rows[0].session_replication_role,
      "origin",
    );
    const record = (await this.snapshot(storeId)).session[0];
    assert.ok(record);
    const connection = await this.client.query(
      'SELECT generation FROM "PlatformConnection" WHERE id=$1',
      [record.connectionId],
    );
    assert.equal(connection.rowCount, 1);
    const scope = {
      organizationId: record.organizationId,
      workspaceId: record.workspaceId,
      storeId,
      connectionId: record.connectionId,
      externalStoreId: record.externalStoreId,
      sessionId: record.id,
      generation: connection.rows[0].generation,
    };
    validateScope(scope);
    return scope;
  }
  async grantActor(scope) {
    const grantId = `persistent-${randomUUID()}`;
    await this.client.query(
      'INSERT INTO demo."MockWorkerGrant" (id,"databaseRole","principalUserId","organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",operation,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        grantId,
        "persistent_api_worker_login",
        principal,
        scope.organizationId,
        scope.workspaceId,
        scope.storeId,
        scope.sessionId,
        scope.connectionId,
        scope.externalStoreId,
        "SOURCE_BUILD",
        "ACTIVE",
      ],
    );
    const actor = { grantId };
    validateWorkerActor(actor);
    return actor;
  }
  events(scope, at) {
    const context = { scope, job: { targetTime: at } };
    return [
      eventFor(context, "STORE"),
      ...["a-product", 'quoted/"中文'].map((id) =>
        eventFor(context, "PRODUCT", "0", at, (record) => {
          record.externalProductId = id;
          record.skus[0].externalProductId = id;
          record.title = "Persisted fixture product";
        }),
      ),
    ];
  }
  async holdEntityTable() {
    const locker = new pg.Client({ connectionString: requireIsolatedDatabaseUrl(this.url) });
    await locker.connect();
    await locker.query("BEGIN");
    await locker.query('LOCK TABLE mock_platform."EntityVersion" IN ACCESS EXCLUSIVE MODE');
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await locker.query("ROLLBACK");
      await locker.end();
    };
  }
  async waitSourceQuery() {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const result = await this.client.query(
        "SELECT pid FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock' AND query LIKE $2",
        ["persistent_api_read_login", '%"EntityVersion"%'],
      );
      if (result.rowCount) return result.rows[0].pid;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Actual source SQL must enter the held entity wait");
  }
  async waitBackendGone(pid) {
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      if (!(await this.client.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1", [pid])).rowCount)
        return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Canceled source backend must disappear before releasing the lock");
  }
  async close() {
    await this.worker?.close();
    await super.close();
  }
}

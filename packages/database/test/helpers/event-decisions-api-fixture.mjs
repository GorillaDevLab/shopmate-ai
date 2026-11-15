import assert from "node:assert/strict";
import pg from "pg";
import { requireIsolatedDatabaseUrl } from "./isolated-postgres.mjs";
import { createSourceSession, grantSource, loginUrl } from "./mock-platform-fixture.mjs";
import { createMockSourceWorker } from "../../src/mock-platform/index.ts";
import { connectSyncWorker } from "./sync-host-fixture.mjs";
import { startJob, commitPage, opening, window } from "./metric-source-bundle-fixture.mjs";
import { canonicalRecord } from "./canonical-page-fixture.mjs";
import { operatorControl } from "./mock-source-control-fixture.mjs";

export const observedAt = "2026-01-02T00:00:00.000Z";
export { window };
export const scope = {
  organizationId: "legacy-org-event-runtime-merchant",
  workspaceId: "legacy-workspace-event-runtime-merchant",
  storeId: "event-runtime-store",
  connectionId: "event-runtime-connection",
  externalStoreId: "mock/event-runtime",
  sessionId: "event-runtime-session",
  generation: 0,
};
export const binding = Object.fromEntries(
  Object.entries(scope).filter(([key]) => !["sessionId", "generation"].includes(key)),
);

export class EventDecisionsApiFixture {
  constructor(url) {
    this.url = requireIsolatedDatabaseUrl(url);
    this.admin = new pg.Client({ connectionString: url });
  }
  async initialize() {
    await this.admin.connect();
    await this.tenants();
    await createSourceSession(this.admin, scope);
    await this.logins();
    await grantSource(
      this.admin,
      scope,
      "event-runtime-source-grant",
      "event_runtime_source_login",
    );
    await this.initializeSource();
    await this.admin.query(
      'INSERT INTO sync_host."WorkerGrant" (id,"databaseRole","principalUserId","organizationId","workspaceId","storeId","connectionId","externalStoreId",provider,generation,"initialSince") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        "event-runtime-sync-grant",
        "event_runtime_sync_login",
        "source-worker",
        ...Object.values(binding),
        "MOCK",
        0,
        opening,
      ],
    );
    this.worker = await connectSyncWorker(
      this.url,
      "event_runtime_sync_login",
      "event-runtime-sync-grant",
    );
    await this.advance(observedAt);
  }
  async initializeSource() {
    const source = createMockSourceWorker({
      MOCK_PLATFORM_WORKER_DATABASE_URL: loginUrl(this.url, "event_runtime_source_login"),
    });
    try {
      assert.equal(
        (await source.initializeGeneration({ grantId: "event-runtime-source-grant" }, scope))
          .status,
        "CREATED",
      );
    } finally {
      await source.close();
    }
  }
  async tenants() {
    await this.admin.query(
      'INSERT INTO "Merchant" (id,name,slug,"updatedAt") VALUES ($1,$1,$1,now())',
      ["event-runtime-merchant"],
    );
    for (const [user, role] of [
      ["event-runtime-human", "OWNER"],
      ["event-runtime-recipient", "VIEWER"],
      ["source-worker", "VIEWER"],
    ]) {
      await this.admin.query(
        'INSERT INTO "OrganizationMember" (id,"organizationId","userId",role,"updatedAt") VALUES ($1,$2,$3,$4,now())',
        [`event-runtime-${user}`, scope.organizationId, user, role],
      );
      await this.admin.query(
        'INSERT INTO "WorkspaceMember" (id,"organizationId","workspaceId","userId") VALUES ($1,$2,$3,$4)',
        [`event-runtime-assignment-${user}`, scope.organizationId, scope.workspaceId, user],
      );
    }
    await this.admin.query('INSERT INTO "DemoTenant" ("organizationId") VALUES ($1)', [
      scope.organizationId,
    ]);
    await this.admin.query('UPDATE "TenantBootstrapEnvironment" SET environment=$1', ["DEMO"]);
  }
  async logins() {
    for (const [login, capability] of [
      ["event_runtime_source_login", "shopmate_mock_source_worker"],
      ["event_runtime_sync_login", "shopmate_sync_worker"],
    ]) {
      if (!(await this.admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [login])).rowCount)
        await this.admin.query(
          `CREATE ROLE ${login} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
        );
      await this.admin.query(`GRANT ${capability} TO ${login}`);
    }
  }
  async advance(at) {
    await operatorControl(
      this.admin,
      'UPDATE demo."DemoCommerceSession" SET "clockNow"=$1,"clockRevision"="clockRevision"+1 WHERE id=$2',
      [at, scope.sessionId],
      scope,
      "event-runtime-human",
    );
  }
  async seed(at = observedAt, available = 0) {
    if (this.seededAt === at) {
      assert.equal(this.available, available, "One observed source identity cannot be rewritten");
      return;
    }
    await this.advance(at);
    for (const stream of ["ORDERS", "REFUNDS", "INVENTORY", "MARKETING"]) {
      const record = canonicalRecord(stream, "one", at);
      record.externalStoreId = scope.externalStoreId;
      record.source.version = `observed:${at}`;
      if (stream === "INVENTORY")
        Object.assign(record, { available, reserved: 0, onHand: available });
      if (stream === "ORDERS") record.items[0].externalSkuId = "one";
      if (stream === "REFUNDS") record.externalOrderId = "one";
      const job = await startJob(this, stream, at);
      const result = await commitPage(this, job, [record], { sourceWatermark: at });
      assert.equal(result.status, "APPLIED");
      assert.equal(result.job.status, "SUCCEEDED");
    }
    this.seededAt = at;
    this.available = available;
  }
  async query(sql, values = []) {
    return this.admin.query(sql, values);
  }
  async connectionGeneration(value) {
    await operatorControl(
      this.admin,
      'UPDATE "PlatformConnection" SET generation=$1 WHERE id=$2',
      [value, scope.connectionId],
      scope,
      "event-runtime-human",
    );
  }
  async counts() {
    const tables = [
      "events",
      "event_evidence",
      "event_evidence_metrics",
      "decision_claims",
      "decision_runs",
      "decision_records",
      "audit_logs",
      "audit_checkpoints",
      "notification_outbox",
      "recipient_inbox",
    ];
    const result = {};
    for (const table of tables)
      result[table] = (
        await this.admin.query(
          `SELECT count(*)::int AS count FROM public.${table} WHERE "organizationId"=$1`,
          [binding.organizationId],
        )
      ).rows[0].count;
    return result;
  }
  async close() {
    if (this.worker) await this.worker.end();
    await this.admin.end();
  }
}

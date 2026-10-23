import assert from "node:assert/strict";
import pg from "pg";
import { requireIsolatedDatabaseUrl } from "./isolated-postgres.mjs";
import { createSourceSession, grantSource, loginUrl } from "./mock-platform-fixture.mjs";
import { createMockSourceWorker } from "../../src/mock-platform/index.ts";
import { connectSyncWorker } from "./sync-host-fixture.mjs";
import { startJob, commitPage, cutoff, opening, window } from "./metric-source-bundle-fixture.mjs";
import { canonicalRecord } from "./canonical-page-fixture.mjs";
import { operatorControl } from "./mock-source-control-fixture.mjs";

export { cutoff, window };
export const scope = {
  organizationId: "legacy-org-metric-api-merchant",
  workspaceId: "legacy-workspace-metric-api-merchant",
  storeId: "metric-api-store",
  connectionId: "metric-api-connection",
  externalStoreId: "mock/metric-api",
  sessionId: "metric-api-session",
  generation: 0,
};
export const binding = Object.fromEntries(
  Object.entries(scope).filter(([key]) => !["sessionId", "generation"].includes(key)),
);
async function syncGrant(admin, current, id) {
  const currentBinding = Object.fromEntries(
    Object.entries(current).filter(([key]) => !["sessionId", "generation"].includes(key)),
  );
  await admin.query(
    'INSERT INTO sync_host."WorkerGrant" (id,"databaseRole","principalUserId","organizationId","workspaceId","storeId","connectionId","externalStoreId",provider,generation,"initialSince") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [
      id,
      "metric_api_sync_login",
      "source-worker",
      ...Object.values(currentBinding),
      "MOCK",
      current.generation,
      opening,
    ],
  );
}
export class MetricsApiFixture {
  constructor(url) {
    this.url = requireIsolatedDatabaseUrl(url);
    this.admin = new pg.Client({ connectionString: url });
  }
  async initialize() {
    await this.admin.connect();
    await this.tenants();
    await createSourceSession(this.admin, scope);
    await this.logins();
    await this.initializeSource(scope, "metric-api-source-grant");
    await syncGrant(this.admin, scope, "metric-api-sync-grant");
    this.worker = await connectSyncWorker(
      this.url,
      "metric_api_sync_login",
      "metric-api-sync-grant",
    );
    await this.advance(cutoff);
  }
  async tenants() {
    await this.admin.query(
      'INSERT INTO "Merchant" (id,name,slug,"updatedAt") VALUES ($1,$1,$1,now())',
      ["metric-api-merchant"],
    );
    for (const [user, role] of [
      ["metric-api-human", "OWNER"],
      ["source-worker", "VIEWER"],
    ])
      await this.admin.query(
        'INSERT INTO "OrganizationMember" (id,"organizationId","userId",role,"updatedAt") VALUES ($1,$2,$3,$4,now())',
        [`metric-api-${user}`, scope.organizationId, user, role],
      );
    await this.admin.query(
      'INSERT INTO "WorkspaceMember" (id,"organizationId","workspaceId","userId") VALUES ($1,$2,$3,$4)',
      ["metric-api-assignment", scope.organizationId, scope.workspaceId, "source-worker"],
    );
    await this.admin.query('INSERT INTO "DemoTenant" ("organizationId") VALUES ($1)', [
      scope.organizationId,
    ]);
    await this.admin.query('UPDATE "TenantBootstrapEnvironment" SET environment=$1', ["DEMO"]);
  }
  async initializeSource(current, grant) {
    await grantSource(this.admin, current, grant, "metric_api_source_login");
    const source = createMockSourceWorker({
      MOCK_PLATFORM_WORKER_DATABASE_URL: loginUrl(this.url, "metric_api_source_login"),
    });
    try {
      assert.equal(
        (await source.initializeGeneration({ grantId: grant }, current)).status,
        "CREATED",
      );
    } finally {
      await source.close();
    }
  }
  async logins() {
    for (const [login, group] of [
      ["metric_api_source_login", "shopmate_mock_source_worker"],
      ["metric_api_sync_login", "shopmate_sync_worker"],
    ]) {
      if (!(await this.admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [login])).rowCount)
        await this.admin.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOBYPASSRLS`);
      await this.admin.query(`GRANT ${group} TO ${login}`);
    }
  }
  async advance(at) {
    await operatorControl(
      this.admin,
      'UPDATE demo."DemoCommerceSession" SET "clockNow"=$1,"clockRevision"="clockRevision"+1 WHERE id=$2',
      [at, scope.sessionId],
      scope,
      "metric-api-human",
    );
  }
  async seed(until = cutoff, correction = false) {
    for (const stream of ["ORDERS", "REFUNDS", "INVENTORY", "MARKETING"]) {
      const record = this.record(stream, correction);
      const job = await startJob(this, stream, until);
      const result = await commitPage(this, job, [record], { sourceWatermark: until });
      assert.equal(result.status, "APPLIED");
      assert.equal(result.job.status, "SUCCEEDED");
    }
  }
  record(stream, correction) {
    const row = canonicalRecord(stream);
    row.externalStoreId = scope.externalStoreId;
    if (correction)
      row.source = { ...row.source, version: "opaque:10", updatedAt: "2026-01-02T12:00:00.000Z" };
    if (stream === "ORDERS")
      Object.assign(row, {
        grossMinor: correction ? 13000 : 12000,
        discountMinor: 2000,
        shippingMinor: 500,
        payableMinor: correction ? 11500 : 10500,
        paidMinor: correction ? 11500 : 10500,
        refundedMinor: 2000,
        items: [
          {
            ...row.items[0],
            unitPriceMinor: correction ? 13000 : 12000,
            grossMinor: correction ? 13000 : 12000,
            discountMinor: 2000,
            netMinor: correction ? 11000 : 10000,
          },
        ],
      });
    if (stream === "REFUNDS")
      Object.assign(row, {
        externalOrderId: "one",
        requestedMinor: 2000,
        succeededMinor: 2000,
        ...(correction ? { succeededAt: "2026-01-02T12:00:00.000Z" } : {}),
      });
    return row;
  }
  async counts() {
    return (
      await this.admin.query(
        'SELECT (SELECT count(*)::int FROM metric_source_bundles WHERE "storeId"=$1) AS archives,(SELECT count(*)::int FROM metric_snapshots WHERE "storeId"=$1) AS snapshots,(SELECT count(*)::int FROM metric_definitions WHERE "storeId"=$1) AS definitions',
        [scope.storeId],
      )
    ).rows[0];
  }
  async membership(active) {
    await this.admin.query('UPDATE "OrganizationMember" SET status=$1 WHERE id=$2', [
      active ? "ACTIVE" : "INACTIVE",
      "metric-api-metric-api-human",
    ]);
  }
  async reset() {
    const current = { ...scope, generation: 1 };
    await operatorControl(
      this.admin,
      'UPDATE "PlatformConnection" SET generation=generation+1 WHERE id=$1',
      [scope.connectionId],
      scope,
      "metric-api-human",
    );
    await this.initializeSource(current, "metric-api-reset-source");
    await syncGrant(this.admin, current, "metric-api-reset-sync");
    await this.worker.end();
    this.worker = await connectSyncWorker(
      this.url,
      "metric_api_sync_login",
      "metric-api-reset-sync",
    );
    await this.advance(cutoff);
    await this.seed();
  }
  async sourceFenceSecurity() {
    return (
      await this.admin.query(`
        SELECT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.metric_snapshots'::regclass
          AND polname='metric_snapshots_current_source' AND NOT polpermissive AND polcmd='r'
          AND polroles=ARRAY['shopmate_metric_source'::regrole::oid]) AS restrictive,
          p.prosecdef AND p.provolatile='s' AND p.proconfig=ARRAY['search_path=pg_catalog']
          AND p.proowner=(SELECT proowner FROM pg_proc WHERE oid='public.metric_source_read(jsonb,jsonb,timestamptz,text)'::regprocedure) AS narrow_owner,
          NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) AS private,
          has_function_privilege('shopmate_metric_source',p.oid,'EXECUTE')
          AND NOT has_function_privilege('shopmate_metric_writer',p.oid,'EXECUTE') AS source_only,
          NOT has_table_privilege('shopmate_metric_api','public.metric_source_bundles','SELECT') AS archive_hidden
        FROM pg_proc p WHERE p.oid='public.metric_source_revision_current(text,text,text,text,text,text)'::regprocedure
      `)
    ).rows[0];
  }
  async conflictDefinition() {
    const other = {
      ...scope,
      storeId: "metric-api-conflict-store",
      connectionId: "metric-api-conflict-connection",
      externalStoreId: "mock/metric-conflict",
      sessionId: "metric-api-conflict-session",
    };
    await createSourceSession(this.admin, other);
    await this.initializeSource(other, "metric-api-conflict-grant");
    await operatorControl(
      this.admin,
      'UPDATE demo."DemoCommerceSession" SET "clockNow"=$1,"clockRevision"="clockRevision"+1 WHERE id=$2',
      [cutoff, other.sessionId],
      other,
      "metric-api-human",
    );
    await syncGrant(this.admin, other, "metric-api-conflict-sync");
    const worker = await connectSyncWorker(
      this.url,
      "metric_api_sync_login",
      "metric-api-conflict-sync",
    );
    try {
      await commitPage({ worker }, await startJob({ worker }, "ORDERS"), []);
    } finally {
      await worker.end();
    }
    const current = Object.fromEntries(
      Object.entries(other).filter(([key]) => !["sessionId", "generation"].includes(key)),
    );
    await this.admin.query(
      'INSERT INTO metric_definitions ("organizationId","workspaceId","storeId","connectionId","externalStoreId",key,"definitionVersion",unit,"definitionHash") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [...Object.values(current), "GMV", "metrics-g4-v1", "minorCNY", `sha256:${"a".repeat(64)}`],
    );
    return current;
  }
  async sourceFailure(action) {
    await this.admin.query(
      "ALTER FUNCTION public.metric_source_capture(jsonb,jsonb,timestamptz) RENAME TO metric_source_capture_unavailable",
    );
    try {
      return await action();
    } finally {
      await this.admin.query(
        "ALTER FUNCTION public.metric_source_capture_unavailable(jsonb,jsonb,timestamptz) RENAME TO metric_source_capture",
      );
    }
  }
  async close() {
    await this.worker?.end();
    await this.admin.end();
  }
}

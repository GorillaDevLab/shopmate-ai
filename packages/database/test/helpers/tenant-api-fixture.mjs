import pg from "pg";
import { URL } from "node:url";
import { requireIsolatedDatabaseUrl } from "./isolated-postgres.mjs";

export async function prepareTenantApiRuntime(url) {
  const client = new pg.Client({ connectionString: requireIsolatedDatabaseUrl(url) });
  await client.connect();
  try {
    if (
      !(await client.query("SELECT 1 FROM pg_roles WHERE rolname='shopmate_tenant_api'")).rowCount
    )
      await client.query("CREATE ROLE shopmate_tenant_api LOGIN NOSUPERUSER NOBYPASSRLS");
    await client.query("GRANT USAGE ON SCHEMA public,demo TO shopmate_tenant_api");
    await client.query(
      'GRANT SELECT ON "Organization","OrganizationMember","Workspace","WorkspaceMember","Store","DemoTenant","TenantBootstrapEnvironment" TO shopmate_tenant_api',
    );
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON public."PlatformConnection",demo."DemoCommerceSession" TO shopmate_tenant_api',
    );
    await client.query('GRANT SELECT,INSERT ON demo."DemoControlAudit" TO shopmate_tenant_api');
    await client.query(
      "GRANT EXECUTE ON FUNCTION demo.has_store_access(TEXT,TEXT,TEXT,BOOLEAN),demo.lock_source_control(TEXT) TO shopmate_tenant_api",
    );
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON demo."DemoFailureRule" TO shopmate_tenant_api',
    );
    await client.query('GRANT SELECT,INSERT ON demo."DemoFailureRuleAudit" TO shopmate_tenant_api');
    await client.query(
      'GRANT USAGE ON SEQUENCE demo."DemoFailureRuleAudit_id_seq" TO shopmate_tenant_api',
    );
    await client.query(
      "GRANT EXECUTE ON FUNCTION demo.has_failure_rule_access(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,BOOLEAN) TO shopmate_tenant_api",
    );
    const runtime = new URL(url);
    runtime.username = "shopmate_tenant_api";
    runtime.password = "";
    return runtime.toString();
  } finally {
    await client.end();
  }
}

export async function prepareMetricApiRuntime(url) {
  const client = new pg.Client({ connectionString: requireIsolatedDatabaseUrl(url) });
  await client.connect();
  try {
    const definitions = [
      ["shopmate_metric_api", "shopmate_metric_source,shopmate_metric_writer"],
      ["shopmate_metric_definition_api", "shopmate_metric_definition_writer"],
    ];
    for (const [login, capabilities] of definitions) {
      if (!(await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [login])).rowCount)
        await client.query(
          `CREATE ROLE ${login} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
        );
      await client.query(`GRANT ${capabilities} TO ${login}`);
    }
    const runtime = new URL(url),
      writer = new URL(url);
    runtime.username = "shopmate_metric_api";
    writer.username = "shopmate_metric_definition_api";
    runtime.password = writer.password = "";
    return {
      METRIC_DATABASE_URL: runtime.toString(),
      METRIC_DEFINITION_DATABASE_URL: writer.toString(),
    };
  } finally {
    await client.end();
  }
}

export class TenantApiFixture {
  constructor(url) {
    this.client = new pg.Client({ connectionString: requireIsolatedDatabaseUrl(url) });
  }
  async initialize() {
    await this.client.connect();
    for (const key of ["a", "b"]) {
      await this.client.query(
        'INSERT INTO "Merchant" (id,name,slug,"updatedAt") VALUES ($1,$1,$1,now())',
        [`api-merchant-${key}`],
      );
      await this.client.query(
        'INSERT INTO "OrganizationMember" (id,"organizationId","userId",role,"updatedAt") VALUES ($1,$2,$3,$4,now())',
        [`api-member-${key}`, `legacy-org-api-merchant-${key}`, `api-user-${key}`, "OWNER"],
      );
      await this.client.query(
        'INSERT INTO "WorkspaceMember" (id,"organizationId","workspaceId","userId") VALUES ($1,$2,$3,$4)',
        [
          `api-grant-${key}`,
          `legacy-org-api-merchant-${key}`,
          `legacy-workspace-api-merchant-${key}`,
          `api-user-${key}`,
        ],
      );
    }
    await this.client.query(
      'INSERT INTO "Workspace" (id,"organizationId",name,slug,"updatedAt") VALUES ($1,$2,$1,$1,now())',
      ["api-unassigned-a", "legacy-org-api-merchant-a"],
    );
  }
  async reset() {
    await this.client.query('UPDATE "OrganizationMember" SET role=$1,status=$2 WHERE id=$3', [
      "OWNER",
      "ACTIVE",
      "api-member-a",
    ]);
    await this.client.query('UPDATE "Organization" SET status=$1 WHERE id=$2', [
      "ACTIVE",
      "legacy-org-api-merchant-a",
    ]);
    await this.client.query('UPDATE "Workspace" SET status=$1 WHERE "organizationId"=$2', [
      "ACTIVE",
      "legacy-org-api-merchant-a",
    ]);
    await this.client.query('UPDATE "WorkspaceMember" SET status=$1 WHERE id=$2', [
      "ACTIVE",
      "api-grant-a",
    ]);
  }
  async setRole(role) {
    await this.client.query('UPDATE "OrganizationMember" SET role=$1 WHERE id=$2', [
      role,
      "api-member-a",
    ]);
  }
  async disableMembership() {
    await this.client.query('UPDATE "OrganizationMember" SET status=$1 WHERE id=$2', [
      "INACTIVE",
      "api-member-a",
    ]);
  }
  async suspendOrganization() {
    await this.client.query('UPDATE "Organization" SET status=$1 WHERE id=$2', [
      "SUSPENDED",
      "legacy-org-api-merchant-a",
    ]);
  }
  async suspendWorkspace() {
    await this.client.query('UPDATE "Workspace" SET status=$1 WHERE id=$2', [
      "SUSPENDED",
      "legacy-workspace-api-merchant-a",
    ]);
  }
  async revokeWorkspace() {
    await this.client.query('UPDATE "WorkspaceMember" SET status=$1 WHERE id=$2', [
      "INACTIVE",
      "api-grant-a",
    ]);
  }
  async close() {
    await this.client.end();
  }
}

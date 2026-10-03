import pg from "pg";
import { requireIsolatedDatabaseUrl } from "./isolated-postgres.mjs";

export class DemoCommerceApiFixture {
  constructor(url) {
    this.client = new pg.Client({ connectionString: requireIsolatedDatabaseUrl(url) });
  }
  async initialize() {
    await this.client.connect();
    for (const key of ["a", "b"]) await this.tenant(key);
    await this.client.query(
      'INSERT INTO "Workspace" (id,"organizationId",name,slug,"updatedAt") VALUES ($1,$2,$1,$1,now())',
      ["demo-api-unassigned-a", "legacy-org-demo-api-merchant-a"],
    );
    await this.client.query(
      'INSERT INTO "Store" (id,"merchantId",name,city,platform,"organizationId","workspaceId") VALUES ($1,$2,$1,$3,$4,$5,$6)',
      [
        "demo-api-store-unassigned",
        "demo-api-merchant-a",
        "Shanghai",
        "MOCK",
        "legacy-org-demo-api-merchant-a",
        "demo-api-unassigned-a",
      ],
    );
    await this.client.query(
      'INSERT INTO "Store" (id,"merchantId",name,city,platform) VALUES ($1,$2,$1,$3,$4)',
      ["demo-api-store-a2", "demo-api-merchant-a", "Shanghai", "MOCK"],
    );
  }
  async tenant(key) {
    const merchant = `demo-api-merchant-${key}`;
    const organization = `legacy-org-${merchant}`;
    await this.client.query(
      'INSERT INTO "Merchant" (id,name,slug,"updatedAt") VALUES ($1,$1,$1,now())',
      [merchant],
    );
    await this.client.query(
      'INSERT INTO "Store" (id,"merchantId",name,city,platform) VALUES ($1,$2,$1,$3,$4)',
      [`demo-api-store-${key}`, merchant, "Shanghai", "MOCK"],
    );
    await this.client.query(
      'INSERT INTO "OrganizationMember" (id,"organizationId","userId",role,"updatedAt") VALUES ($1,$2,$3,$4,now())',
      [`demo-api-member-${key}`, organization, `demo-api-user-${key}`, "OWNER"],
    );
    await this.client.query(
      'INSERT INTO "WorkspaceMember" (id,"organizationId","workspaceId","userId") VALUES ($1,$2,$3,$4)',
      [
        `demo-api-grant-${key}`,
        organization,
        `legacy-workspace-${merchant}`,
        `demo-api-user-${key}`,
      ],
    );
    await this.client.query('INSERT INTO "DemoTenant" ("organizationId") VALUES ($1)', [
      organization,
    ]);
  }
  async reset() {
    const organization = "legacy-org-demo-api-merchant-a";
    await this.client.query(
      'DELETE FROM demo."DemoControlAudit" WHERE "organizationId" = ANY($1::text[])',
      [[organization, "legacy-org-demo-api-merchant-b"]],
    );
    await this.client.query(
      'DELETE FROM demo."DemoCommerceSession" WHERE "organizationId" = ANY($1::text[])',
      [[organization, "legacy-org-demo-api-merchant-b"]],
    );
    await this.client.query(
      'DELETE FROM "PlatformConnection" WHERE "organizationId" = ANY($1::text[])',
      [[organization, "legacy-org-demo-api-merchant-b"]],
    );
    await this.client.query('UPDATE "OrganizationMember" SET role=$1,status=$2 WHERE id=$3', [
      "OWNER",
      "ACTIVE",
      "demo-api-member-a",
    ]);
    await this.client.query('UPDATE "Organization" SET status=$1 WHERE id=$2', [
      "ACTIVE",
      organization,
    ]);
    await this.client.query('UPDATE "Workspace" SET status=$1 WHERE "organizationId"=$2', [
      "ACTIVE",
      organization,
    ]);
    await this.client.query('UPDATE "WorkspaceMember" SET status=$1 WHERE id=$2', [
      "ACTIVE",
      "demo-api-grant-a",
    ]);
    await this.client.query(
      'INSERT INTO "DemoTenant" ("organizationId") VALUES ($1) ON CONFLICT DO NOTHING',
      [organization],
    );
    await this.setMarker("DEMO");
  }
  async setRole(role) {
    await this.client.query('UPDATE "OrganizationMember" SET role=$1 WHERE id=$2', [
      role,
      "demo-api-member-a",
    ]);
  }
  async disableMembership() {
    await this.client.query('UPDATE "OrganizationMember" SET status=$1 WHERE id=$2', [
      "INACTIVE",
      "demo-api-member-a",
    ]);
  }
  async suspendOrganization() {
    await this.client.query('UPDATE "Organization" SET status=$1 WHERE id=$2', [
      "SUSPENDED",
      "legacy-org-demo-api-merchant-a",
    ]);
  }
  async suspendWorkspace() {
    await this.client.query('UPDATE "Workspace" SET status=$1 WHERE id=$2', [
      "SUSPENDED",
      "legacy-workspace-demo-api-merchant-a",
    ]);
  }
  async revokeWorkspace() {
    await this.client.query('UPDATE "WorkspaceMember" SET status=$1 WHERE id=$2', [
      "INACTIVE",
      "demo-api-grant-a",
    ]);
  }
  async setMarker(marker) {
    await this.client.query('UPDATE "TenantBootstrapEnvironment" SET environment=$1 WHERE id=$2', [
      marker,
      "singleton",
    ]);
  }
  async removeDemoTenant() {
    await this.client.query('DELETE FROM "DemoTenant" WHERE "organizationId"=$1', [
      "legacy-org-demo-api-merchant-a",
    ]);
  }
  async snapshot(storeId) {
    const session = await this.client.query(
      'SELECT * FROM demo."DemoCommerceSession" WHERE "storeId"=$1',
      [storeId],
    );
    const audit = await this.client.query(
      'SELECT * FROM demo."DemoControlAudit" WHERE "storeId"=$1 ORDER BY "afterRevision"',
      [storeId],
    );
    return { session: session.rows, audit: audit.rows };
  }
  async close() {
    await this.client.end();
  }
}

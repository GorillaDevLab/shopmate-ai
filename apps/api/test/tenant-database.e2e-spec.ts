import "reflect-metadata";
import { randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { canAccessTenantResource } from "@shopmate/contracts";
import { disconnectPrismaClient, getPrismaClient } from "@shopmate/database";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TenantApiFixture } from "../../../packages/database/test/helpers/tenant-api-fixture.mjs";
import { AuthPermission, createAuthContext } from "../src/auth/contracts/index.js";
import { signDemoSession } from "../src/auth/session/demo-session.js";
import { DEMO_SESSION_COOKIE_NAME } from "../src/auth/session/demo-session-cookie.js";

const operatorUrl = process.env.TENANT_TEST_OPERATOR_URL;
if (!operatorUrl || !process.env.DATABASE_URL)
  throw new Error(
    "Run pnpm test:tenant with an isolated PostgreSQL database; this suite cannot be skipped",
  );
const signingKey = randomBytes(48).toString("hex");
const fixture = new TenantApiFixture(operatorUrl);
function cookie(key = "a") {
  const identity = createAuthContext({
    userId: `api-user-${key}`,
    merchantId: `api-merchant-${key}`,
    permissions: Object.values(AuthPermission),
  });
  return `${DEMO_SESSION_COOKIE_NAME}=${signDemoSession(identity, signingKey, 3600).token}`;
}

describe("Tenant API isolation against real PostgreSQL and a role without RLS bypass", () => {
  let app: INestApplication;
  beforeAll(async () => {
    await fixture.initialize();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DEMO_AUTH_EMAIL", "fixture@example.test");
    vi.stubEnv("DEMO_AUTH_PASSWORD", randomBytes(24).toString("hex"));
    vi.stubEnv("DEMO_AUTH_USER_ID", "api-user-a");
    vi.stubEnv("DEMO_AUTH_MERCHANT_ID", "api-merchant-a");
    vi.stubEnv("DEMO_SESSION_SECRET", signingKey);
    const [{ AppModule }, { configureApp }] = await Promise.all([
      import("../src/app.module.js"),
      import("../src/app.config.js"),
    ]);
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
  });
  beforeEach(async () => {
    await fixture.reset();
  });
  afterAll(async () => {
    if (app) await app.close();
    await disconnectPrismaClient();
    await fixture.close();
    vi.unstubAllEnvs();
  });

  it("uses a non-owner database role and sees no rows outside verified identity transactions", async () => {
    const roles = await getPrismaClient().$queryRaw<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
    expect(roles).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    expect(await getPrismaClient().organization.count()).toBe(0);
  });
  it("requires a valid session", async () => {
    await request(app.getHttpServer()).get("/api/v1/tenant/context").expect(401);
  });
  it("keeps tenant A and B contexts independent", async () => {
    const a = await request(app.getHttpServer())
      .get("/api/v1/tenant/context")
      .set("Cookie", cookie())
      .expect(200);
    const b = await request(app.getHttpServer())
      .get("/api/v1/tenant/context")
      .set("Cookie", cookie("b"))
      .expect(200);
    expect(a.body.organizationId).toBe("legacy-org-api-merchant-a");
    expect(b.body.organizationId).toBe("legacy-org-api-merchant-b");
    await request(app.getHttpServer())
      .get("/api/v1/tenant/workspaces/legacy-workspace-api-merchant-b")
      .set("Cookie", cookie())
      .expect(404);
  });
  it("reflects a role downgrade on the same signed cookie", async () => {
    const session = cookie();
    const owner = await request(app.getHttpServer())
      .get("/api/v1/tenant/context")
      .set("Cookie", session)
      .expect(200);
    expect(owner.body.permissions).toContain("actions:approve");
    await fixture.setRole("VIEWER");
    const viewer = await request(app.getHttpServer())
      .get("/api/v1/tenant/context")
      .set("Cookie", session)
      .expect(200);
    expect(viewer.body.role).toBe("VIEWER");
    expect(
      canAccessTenantResource(
        viewer.body,
        { organizationId: viewer.body.organizationId },
        "actions:approve",
      ),
    ).toBe(false);
  });
  it("allows owners but denies viewers an unassigned workspace", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/tenant/workspaces/api-unassigned-a")
      .set("Cookie", cookie())
      .expect(200);
    await fixture.setRole("VIEWER");
    await request(app.getHttpServer())
      .get("/api/v1/tenant/workspaces/api-unassigned-a")
      .set("Cookie", cookie())
      .expect(404);
  });
  it.each(["disableMembership", "suspendOrganization", "suspendWorkspace"] as const)(
    "rejects access after %s",
    async (operation) => {
      await fixture[operation]();
      await request(app.getHttpServer())
        .get("/api/v1/tenant/context")
        .set("Cookie", cookie())
        .expect(404);
    },
  );
  it("rejects a revoked workspace grant without reissuing the cookie", async () => {
    await fixture.setRole("VIEWER");
    await fixture.revokeWorkspace();
    await request(app.getHttpServer())
      .get("/api/v1/tenant/context")
      .set("Cookie", cookie())
      .expect(404);
  });
  it("clears connection scope after parallel tenant requests", async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        request(app.getHttpServer())
          .get("/api/v1/tenant/context")
          .set("Cookie", cookie(index % 2 ? "a" : "b"))
          .expect(200),
      ),
    );
    expect(await getPrismaClient().workspace.count()).toBe(0);
  });
});

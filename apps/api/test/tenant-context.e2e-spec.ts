import "reflect-metadata";
import { randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canAccessTenantResource } from "@shopmate/contracts";
import { DemoAuthModule } from "../src/auth/demo-auth.module.js";
import { AuthPermission, createAuthContext } from "../src/auth/contracts/index.js";
import { signDemoSession } from "../src/auth/session/demo-session.js";
import { DEMO_SESSION_COOKIE_NAME } from "../src/auth/session/demo-session-cookie.js";
import { configureApp } from "../src/app.config.js";
import { TENANT_MEMBERSHIP_REPOSITORY } from "../src/tenant/tenant-membership.repository.js";
import { TenantModule } from "../src/tenant/tenant.module.js";

const signingKey = randomBytes(48).toString("hex");
const read = vi.fn();
function cookie(userId = "user-a", merchantId = "merchant-a") {
  const context = createAuthContext({
    userId,
    merchantId,
    permissions: Object.values(AuthPermission),
  });
  return `${DEMO_SESSION_COOKIE_NAME}=${signDemoSession(context, signingKey, 3600).token}`;
}

describe("Tenant API trusts current membership rather than cookie permissions", () => {
  let app: INestApplication;
  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DEMO_AUTH_EMAIL", "fixture@example.test");
    vi.stubEnv("DEMO_AUTH_PASSWORD", randomBytes(24).toString("hex"));
    vi.stubEnv("DEMO_AUTH_USER_ID", "user-a");
    vi.stubEnv("DEMO_AUTH_MERCHANT_ID", "merchant-a");
    vi.stubEnv("DEMO_SESSION_SECRET", signingKey);
    const module = await Test.createTestingModule({ imports: [DemoAuthModule, TenantModule] })
      .overrideProvider(TENANT_MEMBERSHIP_REPOSITORY)
      .useValue({ resolve: read })
      .compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });
  beforeEach(() => {
    read.mockReset();
    read.mockImplementation(async (userId: string, merchantId: string, workspaceId?: string) => {
      if (
        userId !== "user-a" ||
        merchantId !== "merchant-a" ||
        (workspaceId && workspaceId !== "workspace-a")
      )
        return null;
      return {
        userId,
        merchantId,
        organizationId: "organization-a",
        workspaceId: "workspace-a",
        role: "VIEWER",
      };
    });
  });
  it("requires authentication before membership lookup", async () => {
    await request(app.getHttpServer()).get("/api/v1/tenant/context").expect(401);
    expect(read).not.toHaveBeenCalled();
  });
  it("derives viewer permissions despite a cookie containing product write permissions", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/tenant/context")
      .set("Cookie", cookie())
      .expect(200);
    expect(response.body.role).toBe("VIEWER");
    expect(response.body.permissions).not.toContain("products:write");
    expect(
      canAccessTenantResource(
        response.body,
        { organizationId: "organization-a" },
        "actions:approve",
      ),
    ).toBe(false);
    expect(read).toHaveBeenCalledWith("user-a", "merchant-a", undefined);
  });
  it.each(["workspace-b", "unassigned-a"])(
    "hides foreign or unassigned workspace %s",
    async (id) => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/tenant/workspaces/${id}`)
        .set("Cookie", cookie())
        .expect(404);
      expect(response.body).toEqual({
        statusCode: 404,
        code: "RESOURCE_NOT_FOUND",
        message: "资源不存在",
      });
    },
  );
  it("resolves an authorized workspace selected by header or path", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/tenant/context")
      .set("X-Workspace-Id", "workspace-a")
      .set("Cookie", cookie())
      .expect(200);
    const response = await request(app.getHttpServer())
      .get("/api/v1/tenant/workspaces/workspace-a")
      .set("Cookie", cookie())
      .expect(200);
    expect(response.body).toEqual({ id: "workspace-a", organizationId: "organization-a" });
  });
  it.each(["bad id", "x".repeat(129), "workspace-a,workspace-a", ""])(
    "rejects malformed/duplicate workspace header %s",
    async (header) => {
      await request(app.getHttpServer())
        .get("/api/v1/tenant/context")
        .set("X-Workspace-Id", header)
        .set("Cookie", cookie())
        .expect(400);
      expect(read).not.toHaveBeenCalled();
    },
  );
  it("rejects a header that disagrees with the resource path", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/tenant/workspaces/workspace-a")
      .set("X-Workspace-Id", "workspace-b")
      .set("Cookie", cookie())
      .expect(400);
  });
  it.each(["organizationId", "tenantId", "workspaceId", "role", "permissions", "userId"])(
    "rejects query scope override %s",
    async (field) => {
      await request(app.getHttpServer())
        .get(`/api/v1/tenant/context?${field}=foreign`)
        .set("Cookie", cookie())
        .expect(404);
    },
  );
  it("rejects request body scope overrides", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/tenant/context")
      .set("Cookie", cookie())
      .send({ organizationId: "foreign" })
      .expect(404);
  });
  it("hides unknown memberships and uses fresh lookup on each request", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/tenant/context")
      .set("Cookie", cookie("user-b", "merchant-b"))
      .expect(404);
    await request(app.getHttpServer())
      .get("/api/v1/tenant/context")
      .set("Cookie", cookie())
      .expect(200);
    read.mockResolvedValue(null);
    await request(app.getHttpServer())
      .get("/api/v1/tenant/context")
      .set("Cookie", cookie())
      .expect(404);
  });
  it("masks database errors without exposing details", async () => {
    read.mockRejectedValue(new Error("private database detail"));
    const response = await request(app.getHttpServer())
      .get("/api/v1/tenant/context")
      .set("Cookie", cookie())
      .expect(503);
    expect(JSON.stringify(response.body)).not.toContain("private");
  });
});

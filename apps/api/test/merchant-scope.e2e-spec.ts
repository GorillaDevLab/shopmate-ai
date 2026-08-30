import "reflect-metadata";

import { Body, Controller, Get, Param, Post, Query, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  AuthPermission,
  createAuthContext,
  type AuthContext,
} from "../src/auth/contracts/index.js";
import { MerchantContext } from "../src/auth/access/merchant-context.decorator.js";
import { DEMO_SESSION_COOKIE_NAME } from "../src/auth/session/demo-session-cookie.js";
import { signDemoSession } from "../src/auth/session/demo-session.js";

const signingKey = "test-session-key-with-at-least-32-characters";

@Controller({ path: "scope-probe", version: "1" })
class ScopeProbeController {
  @Get()
  read(@MerchantContext() context: AuthContext): AuthContext {
    return context;
  }

  @Post()
  write(@MerchantContext() context: AuthContext, @Body() body: object): AuthContext {
    void body;
    return context;
  }

  @Get(":merchantId")
  byMerchant(
    @MerchantContext() context: AuthContext,
    @Param("merchantId") merchantId: string,
  ): AuthContext {
    void merchantId;
    return context;
  }

  @Get("search/by-query")
  byQuery(
    @MerchantContext() context: AuthContext,
    @Query("merchantId") merchantId?: string,
  ): AuthContext {
    void merchantId;
    return context;
  }
}

describe("Merchant Scope 守卫", () => {
  let app: INestApplication;
  let validCookie: string;

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DEMO_AUTH_EMAIL", "owner@shopmate.co.nz");
    vi.stubEnv("DEMO_AUTH_PASSWORD", "demo-pass-2026");
    vi.stubEnv("DEMO_AUTH_USER_ID", "demo-user");
    vi.stubEnv("DEMO_AUTH_MERCHANT_ID", "demo-merchant");
    vi.stubEnv("DEMO_SESSION_SECRET", signingKey);
    vi.stubEnv("DEMO_SESSION_TTL_SECONDS", "3600");

    const [{ AppModule }, { configureApp }] = await Promise.all([
      import("../src/app.module.js"),
      import("../src/app.config.js"),
    ]);
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ScopeProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    const login = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "owner@shopmate.co.nz", password: "demo-pass-2026" })
      .expect(200);
    validCookie = login.headers["set-cookie"][0].split(";")[0];
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it("保持健康检查和登录端点公开", async () => {
    await request(app.getHttpServer()).get("/api/v1/health").expect(200);
    await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "owner@shopmate.co.nz", password: "demo-pass-2026" })
      .expect(200);
  });

  it("拒绝未认证请求", async () => {
    const response = await request(app.getHttpServer()).get("/api/v1/scope-probe").expect(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "UNAUTHENTICATED",
      message: "请先登录",
    });
  });

  it("从签名会话提供可信 Merchant 上下文", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/scope-probe")
      .set("Cookie", validCookie)
      .expect(200);
    expect(response.body).toEqual({
      userId: "demo-user",
      merchantId: "demo-merchant",
      permissions: Object.values(AuthPermission),
    });
  });

  it("允许会话 Cookie 与普通 Cookie 并存", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/scope-probe")
      .set("Cookie", `theme=dark; ${validCookie}; locale=zh-CN`)
      .expect(200);
  });

  it.each([
    ["被篡改", () => `${validCookie}x`],
    ["重复", () => `${validCookie}; ${validCookie}`],
    [
      "已过期",
      () => {
        const context = createAuthContext({
          userId: "demo-user",
          merchantId: "demo-merchant",
          permissions: Object.values(AuthPermission),
        });
        const expired = signDemoSession(context, signingKey, 60, Date.now() - 120_000);
        return `${DEMO_SESSION_COOKIE_NAME}=${expired.token}`;
      },
    ],
  ])("拒绝%s的会话 Cookie", async (_label, cookieFactory) => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/scope-probe")
      .set("Cookie", cookieFactory())
      .expect(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "UNAUTHENTICATED",
      message: "请先登录",
    });
  });

  it.each([
    ["路径", () => request(app.getHttpServer()).get("/api/v1/scope-probe/other-merchant")],
    [
      "查询参数",
      () =>
        request(app.getHttpServer()).get("/api/v1/scope-probe/search/by-query?merchantId=other"),
    ],
    [
      "请求体",
      () => request(app.getHttpServer()).post("/api/v1/scope-probe").send({ merchantId: "other" }),
    ],
  ])("用统一 404 拒绝客户端通过%s覆盖 Merchant Scope", async (_label, buildRequest) => {
    const response = await buildRequest().set("Cookie", validCookie).expect(404);
    expect(response.body).toEqual({
      statusCode: 404,
      code: "RESOURCE_NOT_FOUND",
      message: "资源不存在",
    });
  });
});

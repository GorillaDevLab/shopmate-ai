import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

describe("Demo 登录 API", () => {
  let app: INestApplication;

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEMO_AUTH_EMAIL", "owner@shopmate.co.nz");
    vi.stubEnv("DEMO_AUTH_PASSWORD", "demo-pass-2026");
    vi.stubEnv("DEMO_AUTH_USER_ID", "demo-user");
    vi.stubEnv("DEMO_AUTH_MERCHANT_ID", "demo-merchant");
    vi.stubEnv("DEMO_SESSION_SECRET", "test-session-secret-with-at-least-32-characters");
    vi.stubEnv("DEMO_SESSION_TTL_SECONDS", "3600");
    const [{ AppModule }, { configureApp }] = await Promise.all([
      import("../src/app.module.js"),
      import("../src/app.config.js"),
    ]);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it("登录成功并设置安全的 HttpOnly Cookie", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "OWNER@SHOPMATE.CO.NZ", password: "demo-pass-2026" })
      .expect(200);

    expect(response.body).toMatchObject({ message: "登录成功" });
    expect(response.body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(response.headers["set-cookie"][0]).toContain("shopmate_demo_session=");
    expect(response.headers["set-cookie"][0]).toContain("HttpOnly");
    expect(response.headers["set-cookie"][0]).toContain("SameSite=Lax");
    expect(response.headers["set-cookie"][0]).toContain("Secure");
  });

  it("错误凭据返回稳定中文错误", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "owner@shopmate.co.nz", password: "wrong-password" })
      .expect(401);

    expect(response.body).toEqual({
      statusCode: 401,
      code: "INVALID_CREDENTIALS",
      message: "邮箱或密码错误",
    });
  });

  it("拒绝客户端提交 merchantId", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({
        email: "owner@shopmate.co.nz",
        password: "demo-pass-2026",
        merchantId: "attacker-merchant",
      })
      .expect(400);
  });
});

describe("Demo 登录配置不完整", () => {
  let app: INestApplication;

  beforeAll(async () => {
    vi.stubEnv("DEMO_AUTH_EMAIL", "owner@shopmate.co.nz");
    const [{ AppModule }, { configureApp }] = await Promise.all([
      import("../src/app.module.js"),
      import("../src/app.config.js"),
    ]);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it("健康检查仍可用且登录返回中文 503", async () => {
    await request(app.getHttpServer()).get("/api/v1/health").expect(200);
    const response = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "owner@shopmate.co.nz", password: "demo-pass-2026" })
      .expect(503);

    expect(response.body).toEqual({
      statusCode: 503,
      code: "AUTH_NOT_CONFIGURED",
      message: "Demo 登录服务尚未配置",
    });
  });
});

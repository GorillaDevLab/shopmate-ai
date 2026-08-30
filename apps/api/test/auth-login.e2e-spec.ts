import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("Demo 登录 API", () => {
  let app: INestApplication;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      DEMO_AUTH_EMAIL: "owner@shopmate.co.nz",
      DEMO_AUTH_PASSWORD: "demo-pass-2026",
      DEMO_AUTH_USER_ID: "demo-user",
      DEMO_AUTH_MERCHANT_ID: "demo-merchant",
      DEMO_SESSION_SECRET: "test-session-secret-with-at-least-32-characters",
      DEMO_SESSION_TTL_SECONDS: "3600",
    });
    const [{ AppModule }, { configureApp }] = await Promise.all([
      import("../src/app.module.js"),
      import("../src/app.config.js"),
    ]);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => app.close());

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

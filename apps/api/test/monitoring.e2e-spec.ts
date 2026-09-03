import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

describe("Monitoring API", () => {
  let app: INestApplication;
  let cookie: string;

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DEMO_AUTH_EMAIL", "owner@shopmate.co.nz");
    vi.stubEnv("DEMO_AUTH_PASSWORD", "demo-pass-2026");
    vi.stubEnv("DEMO_AUTH_USER_ID", "demo-user");
    vi.stubEnv("DEMO_AUTH_MERCHANT_ID", "demo-merchant");
    vi.stubEnv("DEMO_SESSION_SECRET", "test-session-key-with-at-least-32-characters");
    vi.stubEnv("DEMO_SESSION_TTL_SECONDS", "3600");
    const [{ AppModule }, { configureApp }] = await Promise.all([
      import("../src/app.module.js"),
      import("../src/app.config.js"),
    ]);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    const login = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "owner@shopmate.co.nz", password: "demo-pass-2026" })
      .expect(200);
    cookie = login.headers["set-cookie"][0].split(";")[0];
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it("所有监听端点默认需要登录", async () => {
    await request(app.getHttpServer()).get("/api/v1/monitoring/rules").expect(401);
  });

  it("预览拒绝客户端提交 Merchant 身份", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/v1/monitoring/rules/preview")
      .set("Cookie", cookie)
      .send({ question: "库存低于 10 件提醒", merchantId: "other" })
      .expect(404);
    expect(response.body).toEqual({
      statusCode: 404,
      code: "RESOURCE_NOT_FOUND",
      message: "资源不存在",
    });
  });
});

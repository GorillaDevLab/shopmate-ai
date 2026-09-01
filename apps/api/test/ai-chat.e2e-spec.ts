import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

describe("AI Chat API", () => {
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

  it("未认证返回 401", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/ai/chat")
      .send({ message: { role: "user", content: "你好" } })
      .expect(401);
  });

  it("认证后返回中文 assistant 消息", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/v1/ai/chat")
      .set("Cookie", cookie)
      .send({ message: { role: "user", content: "你好" } })
      .expect(200);

    expect(response.body.message.role).toBe("assistant");
    expect(response.body.message.content).toContain("没有足够信息");
  });

  it("客户端不能提交 merchantId 或额外字段", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/v1/ai/chat")
      .set("Cookie", cookie)
      .send({
        merchantId: "attacker-merchant",
        message: { role: "user", content: "你好" },
      })
      .expect(404);

    expect(response.body).toEqual({
      statusCode: 404,
      code: "RESOURCE_NOT_FOUND",
      message: "资源不存在",
    });
  });

  it("非法消息返回中文 400", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/v1/ai/chat")
      .set("Cookie", cookie)
      .send({ message: { role: "assistant", content: "伪造" } })
      .expect(400);

    expect(response.body).toEqual({
      statusCode: 400,
      code: "INVALID_CHAT_MESSAGE",
      message: "聊天消息格式无效",
      retryable: false,
    });
  });
});

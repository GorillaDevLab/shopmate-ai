import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AnalyticsLayoutService } from "../src/analytics/analytics-layout.service.js";

describe("经营分析布局 API", () => {
  let app: INestApplication;
  let cookie: string;
  const layoutService = { get: vi.fn(), save: vi.fn() };

  beforeAll(async () => {
    configureTestEnvironment();
    const [{ AppModule }, { configureApp }] = await Promise.all([
      import("../src/app.module.js"),
      import("../src/app.config.js"),
    ]);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AnalyticsLayoutService)
      .useValue(layoutService)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    cookie = await login(app);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    layoutService.get.mockResolvedValue({ ok: true });
    layoutService.save.mockResolvedValue({ ok: true });
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it("未登录读取与保存都返回 401 且不触达布局服务", async () => {
    await request(app.getHttpServer()).get("/api/v1/analytics/layout").expect(401);
    await request(app.getHttpServer()).put("/api/v1/analytics/layout").send({}).expect(401);
    expect(layoutService.get).not.toHaveBeenCalled();
    expect(layoutService.save).not.toHaveBeenCalled();
  });

  it("登录后按会话中的用户与商家读写，请求体原样交给服务校验", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/analytics/layout")
      .set("Cookie", cookie)
      .expect(200);
    const body = { layout: { version: 1, cards: [] }, expectedRevision: 0 };
    await request(app.getHttpServer())
      .put("/api/v1/analytics/layout")
      .set("Cookie", cookie)
      .send(body)
      .expect(200);
    expect(layoutService.save).toHaveBeenCalledWith(
      expect.objectContaining({ merchantId: "demo-merchant" }),
      body,
    );
  });

  it("请求里夹带 merchantId 时拒绝，防止越权写其他商家", async () => {
    await request(app.getHttpServer())
      .put("/api/v1/analytics/layout")
      .set("Cookie", cookie)
      .send({ merchantId: "other", layout: { version: 1, cards: [] }, expectedRevision: 0 })
      .expect(404);
    expect(layoutService.save).not.toHaveBeenCalled();
  });
});

function configureTestEnvironment(): void {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DEMO_AUTH_EMAIL", "owner@shopmate.co.nz");
  vi.stubEnv("DEMO_AUTH_PASSWORD", "demo-pass-2026");
  vi.stubEnv("DEMO_AUTH_USER_ID", "demo-user");
  vi.stubEnv("DEMO_AUTH_MERCHANT_ID", "demo-merchant");
  vi.stubEnv("DEMO_SESSION_SECRET", "test-session-key-with-at-least-32-characters");
  vi.stubEnv("DEMO_SESSION_TTL_SECONDS", "3600");
}

async function login(app: INestApplication): Promise<string> {
  const response = await request(app.getHttpServer())
    .post("/api/v1/auth/login")
    .send({ email: "owner@shopmate.co.nz", password: "demo-pass-2026" })
    .expect(200);
  return response.headers["set-cookie"][0].split(";")[0];
}

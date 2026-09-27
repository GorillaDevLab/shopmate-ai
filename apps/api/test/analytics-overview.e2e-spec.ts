import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AnalyticsOverviewService } from "../src/analytics/analytics-overview.service.js";

describe("经营分析 Overview API", () => {
  let app: INestApplication;
  let cookie: string;
  const overviewService = { get: vi.fn() };

  beforeAll(async () => {
    configureTestEnvironment();
    const [{ AppModule }, { configureApp }] = await Promise.all([
      import("../src/app.module.js"),
      import("../src/app.config.js"),
    ]);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AnalyticsOverviewService)
      .useValue(overviewService)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    cookie = await login(app);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    overviewService.get.mockResolvedValue({ ok: true });
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it("未登录请求返回 401 且不触达统计服务", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/analytics/overview?asOfDate=2026-08-31")
      .expect(401);
    expect(overviewService.get).not.toHaveBeenCalled();
  });

  it("登录后以会话中的商家身份查询，并透传日期参数", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/analytics/overview?asOfDate=2026-08-31&startDate=2026-08-02")
      .set("Cookie", cookie)
      .expect(200);
    expect(overviewService.get).toHaveBeenCalledWith(
      expect.objectContaining({ merchantId: "demo-merchant" }),
      { asOfDate: "2026-08-31", startDate: "2026-08-02" },
    );
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

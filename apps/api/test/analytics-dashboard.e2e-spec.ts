import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardService } from "../src/analytics/dashboard.service.js";
import { LowStockService } from "../src/analytics/low-stock.service.js";
import { ProductPerformanceService } from "../src/analytics/product-performance.service.js";

describe("经营看板 Analytics API", () => {
  let app: INestApplication;
  let cookie: string;
  const dashboardService = { summarize: vi.fn() };
  const lowStockService = { analyze: vi.fn() };
  const productPerformanceService = { analyze: vi.fn() };

  beforeAll(async () => {
    configureTestEnvironment();
    const [{ AppModule }, { configureApp }] = await Promise.all([
      import("../src/app.module.js"),
      import("../src/app.config.js"),
    ]);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DashboardService)
      .useValue(dashboardService)
      .overrideProvider(LowStockService)
      .useValue(lowStockService)
      .overrideProvider(ProductPerformanceService)
      .useValue(productPerformanceService)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    cookie = await login(app);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    dashboardService.summarize.mockResolvedValue(summaryFixture);
    lowStockService.analyze.mockResolvedValue({ risks: [] });
    productPerformanceService.analyze.mockResolvedValue({ hotSellers: [] });
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it("未登录请求返回 401", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/analytics/dashboard?asOfDate=2026-08-31")
      .expect(401);
  });

  it("带区间的请求同样鉴权并把区间传入所有统计服务", async () => {
    const path = "/api/v1/analytics/dashboard?asOfDate=2026-08-31&startDate=2026-08-02";
    await request(app.getHttpServer()).get(path).expect(401);
    await request(app.getHttpServer()).get(path).set("Cookie", cookie).expect(200);
    for (const method of [
      dashboardService.summarize,
      lowStockService.analyze,
      productPerformanceService.analyze,
    ]) {
      expect(method).toHaveBeenCalledWith(
        expect.objectContaining({ merchantId: "demo-merchant" }),
        "2026-08-31",
        "2026-08-02",
      );
    }
    await request(app.getHttpServer())
      .get(`${path}&merchantId=other`)
      .set("Cookie", cookie)
      .expect(404);
    await request(app.getHttpServer())
      .get("/api/v1/analytics/dashboard?asOfDate=2026-08-31&startDate=2026-07-01")
      .set("Cookie", cookie)
      .expect(200);
  });

  it("只使用登录会话中的 Merchant 返回统一看板快照", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/analytics/dashboard?asOfDate=2026-08-31")
      .set("Cookie", cookie)
      .expect(200);

    expect(response.body).toEqual(expectedResponse);
    expect(dashboardService.summarize).toHaveBeenCalledWith(
      expect.objectContaining({ merchantId: "demo-merchant" }),
      "2026-08-31",
    );
  });

  it("拒绝非法日期与客户端 Merchant 覆盖", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/analytics/dashboard?asOfDate=2026-02-30")
      .set("Cookie", cookie)
      .expect(400);
    await request(app.getHttpServer())
      .get("/api/v1/analytics/dashboard?asOfDate=2026-08-31&merchantId=other")
      .set("Cookie", cookie)
      .expect(404);
    expect(dashboardService.summarize).not.toHaveBeenCalled();
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

const summaryFixture = {
  asOfDate: "2026-08-31",
  recent: {
    currentWindow: { startDate: "2026-08-25", endDate: "2026-08-31", days: 7 },
    metrics: {
      revenueCents: 12_680_00,
      orderCount: 286,
      unitsSold: 320,
      averageOrderValueCents: 4_434,
    },
    changes: {
      revenue: { changePercent: 18.6 },
      orderCount: { changePercent: 12.4 },
      unitsSold: { changePercent: null },
      averageOrderValue: { changePercent: -5.2 },
    },
    dailyTrend: [
      { date: "2026-08-25", revenueCents: 520_00 },
      { date: "2026-08-26", revenueCents: 680_00 },
      { date: "2026-08-27", revenueCents: 610_00 },
      { date: "2026-08-28", revenueCents: 890_00 },
      { date: "2026-08-29", revenueCents: 760_00 },
      { date: "2026-08-30", revenueCents: 1_040_00 },
      { date: "2026-08-31", revenueCents: 12_680_00 },
    ],
  },
};

const expectedResponse = {
  asOfDate: "2026-08-31",
  period: { startDate: "2026-08-25", endDate: "2026-08-31", days: 7 },
  metrics: [
    { key: "sales", value: 12_680_00, changeRatio: 0.186 },
    { key: "orders", value: 286, changeRatio: 0.124 },
    { key: "units", value: 320, changeRatio: null },
    { key: "averageOrderValue", value: 4_434, changeRatio: -0.052 },
  ],
  trend: [
    { date: "2026-08-25", revenueMinor: 520_00 },
    { date: "2026-08-26", revenueMinor: 680_00 },
    { date: "2026-08-27", revenueMinor: 610_00 },
    { date: "2026-08-28", revenueMinor: 890_00 },
    { date: "2026-08-29", revenueMinor: 760_00 },
    { date: "2026-08-30", revenueMinor: 1_040_00 },
    { date: "2026-08-31", revenueMinor: 12_680_00 },
  ],
  products: [],
  inventoryAlerts: [],
};

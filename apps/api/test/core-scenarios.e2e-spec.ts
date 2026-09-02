import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AiChatResponseSchema } from "@shopmate/contracts";
import { disconnectPrismaClient, getPrismaClient } from "@shopmate/database";
import { config as loadEnv } from "dotenv";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DashboardService } from "../src/analytics/dashboard.service.js";
import { LowStockService } from "../src/analytics/low-stock.service.js";
import { ProductPerformanceService } from "../src/analytics/product-performance.service.js";
import { AuthPermission, createAuthContext } from "../src/auth/contracts/index.js";
import {
  InMemoryInventoryAlertConfirmationStore,
  InventoryAlertUpdateService,
} from "../src/ai/tools/inventory-alert-update.tool.js";
import { PrismaInventoryAlertUpdateRepository } from "../src/ai/tools/inventory-alert-update.repository.js";

loadEnv({
  path: "../../packages/database/.env",
});

const RUN_J1 = process.env.RUN_J1_INTEGRATION === "1";

const describeJ1 = RUN_J1 ? describe : describe.skip;

const DEMO_EMAIL = "owner@shopmate.co.nz";

const DEMO_PASSWORD = "demo-pass-2026";

const DEMO_USER_ID = "demo-user";

const DEMO_MERCHANT_ID = "demo-merchant-cn";

const AS_OF_DATE = "2026-08-31";

const START_DATE = "2026-08-25";

const COPY_PRODUCT_ID = "demo-product-001";

const COPY_PRODUCT_NAME = "云感纯棉短袖T恤";

const WRITE_SKU_ID = "demo-sku-003";

const SEEDED_ALERT_THRESHOLD = 20;

describeJ1("J1 五个核心场景集成测试", () => {
  let app: INestApplication;
  let cookie: string;

  let dashboardService: DashboardService;
  let lowStockService: LowStockService;
  let productPerformanceService: ProductPerformanceService;

  const context = createAuthContext({
    userId: DEMO_USER_ID,
    merchantId: DEMO_MERCHANT_ID,
    permissions: Object.values(AuthPermission),
  });

  beforeAll(async () => {
    configureTestEnvironment();

    const [{ AppModule }, { configureApp }] = await Promise.all([
      import("../src/app.module.js"),
      import("../src/app.config.js"),
    ]);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();

    configureApp(app);

    await app.init();

    dashboardService = app.get(DashboardService);

    lowStockService = app.get(LowStockService);

    productPerformanceService = app.get(ProductPerformanceService);

    cookie = await login(app);
  });

  afterAll(async () => {
    const prisma = getPrismaClient();

    await prisma.sku.updateMany({
      where: {
        id: WRITE_SKU_ID,
        merchantId: DEMO_MERCHANT_ID,
      },
      data: {
        alertThreshold: SEEDED_ALERT_THRESHOLD,
      },
    });

    await app.close();
    await disconnectPrismaClient();

    vi.unstubAllEnvs();
  });

  it("场景 1：Dashboard API 的经营数字与 DashboardService 一致", async () => {
    const serviceResult = await dashboardService.summarize(context, AS_OF_DATE, START_DATE);

    const response = await request(app.getHttpServer())
      .get(`/api/v1/analytics/dashboard?asOfDate=${AS_OF_DATE}&startDate=${START_DATE}`)
      .set("Cookie", cookie)
      .expect(200);

    const metrics = Object.fromEntries(
      (
        response.body.metrics as Array<{
          key: string;
          value: number;
        }>
      ).map((metric) => [metric.key, metric.value]),
    );

    expect(metrics.sales).toBe(serviceResult.recent.metrics.revenueCents);

    expect(metrics.orders).toBe(serviceResult.recent.metrics.orderCount);

    expect(metrics.units).toBe(serviceResult.recent.metrics.unitsSold);

    expect(metrics.averageOrderValue).toBe(serviceResult.recent.metrics.averageOrderValueCents);

    expect(response.body.period).toEqual(serviceResult.recent.currentWindow);
  });

  it("场景 2：库存查询使用真实 LowStockService 结果", async () => {
    const serviceResult = await lowStockService.analyze(context, AS_OF_DATE, START_DATE);

    expect(serviceResult.risks.length).toBeGreaterThan(0);

    const firstRisk = serviceResult.risks[0];

    if (!firstRisk) {
      throw new Error("固定 Seed 应至少包含一个库存风险");
    }

    const response = await request(app.getHttpServer())
      .post("/api/v1/ai/chat")
      .set("Cookie", cookie)
      .send({
        message: {
          role: "user",
          content: "请查询当前库存",
        },
      })
      .expect(200);

    const body = AiChatResponseSchema.parse(response.body);

    expect(body.message.content).toContain(firstRisk.skuId);

    expect(body.message.content).toContain(firstRisk.productName);

    expect(body.message.content).toContain(String(firstRisk.inventory));
  });

  it("场景 3：热销查询与 ProductPerformanceService 排名一致", async () => {
    const serviceResult = await productPerformanceService.analyze(context, AS_OF_DATE, START_DATE);

    const hottest = serviceResult.hotSellers[0];

    if (!hottest) {
      throw new Error("固定订单 Seed 应产生至少一个热销商品");
    }

    const response = await request(app.getHttpServer())
      .post("/api/v1/ai/chat")
      .set("Cookie", cookie)
      .send({
        message: {
          role: "user",
          content: "请告诉我最近热销商品",
        },
      })
      .expect(200);

    const body = AiChatResponseSchema.parse(response.body);

    expect(body.message.content).toContain(hottest.productId);

    expect(body.message.content).toContain(hottest.productName);

    expect(body.message.content).toContain(String(hottest.unitsSold));
  });

  it("场景 4：商品文案使用真实商品上下文并返回结构化结果", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/v1/ai/chat")
      .set("Cookie", cookie)
      .send({
        message: {
          role: "user",
          content:
            "请为商品 demo-product-001 生成小红书文案。" +
            "商品 ID：demo-product-001；" +
            "文案类型：XIAOHONGSHU。" +
            "请使用真实商品信息。",
        },
      })
      .expect(200);

    const body = AiChatResponseSchema.parse(response.body);

    const copy = body.message.productCopy;

    if (!copy) {
      throw new Error("商品文案响应缺少 productCopy");
    }

    expect(copy.productId).toBe(COPY_PRODUCT_ID);

    expect(copy.copyType).toBe("XIAOHONGSHU");

    expect(copy.title).toContain(COPY_PRODUCT_NAME);

    expect(copy.body.length).toBeGreaterThan(0);

    expect(copy.tags.length).toBeGreaterThan(0);
  });

  it("场景 5：确认式写操作更新真实数据库并在测试结束前恢复阈值", async () => {
    const prisma = getPrismaClient();

    const before = await prisma.sku.findFirst({
      where: {
        id: WRITE_SKU_ID,
        merchantId: DEMO_MERCHANT_ID,
      },
      select: {
        alertThreshold: true,
      },
    });

    if (!before) {
      throw new Error("固定 Seed SKU 不存在");
    }

    const originalThreshold = before.alertThreshold;

    const targetThreshold = originalThreshold + 7;

    const service = new InventoryAlertUpdateService(
      new PrismaInventoryAlertUpdateRepository(),
      new InMemoryInventoryAlertConfirmationStore(),
      {
        createConfirmationId: () => "j1-confirmation",
        createConfirmationToken: () => "j1-inventory-confirmation-token-0001",
      },
    );

    try {
      const preview = await service.handle(
        {
          action: "PREVIEW",
          skuId: WRITE_SKU_ID,
          targetAlertThreshold: targetThreshold,
        },
        context,
      );

      if (preview.status !== "PENDING") {
        throw new Error("确认式写操作未生成 PENDING 预览");
      }

      expect(preview.currentAlertThreshold).toBe(originalThreshold);

      const result = await service.handle(
        {
          action: "CONFIRM",
          confirmationToken: preview.confirmationToken,
        },
        context,
      );

      expect(result.status).toBe("CONFIRMED");

      const updated = await prisma.sku.findFirst({
        where: {
          id: WRITE_SKU_ID,
          merchantId: DEMO_MERCHANT_ID,
        },
        select: {
          alertThreshold: true,
        },
      });

      expect(updated?.alertThreshold).toBe(targetThreshold);
    } finally {
      await prisma.sku.updateMany({
        where: {
          id: WRITE_SKU_ID,
          merchantId: DEMO_MERCHANT_ID,
        },
        data: {
          alertThreshold: originalThreshold,
        },
      });
    }

    const restored = await prisma.sku.findFirst({
      where: {
        id: WRITE_SKU_ID,
        merchantId: DEMO_MERCHANT_ID,
      },
      select: {
        alertThreshold: true,
      },
    });

    expect(restored?.alertThreshold).toBe(originalThreshold);
  });
});

function configureTestEnvironment(): void {
  vi.stubEnv("NODE_ENV", "test");

  vi.stubEnv("DEMO_AUTH_EMAIL", DEMO_EMAIL);

  vi.stubEnv("DEMO_AUTH_PASSWORD", DEMO_PASSWORD);

  vi.stubEnv("DEMO_AUTH_USER_ID", DEMO_USER_ID);

  vi.stubEnv("DEMO_AUTH_MERCHANT_ID", DEMO_MERCHANT_ID);

  vi.stubEnv("DEMO_SESSION_SECRET", "j1-test-session-key-with-at-least-32-characters");

  vi.stubEnv("DEMO_SESSION_TTL_SECONDS", "3600");

  // J1 必须使用确定性的 Mock Provider，
  // 不能依赖真实 DeepSeek 网络请求。
  vi.stubEnv("DEEPSEEK_API_KEY", "");
}

async function login(app: INestApplication): Promise<string> {
  const response = await request(app.getHttpServer())
    .post("/api/v1/auth/login")
    .send({
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
    })
    .expect(200);

  const cookies = response.headers["set-cookie"];

  const firstCookie = cookies?.[0];

  if (!firstCookie) {
    throw new Error("Demo 登录未返回 Session Cookie");
  }

  return firstCookie.split(";")[0] ?? "";
}

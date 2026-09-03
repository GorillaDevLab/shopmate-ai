import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AuthPermission, createAuthContext } from "../src/auth/contracts/index.js";
import { DEMO_SESSION_COOKIE_NAME } from "../src/auth/session/demo-session-cookie.js";
import { signDemoSession } from "../src/auth/session/demo-session.js";
import { MonitoringEvaluator } from "../src/monitoring/monitoring-evaluator.js";
import { MONITORING_REPOSITORY } from "../src/monitoring/monitoring.repository.js";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { FixtureMonitoringRepository } from "./fixtures/monitoring.fixture.js";

describe("Monitoring API", () => {
  let app: INestApplication;
  let cookie: string;
  const repository = new FixtureMonitoringRepository();
  const evaluator = { evaluate: vi.fn() };

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
    evaluator.evaluate.mockResolvedValue(matchedEvaluation());
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MONITORING_REPOSITORY)
      .useValue(repository)
      .overrideProvider(MonitoringEvaluator)
      .useValue(evaluator)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    const login = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "owner@shopmate.co.nz", password: "demo-pass-2026" })
      .expect(200);
    cookie = login.headers["set-cookie"][0].split(";")[0];
  });

  beforeEach(() => {
    repository.clear();
    evaluator.evaluate.mockReset().mockResolvedValue(matchedEvaluation());
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

  it("完成预览、创建、启停、检查、通知已读和删除流程", async () => {
    const preview = await request(app.getHttpServer())
      .post("/api/v1/monitoring/rules/preview")
      .set("Cookie", cookie)
      .send({ question: "库存低于 5 件时提醒我" })
      .expect(200);
    expect(preview.body).toMatchObject({
      definition: { threshold: 5 },
      evaluation: { matched: true },
    });

    const created = await request(app.getHttpServer())
      .post("/api/v1/monitoring/rules")
      .set("Cookie", cookie)
      .send({ name: preview.body.suggestedName, definition: preview.body.definition })
      .expect(201);
    const ruleId = created.body.rule.id as string;

    await updateStatus(app, cookie, ruleId, "INACTIVE").expect(200);
    await updateStatus(app, cookie, ruleId, "ACTIVE").expect(200);
    await request(app.getHttpServer())
      .post("/api/v1/monitoring/sync")
      .set("Cookie", cookie)
      .expect(200, { evaluatedRules: 1, createdNotifications: 1, failedRules: 0 });

    const firstRun = await runRule(app, cookie, ruleId).expect(200);
    const secondRun = await runRule(app, cookie, ruleId).expect(200);
    expect(firstRun.body.createdNotifications).toBe(0);
    expect(secondRun.body.createdNotifications).toBe(0);

    const notifications = await request(app.getHttpServer())
      .get("/api/v1/monitoring/notifications")
      .set("Cookie", cookie)
      .expect(200);
    expect(notifications.body.items).toHaveLength(1);
    const notificationId = notifications.body.items[0].id as string;
    await request(app.getHttpServer())
      .patch(`/api/v1/monitoring/notifications/${notificationId}/read`)
      .set("Cookie", cookie)
      .expect(200);
    await request(app.getHttpServer())
      .post("/api/v1/monitoring/notifications/read-all")
      .set("Cookie", cookie)
      .expect(200, { updated: 0 });
    await request(app.getHttpServer())
      .delete(`/api/v1/monitoring/rules/${ruleId}`)
      .set("Cookie", cookie)
      .expect(204);
  });

  it("另一用户看不到也不能操作规则与通知", async () => {
    const ownerCookie = sessionCookie("owner-a", "shared-merchant");
    const otherCookie = sessionCookie("owner-b", "shared-merchant");
    const created = await createInventoryRule(app, ownerCookie);
    const ruleId = created.body.rule.id as string;
    await runRule(app, ownerCookie, ruleId).expect(200);

    await request(app.getHttpServer())
      .get("/api/v1/monitoring/rules")
      .set("Cookie", otherCookie)
      .expect(200, { items: [] });
    await runRule(app, otherCookie, ruleId).expect(404);
    await request(app.getHttpServer())
      .delete(`/api/v1/monitoring/rules/${ruleId}`)
      .set("Cookie", otherCookie)
      .expect(404);

    const ownerNotifications = await request(app.getHttpServer())
      .get("/api/v1/monitoring/notifications")
      .set("Cookie", ownerCookie)
      .expect(200);
    const notificationId = ownerNotifications.body.items[0].id as string;
    await request(app.getHttpServer())
      .patch(`/api/v1/monitoring/notifications/${notificationId}/read`)
      .set("Cookie", otherCookie)
      .expect(404);
    await request(app.getHttpServer())
      .get("/api/v1/monitoring/notifications")
      .set("Cookie", otherCookie)
      .expect(200, { items: [] });
  });
});

function matchedEvaluation() {
  return {
    matched: true,
    periodStart: "2026-09-03T00:00:00.000Z",
    periodEnd: "2026-09-03T23:59:59.999Z",
    matches: [
      {
        resourceType: "SKU" as const,
        resourceId: "sku-1",
        title: "库存不足",
        message: "SKU-1 当前库存 4 件",
        severity: "WARNING" as const,
      },
    ],
  };
}

function sessionCookie(userId: string, merchantId: string): string {
  const context = createAuthContext({
    userId,
    merchantId,
    permissions: [AuthPermission.OrdersRead, AuthPermission.ProductsRead],
  });
  const session = signDemoSession(context, "test-session-key-with-at-least-32-characters", 3_600);
  return `${DEMO_SESSION_COOKIE_NAME}=${session.token}`;
}

function createInventoryRule(application: INestApplication, session: string) {
  return request(application.getHttpServer())
    .post("/api/v1/monitoring/rules")
    .set("Cookie", session)
    .send({
      name: "低库存提醒",
      definition: {
        kind: "inventoryThreshold",
        metric: "inventory",
        operator: "below",
        threshold: 5,
        scope: "allProducts",
        productIds: [],
        frequency: "daily",
      },
    });
}

function updateStatus(
  application: INestApplication,
  session: string,
  ruleId: string,
  status: "ACTIVE" | "INACTIVE",
) {
  return request(application.getHttpServer())
    .patch(`/api/v1/monitoring/rules/${ruleId}/status`)
    .set("Cookie", session)
    .send({ status });
}

function runRule(application: INestApplication, session: string, ruleId: string) {
  return request(application.getHttpServer())
    .post(`/api/v1/monitoring/rules/${ruleId}/run`)
    .set("Cookie", session);
}

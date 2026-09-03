import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DEFAULT_DASHBOARD_LAYOUT, type DashboardLayout } from "@shopmate/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuthContext, type AuthContext } from "../src/auth/contracts/index.js";
import { DEMO_SESSION_COOKIE_NAME } from "../src/auth/session/demo-session-cookie.js";
import { signDemoSession } from "../src/auth/session/demo-session.js";
import {
  DASHBOARD_LAYOUT_REPOSITORY,
  type DashboardLayoutRecord,
  type DashboardLayoutRepository,
  type DashboardLayoutSaveResult,
} from "../src/dashboard-layout/dashboard-layout.repository.js";

describe("用户看板布局 API", () => {
  let app: INestApplication;
  let cookie: string;
  const repository = new FixtureDashboardLayoutRepository();

  beforeAll(async () => {
    configureTestEnvironment();
    const [{ AppModule }, { configureApp }] = await Promise.all([
      import("../src/app.module.js"),
      import("../src/app.config.js"),
    ]);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DASHBOARD_LAYOUT_REPOSITORY)
      .useValue(repository)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    cookie = await login(app);
  });

  beforeEach(() => repository.clear());

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it("未认证读取和保存均返回 401", async () => {
    await request(app.getHttpServer()).get("/api/v1/dashboard/layout").expect(401);
    await request(app.getHttpServer())
      .put("/api/v1/dashboard/layout")
      .send({ layout: DEFAULT_DASHBOARD_LAYOUT, expectedRevision: 0 })
      .expect(401);
  });

  it("首次读取默认布局，保存后再次读取可恢复", async () => {
    const initial = await request(app.getHttpServer())
      .get("/api/v1/dashboard/layout")
      .set("Cookie", cookie)
      .expect(200);
    expect(initial.body).toEqual({
      layout: DEFAULT_DASHBOARD_LAYOUT,
      revision: 0,
      updatedAt: null,
    });

    const layout = {
      ...DEFAULT_DASHBOARD_LAYOUT,
      cards: [...DEFAULT_DASHBOARD_LAYOUT.cards].reverse(),
    };
    const saved = await request(app.getHttpServer())
      .put("/api/v1/dashboard/layout")
      .set("Cookie", cookie)
      .send({ layout, expectedRevision: 0 })
      .expect(200);
    expect(saved.body).toMatchObject({ layout, revision: 1 });

    const restored = await request(app.getHttpServer())
      .get("/api/v1/dashboard/layout")
      .set("Cookie", cookie)
      .expect(200);
    expect(restored.body).toEqual(saved.body);
  });

  it("旧版本保存返回中文 409 且不会覆盖已保存布局", async () => {
    await request(app.getHttpServer())
      .put("/api/v1/dashboard/layout")
      .set("Cookie", cookie)
      .send({ layout: DEFAULT_DASHBOARD_LAYOUT, expectedRevision: 0 })
      .expect(200);

    const conflict = await request(app.getHttpServer())
      .put("/api/v1/dashboard/layout")
      .set("Cookie", cookie)
      .send({ layout: DEFAULT_DASHBOARD_LAYOUT, expectedRevision: 0 })
      .expect(409);
    expect(conflict.body).toEqual({
      statusCode: 409,
      code: "DASHBOARD_LAYOUT_VERSION_CONFLICT",
      message: "看板布局已在其他设备更新，请刷新后重试",
      retryable: true,
    });
  });

  it("拒绝客户端 userId、merchantId 和未知配置", async () => {
    await request(app.getHttpServer())
      .put("/api/v1/dashboard/layout")
      .set("Cookie", cookie)
      .send({ layout: DEFAULT_DASHBOARD_LAYOUT, expectedRevision: 0, userId: "other" })
      .expect(400);
    await request(app.getHttpServer())
      .put("/api/v1/dashboard/layout")
      .set("Cookie", cookie)
      .send({ layout: DEFAULT_DASHBOARD_LAYOUT, expectedRevision: 0, merchantId: "other" })
      .expect(404);
  });

  it("两个用户在同一 Merchant 下保存并恢复各自布局", async () => {
    const firstCookie = sessionCookie("user-a", "shared-merchant");
    const secondCookie = sessionCookie("user-b", "shared-merchant");
    const firstLayout = reorderedLayout(1);
    const secondLayout = reorderedLayout(2);

    await saveLayout(app, firstCookie, firstLayout, 0).expect(200);
    await saveLayout(app, secondCookie, secondLayout, 0).expect(200);

    const [first, second] = await Promise.all([
      request(app.getHttpServer()).get("/api/v1/dashboard/layout").set("Cookie", firstCookie),
      request(app.getHttpServer()).get("/api/v1/dashboard/layout").set("Cookie", secondCookie),
    ]);
    expect(first.body).toMatchObject({ layout: firstLayout, revision: 1 });
    expect(second.body).toMatchObject({ layout: secondLayout, revision: 1 });
  });

  it("同一版本的两个并发保存只有一个成功且不会覆盖赢家", async () => {
    const deviceCookie = sessionCookie("concurrent-user", "merchant-1");
    await saveLayout(app, deviceCookie, DEFAULT_DASHBOARD_LAYOUT, 0).expect(200);
    const candidates = [reorderedLayout(1), reorderedLayout(2)];

    const responses = await Promise.all(
      candidates.map((layout) => saveLayout(app, deviceCookie, layout, 1)),
    );
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);

    const winner = responses.find(({ status }) => status === 200);
    const stored = await request(app.getHttpServer())
      .get("/api/v1/dashboard/layout")
      .set("Cookie", deviceCookie)
      .expect(200);
    expect(stored.body).toEqual(winner?.body);
  });
});

class FixtureDashboardLayoutRepository implements DashboardLayoutRepository {
  private readonly records = new Map<string, DashboardLayoutRecord>();

  clear(): void {
    this.records.clear();
  }

  async find(context: AuthContext): Promise<DashboardLayoutRecord | null> {
    return this.records.get(identityKey(context)) ?? null;
  }

  async save(
    context: AuthContext,
    layout: DashboardLayout,
    expectedRevision: number,
  ): Promise<DashboardLayoutSaveResult> {
    const key = identityKey(context);
    const current = this.records.get(key);
    if ((current?.revision ?? 0) !== expectedRevision) return { kind: "conflict" };
    const record = {
      layout,
      revision: expectedRevision + 1,
      updatedAt: new Date("2026-09-02T00:00:00.000Z"),
    };
    this.records.set(key, record);
    return { kind: "saved", record };
  }
}

function identityKey(context: AuthContext): string {
  return `${context.userId}/${context.merchantId}`;
}

function configureTestEnvironment(): void {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DEMO_AUTH_EMAIL", "owner@shopmate.co.nz");
  vi.stubEnv("DEMO_AUTH_PASSWORD", "demo-pass-2026");
  vi.stubEnv("DEMO_AUTH_USER_ID", "demo-user");
  vi.stubEnv("DEMO_AUTH_MERCHANT_ID", "demo-merchant");
  vi.stubEnv("DEMO_SESSION_SECRET", "test-session-key-with-at-least-32-characters");
  vi.stubEnv("DEMO_SESSION_TTL_SECONDS", "3600");
}

function sessionCookie(userId: string, merchantId: string): string {
  const context = createAuthContext({ userId, merchantId, permissions: [] });
  const session = signDemoSession(
    context,
    "test-session-key-with-at-least-32-characters",
    3_600,
  );
  return `${DEMO_SESSION_COOKIE_NAME}=${session.token}`;
}

function reorderedLayout(offset: number): DashboardLayout {
  const cards = [...DEFAULT_DASHBOARD_LAYOUT.cards];
  return { ...DEFAULT_DASHBOARD_LAYOUT, cards: [...cards.slice(offset), ...cards.slice(0, offset)] };
}

function saveLayout(
  application: INestApplication,
  session: string,
  layout: DashboardLayout,
  expectedRevision: number,
) {
  return request(application.getHttpServer())
    .put("/api/v1/dashboard/layout")
    .set("Cookie", session)
    .send({ layout, expectedRevision });
}

async function login(app: INestApplication): Promise<string> {
  const response = await request(app.getHttpServer())
    .post("/api/v1/auth/login")
    .send({ email: "owner@shopmate.co.nz", password: "demo-pass-2026" })
    .expect(200);
  return response.headers["set-cookie"][0].split(";")[0];
}

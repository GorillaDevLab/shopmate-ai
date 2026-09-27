import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentActionService } from "../src/ai/actions/agent-action.service.js";

describe("AI 操作确认 API", () => {
  let app: INestApplication;
  let cookie: string;
  const actionService = { confirm: vi.fn(), cancel: vi.fn() };

  beforeAll(async () => {
    configureTestEnvironment();
    const [{ AppModule }, { configureApp }] = await Promise.all([
      import("../src/app.module.js"),
      import("../src/app.config.js"),
    ]);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AgentActionService)
      .useValue(actionService)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    cookie = await login(app);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    actionService.confirm.mockResolvedValue({ status: "done", message: "ok" });
    actionService.cancel.mockReturnValue({ status: "cancelled" });
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it("未登录不能确认或取消操作", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/ai/actions/0b5f0a3e-4f6a-4b8b-9a55-1c2d3e4f5a6b/confirm")
      .expect(401);
    await request(app.getHttpServer())
      .post("/api/v1/ai/actions/0b5f0a3e-4f6a-4b8b-9a55-1c2d3e4f5a6b/cancel")
      .expect(401);
    expect(actionService.confirm).not.toHaveBeenCalled();
    expect(actionService.cancel).not.toHaveBeenCalled();
  });

  it("登录后以会话中的用户与商家确认，令牌原样交给服务校验归属", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/ai/actions/0b5f0a3e-4f6a-4b8b-9a55-1c2d3e4f5a6b/confirm")
      .set("Cookie", cookie)
      .expect(200);
    expect(actionService.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ merchantId: "demo-merchant" }),
      "0b5f0a3e-4f6a-4b8b-9a55-1c2d3e4f5a6b",
    );
  });

  it("请求里夹带 merchantId 时拒绝，不能替其他商家确认", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/ai/actions/0b5f0a3e-4f6a-4b8b-9a55-1c2d3e4f5a6b/confirm")
      .set("Cookie", cookie)
      .send({ merchantId: "other" })
      .expect(404);
    expect(actionService.confirm).not.toHaveBeenCalled();
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

import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AssistantMemoryService,
  AssistantWorkspaceService,
} from "../src/ai/memory/assistant-memory.service.js";

describe("AI 记忆与对话同步 API", () => {
  let app: INestApplication;
  let cookie: string;
  const memoryService = { list: vi.fn(), delete: vi.fn(), clear: vi.fn() };
  const workspaceService = { get: vi.fn(), save: vi.fn(), delete: vi.fn() };

  beforeAll(async () => {
    configureTestEnvironment();
    const [{ AppModule }, { configureApp }] = await Promise.all([
      import("../src/app.module.js"),
      import("../src/app.config.js"),
    ]);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AssistantMemoryService)
      .useValue(memoryService)
      .overrideProvider(AssistantWorkspaceService)
      .useValue(workspaceService)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    cookie = await login(app);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    memoryService.list.mockResolvedValue({ items: [] });
    workspaceService.get.mockResolvedValue({ snapshot: null, revision: 0 });
    workspaceService.save.mockResolvedValue({ revision: 1 });
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it("未登录不能读取或删除记忆、对话记录", async () => {
    const server = app.getHttpServer();
    await request(server).get("/api/v1/ai/memories").expect(401);
    await request(server).delete("/api/v1/ai/memories").expect(401);
    await request(server).get("/api/v1/ai/workspace").expect(401);
    await request(server).put("/api/v1/ai/workspace").send({}).expect(401);
    await request(server).delete("/api/v1/ai/workspace").expect(401);
    expect(memoryService.list).not.toHaveBeenCalled();
    expect(workspaceService.save).not.toHaveBeenCalled();
  });

  it("登录后按会话中的用户与商家读写", async () => {
    const server = app.getHttpServer();
    await request(server).get("/api/v1/ai/memories").set("Cookie", cookie).expect(200);
    const body = { snapshot: { version: 1, sessions: [], currentId: "" }, expectedRevision: 0 };
    await request(server).put("/api/v1/ai/workspace").set("Cookie", cookie).send(body).expect(200);
    expect(workspaceService.save).toHaveBeenCalledWith(
      expect.objectContaining({ merchantId: "demo-merchant" }),
      body,
    );
  });

  it("请求里夹带 merchantId 时拒绝，不能写别的商家的对话", async () => {
    await request(app.getHttpServer())
      .put("/api/v1/ai/workspace")
      .set("Cookie", cookie)
      .send({ merchantId: "other", snapshot: {}, expectedRevision: 0 })
      .expect(404);
    expect(workspaceService.save).not.toHaveBeenCalled();
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

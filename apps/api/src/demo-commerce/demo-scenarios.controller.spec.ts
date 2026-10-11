import "reflect-metadata";
import { randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { DemoAuthModule } from "../auth/demo-auth.module.js";
import { DEMO_AUTH_CONFIG } from "../auth/demo-auth.config.js";
import { signDemoSession } from "../auth/session/demo-session.js";
import { DEMO_SESSION_COOKIE_NAME } from "../auth/session/demo-session-cookie.js";
import { configureApp } from "../app.config.js";
import { DemoScenariosController } from "./demo-scenarios.controller.js";
import { DemoScenariosService } from "./demo-scenarios.service.js";
import { DemoCommerceGuard } from "./demo-commerce.guard.js";
import { DEMO_COMMERCE_ENV } from "./demo-commerce.environment.js";
import { DEMO_COMMERCE_REPOSITORY } from "./demo-commerce.repository.js";
import { DEMO_SCENARIO_REPOSITORY } from "./demo-scenarios.repository.js";
import { actor, repository } from "../../test/helpers/demo-commerce.fixture.js";
const key = randomBytes(48).toString("hex"),
  origin = "https://demo.example.com";
const cookie = `${DEMO_SESSION_COOKIE_NAME}=${signDemoSession({ ...actor, permissions: [] }, key, 3600).token}`;
const path = "/api/v1/demo-commerce/stores/store-a/session/scenarios";
const command = {
  scenarioId: "SCENARIO_009",
  confirmSessionId: "session-a",
  expectedRevision: 0,
  expectedGeneration: 0,
  observedAt: "2026-01-13T16:00:00.000Z",
};
const scenarios = {
  findDemoScenarios: vi.fn(async () => ({
    sessionId: "session-a",
    generation: 0,
    revision: 0,
    clockNow: command.observedAt,
    runs: [],
  })),
  loadDemoScenario: vi.fn(async () => ({ status: "CONFLICT" })),
};
let app: INestApplication;
beforeAll(async () => {
  const module = await Test.createTestingModule({
    imports: [DemoAuthModule],
    controllers: [DemoScenariosController],
    providers: [
      DemoScenariosService,
      DemoCommerceGuard,
      { provide: DEMO_COMMERCE_ENV, useValue: { enabled: true, origin } },
      { provide: DEMO_COMMERCE_REPOSITORY, useValue: repository() },
      { provide: DEMO_SCENARIO_REPOSITORY, useValue: scenarios },
    ],
  })
    .overrideProvider(DEMO_AUTH_CONFIG)
    .useValue({ sessionSecret: key })
    .compile();
  app = module.createNestApplication();
  configureApp(app);
  await app.listen(0, "127.0.0.1");
});
afterAll(async () => {
  await app.close();
});
it("requires signed cookie and returns an explicit empty run list", async () => {
  await request(app.getHttpServer()).get(path).expect(401);
  const response = await request(app.getHttpServer()).get(path).set("Cookie", cookie).expect(200);
  expect(response.body.runs).toEqual([]);
});
it("requires same origin before writes and passes only verified actor identifiers", async () => {
  for (const value of [undefined, "https://foreign.example.com"]) {
    const req = request(app.getHttpServer()).post(`${path}/load`).set("Cookie", cookie);
    if (value) req.set("Origin", value);
    await req.send(command).expect(403);
  }
  expect(scenarios.loadDemoScenario).not.toHaveBeenCalled();
  await request(app.getHttpServer())
    .post(`${path}/load`)
    .set("Cookie", cookie)
    .set("Origin", origin)
    .send(command)
    .expect(409);
  expect(scenarios.loadDemoScenario).toHaveBeenCalledWith(actor, "store-a", expect.any(Object));
});
it("rejects spoofed scope and malformed load fields before database writes", async () => {
  const count = scenarios.loadDemoScenario.mock.calls.length;
  for (const field of ["organizationId", "workspaceId", "connectionId", "scenarioPlan"])
    await request(app.getHttpServer())
      .post(`${path}/load`)
      .set("Cookie", cookie)
      .set("Origin", origin)
      .send({ ...command, [field]: "foreign" })
      .expect(400);
  await request(app.getHttpServer()).get(`${path}?generation=1`).set("Cookie", cookie).expect(400);
  expect(scenarios.loadDemoScenario).toHaveBeenCalledTimes(count);
});

import "reflect-metadata";
import { randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { DemoAuthModule } from "../auth/demo-auth.module.js";
import { DEMO_AUTH_CONFIG } from "../auth/demo-auth.config.js";
import { signDemoSession } from "../auth/session/demo-session.js";
import { DEMO_SESSION_COOKIE_NAME } from "../auth/session/demo-session-cookie.js";
import { configureApp } from "../app.config.js";
import { DemoCommerceController } from "./demo-commerce.controller.js";
import { DemoCommerceService } from "./demo-commerce.service.js";
import { DemoCommerceGuard } from "./demo-commerce.guard.js";
import { DEMO_COMMERCE_ENV } from "./demo-commerce.environment.js";
import { DEMO_COMMERCE_REPOSITORY } from "./demo-commerce.repository.js";
import { actor, command, repository } from "../../test/helpers/demo-commerce.fixture.js";
const key = randomBytes(48).toString("hex");
const origin = "https://demo.example.com";
const cookie = `${DEMO_SESSION_COOKIE_NAME}=${signDemoSession({ ...actor, permissions: [] }, key, 3600).token}`;
const path = "/api/v1/demo-commerce/stores/store-a/session";
describe("authenticated demo HTTP controls", () => {
  let app: INestApplication;
  const repo = repository();
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [DemoAuthModule],
      controllers: [DemoCommerceController],
      providers: [
        DemoCommerceService,
        DemoCommerceGuard,
        { provide: DEMO_COMMERCE_ENV, useValue: { enabled: true, origin } },
        { provide: DEMO_COMMERCE_REPOSITORY, useValue: repo },
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
  it("requires signed cookies", async () => {
    await request(app.getHttpServer()).get(path).expect(401);
  });
  it("passes only verified actor ids to database", async () => {
    await request(app.getHttpServer())
      .post(path)
      .set("Cookie", cookie)
      .set("Origin", origin)
      .send(command)
      .expect(201);
    expect(repo.createDemoSession).toHaveBeenLastCalledWith(actor, "store-a", expect.any(Object));
  });
  it.each([undefined, "https://foreign.example.com"])(
    "denies Origin %s before DB",
    async (originValue) => {
      const req = request(app.getHttpServer()).post(path).set("Cookie", cookie);
      if (originValue) req.set("Origin", originValue);
      const count = vi.mocked(repo.createDemoSession).mock.calls.length;
      await req.send(command).expect(403);
      expect(repo.createDemoSession).toHaveBeenCalledTimes(count);
    },
  );
  it.each(["workspaceId", "organizationId", "connectionId"])(
    "rejects body/query %s",
    async (field) => {
      await request(app.getHttpServer())
        .post(path)
        .set("Cookie", cookie)
        .set("Origin", origin)
        .send({ ...command, [field]: "spoof" })
        .expect(400);
      await request(app.getHttpServer())
        .get(`${path}?${field}=spoof`)
        .set("Cookie", cookie)
        .expect(400);
    },
  );
  it("preserves global merchant override 404", async () => {
    await request(app.getHttpServer())
      .post(path)
      .set("Cookie", cookie)
      .set("Origin", origin)
      .send({ ...command, merchantId: "foreign" })
      .expect(404);
  });
});

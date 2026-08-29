import "reflect-metadata";

import {
  Body,
  Controller,
  type INestApplication,
  Post,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { IsString } from "class-validator";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

class ValidationProbeDto {
  @IsString()
  name!: string;
}

@Controller({ path: "validation-probe", version: "1" })
class ValidationProbeController {
  @Post()
  validate(@Body() body: ValidationProbeDto): ValidationProbeDto {
    return body;
  }
}

describe("ShopMate API", () => {
  let app: INestApplication | null = null;

  beforeAll(async () => {
    const runtime = await Promise.all([
      import("../src/app.module.js"),
      import("../src/app.config.js"),
    ]).catch(() => null);

    if (!runtime) return;

    const [{ AppModule }, { configureApp }] = runtime;
    const testingModule = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ValidationProbeController],
    }).compile();

    app = testingModule.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("通过 v1 路由返回中文结构化健康结果", async () => {
    expect(app).not.toBeNull();
    if (!app) return;

    const response = await request(app.getHttpServer()).get("/api/v1/health").expect(200);

    expect(response.body).toMatchObject({
      status: "ok",
      service: "shopmate-api",
      message: "服务运行正常",
    });
    expect(response.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("不暴露无版本健康路由", async () => {
    expect(app).not.toBeNull();
    if (!app) return;

    await request(app.getHttpServer()).get("/api/health").expect(404);
  });

  it("拒绝非法和额外输入且不泄露堆栈", async () => {
    expect(app).not.toBeNull();
    if (!app) return;

    const response = await request(app.getHttpServer())
      .post("/api/v1/validation-probe")
      .send({ name: 123, secret: "不应接受" })
      .expect(400);

    expect(response.body).toEqual({
      statusCode: 400,
      error: "请求参数无效",
      message: "请求参数校验失败",
    });
    expect(response.body).not.toHaveProperty("stack");
  });
});

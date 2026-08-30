import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../src/auth/contracts/index.js";
import type { ProductListQuery, ProductStatus } from "@shopmate/contracts";
import { PRODUCT_REPOSITORY } from "../src/products/product.repository.js";

interface ProductRow {
  readonly id: string;
  readonly merchantId: string;
  readonly name: string;
  readonly description: string | null;
  readonly features: unknown;
  readonly sellingPoints: unknown;
  readonly price: string;
  readonly currency: string;
  readonly status: ProductStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly skus: readonly SkuRow[];
}

interface SkuRow {
  readonly id: string;
  readonly code: string;
  readonly inventory: number;
  readonly cost: string;
  readonly alertThreshold: number;
}

interface ProductRepositoryProbe {
  list(
    context: AuthContext,
    query: ProductListQuery,
  ): Promise<{ rows: readonly ProductRow[]; total: number }>;
  findById(context: AuthContext, productId: string): Promise<ProductRow | null>;
}

const updatedAt = new Date("2026-08-30T00:00:00.000Z");
const createdAt = new Date("2026-08-01T00:00:00.000Z");

const productRow: ProductRow = {
  id: "demo-product-001",
  merchantId: "demo-merchant",
  name: "云感纯棉短袖T恤",
  description: "柔软亲肤的基础款纯棉短袖。",
  features: ["100%纯棉", "透气亲肤"],
  sellingPoints: ["基础百搭"],
  price: "79.00",
  currency: "CNY",
  status: "ACTIVE",
  createdAt,
  updatedAt,
  skus: [
    {
      id: "demo-sku-001",
      code: "CN-DEMO-001",
      inventory: 8,
      cost: "28.00",
      alertThreshold: 10,
    },
  ],
};

describe("商品列表与详情 API", () => {
  let app: INestApplication;
  let cookie: string;
  const repository: ProductRepositoryProbe = {
    list: vi.fn(async () => ({ rows: [productRow], total: 2 })),
    findById: vi.fn(async (_context, productId) =>
      productId === productRow.id ? productRow : null,
    ),
  };

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
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PRODUCT_REPOSITORY)
      .useValue(repository)
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

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it("未登录不能访问商品列表", async () => {
    await request(app.getHttpServer()).get("/api/v1/products").expect(401);
  });

  it("只用当前 Merchant 上下文查询分页商品", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/products?page=2&pageSize=1&status=ACTIVE")
      .set("Cookie", cookie)
      .expect(200);

    expect(response.body).toEqual({
      items: [
        {
          id: productRow.id,
          name: productRow.name,
          status: productRow.status,
          price: { amountMinor: 7_900, currency: "CNY" },
          totalInventory: 8,
          skuCount: 1,
          updatedAt: updatedAt.toISOString(),
        },
      ],
      pagination: { page: 2, pageSize: 1, total: 2, totalPages: 2 },
    });
    expect(repository.list).toHaveBeenCalledWith(
      expect.objectContaining({ merchantId: "demo-merchant" }),
      { page: 2, pageSize: 1, status: "ACTIVE" },
    );
  });

  it("返回商品详情、SKU 库存和整数金额", async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/products/${productRow.id}`)
      .set("Cookie", cookie)
      .expect(200);

    expect(response.body).toEqual({
      id: productRow.id,
      name: productRow.name,
      description: productRow.description,
      features: productRow.features,
      sellingPoints: productRow.sellingPoints,
      status: productRow.status,
      price: { amountMinor: 7_900, currency: "CNY" },
      totalInventory: 8,
      skuCount: 1,
      skus: [
        {
          id: "demo-sku-001",
          code: "CN-DEMO-001",
          inventory: 8,
          cost: { amountMinor: 2_800, currency: "CNY" },
          alertThreshold: 10,
          isLowStock: true,
        },
      ],
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    });
  });

  it("不存在或跨 Merchant 商品统一返回安全 404", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/products/not-found")
      .set("Cookie", cookie)
      .expect(404);
    expect(response.body).toEqual({
      statusCode: 404,
      code: "RESOURCE_NOT_FOUND",
      message: "资源不存在",
    });
    expect(repository.findById).toHaveBeenCalledWith(
      expect.objectContaining({ merchantId: "demo-merchant" }),
      "not-found",
    );
  });

  it("拒绝越界商品列表查询并返回中文错误", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/products?pageSize=101")
      .set("Cookie", cookie)
      .expect(400);
    expect(response.body).toEqual({
      statusCode: 400,
      error: "请求参数无效",
      message: "请求参数校验失败",
    });
  });
});

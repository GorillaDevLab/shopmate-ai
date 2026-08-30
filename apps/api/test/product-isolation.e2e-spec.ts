import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  ProductDetailSchema,
  ProductListResponseSchema,
  type ProductListQuery,
  type ProductStatus,
} from "@shopmate/contracts";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../src/auth/contracts/index.js";
import {
  PRODUCT_REPOSITORY,
  type ProductRecord,
  type ProductRepository,
} from "../src/products/product.repository.js";

const signingKey = "test-session-key-with-at-least-32-characters";
const firstMerchant = "merchant-alpha";
const secondMerchant = "merchant-beta";

const products: readonly ProductRecord[] = [
  createProduct("product-alpha", firstMerchant, "Alpha 商品", "ACTIVE"),
  createProduct("product-beta", secondMerchant, "Beta 商品", "ACTIVE"),
  createProduct("product-alpha-inactive", firstMerchant, "Alpha 下架商品", "INACTIVE"),
];

class ScopedFixtureRepository implements ProductRepository {
  async list(context: AuthContext, query: ProductListQuery) {
    const merchantProducts = products.filter(
      (product) =>
        product.merchantId === context.merchantId &&
        (query.status === "ALL" || product.status === query.status),
    );
    const start = (query.page - 1) * query.pageSize;
    return {
      rows: merchantProducts.slice(start, start + query.pageSize),
      total: merchantProducts.length,
    };
  }

  async findById(context: AuthContext, productId: string) {
    return (
      products.find(
        (product) => product.id === productId && product.merchantId === context.merchantId,
      ) ?? null
    );
  }
}

describe("商品 API 鉴权与 Merchant 隔离集成测试", () => {
  let app: INestApplication;
  let firstMerchantCookie: string;
  let secondMerchantCookie: string;

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DEMO_AUTH_EMAIL", "owner@shopmate.co.nz");
    vi.stubEnv("DEMO_AUTH_PASSWORD", "demo-pass-2026");
    vi.stubEnv("DEMO_AUTH_USER_ID", "owner-alpha");
    vi.stubEnv("DEMO_AUTH_MERCHANT_ID", firstMerchant);
    vi.stubEnv("DEMO_SESSION_SECRET", signingKey);
    vi.stubEnv("DEMO_SESSION_TTL_SECONDS", "3600");

    const [{ AppModule }, { configureApp }, { createAuthContext }, { signDemoSession }] =
      await Promise.all([
        import("../src/app.module.js"),
        import("../src/app.config.js"),
        import("../src/auth/contracts/index.js"),
        import("../src/auth/session/demo-session.js"),
      ]);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PRODUCT_REPOSITORY)
      .useValue(new ScopedFixtureRepository())
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    const login = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "owner@shopmate.co.nz", password: "demo-pass-2026" })
      .expect(200);
    firstMerchantCookie = login.headers["set-cookie"][0].split(";")[0];

    const secondContext = createAuthContext({
      userId: "owner-beta",
      merchantId: secondMerchant,
      permissions: ["products:read"],
    });
    const secondSession = signDemoSession(secondContext, signingKey, 3_600);
    secondMerchantCookie = `shopmate_demo_session=${secondSession.token}`;
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it("登录成功后只能看到当前 Merchant 的商品", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/products?page=1&pageSize=10")
      .set("Cookie", firstMerchantCookie)
      .expect(200);

    const body = ProductListResponseSchema.parse(response.body);
    expect(body.items.map((item) => item.id)).toEqual(["product-alpha", "product-alpha-inactive"]);
    expect(body.items.some((item) => item.id === "product-beta")).toBe(false);
  });

  it("状态筛选只作用于当前 Merchant", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/products?status=INACTIVE")
      .set("Cookie", firstMerchantCookie)
      .expect(200);

    const body = ProductListResponseSchema.parse(response.body);
    expect(body.items.map((item) => item.id)).toEqual(["product-alpha-inactive"]);
    expect(body.pagination.total).toBe(1);
  });

  it("不同 Merchant 读取同一商品 ID 时返回安全 404", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/products/product-alpha")
      .set("Cookie", secondMerchantCookie)
      .expect(404);

    expect(response.body).toEqual({
      statusCode: 404,
      code: "RESOURCE_NOT_FOUND",
      message: "资源不存在",
    });
  });

  it("当前 Merchant 可以读取自己的详情并通过共享 Schema", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/products/product-beta")
      .set("Cookie", secondMerchantCookie)
      .expect(200);

    const body = ProductDetailSchema.parse(response.body);
    expect(body.id).toBe("product-beta");
    expect(body.name).toBe("Beta 商品");
  });

  it("拒绝非法分页参数而不触发商品查询", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/products?page=0&pageSize=101")
      .set("Cookie", firstMerchantCookie)
      .expect(400);
  });

  it("拒绝过期会话访问商品 API", async () => {
    const [{ createAuthContext }, { signDemoSession }] = await Promise.all([
      import("../src/auth/contracts/index.js"),
      import("../src/auth/session/demo-session.js"),
    ]);
    const context = createAuthContext({
      userId: "owner-alpha",
      merchantId: firstMerchant,
      permissions: ["products:read"],
    });
    const expired = signDemoSession(context, signingKey, 60, Date.now() - 120_000);

    const response = await request(app.getHttpServer())
      .get("/api/v1/products")
      .set("Cookie", `shopmate_demo_session=${expired.token}`)
      .expect(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "UNAUTHENTICATED",
      message: "请先登录",
    });
  });
});

function createProduct(
  id: string,
  merchantId: string,
  name: string,
  status: ProductStatus,
): ProductRecord {
  const timestamp = new Date("2026-08-30T00:00:00.000Z");
  return {
    id,
    merchantId,
    name,
    description: `${name}描述`,
    features: ["轻便", "耐用"],
    sellingPoints: ["限时优惠"],
    price: "99.00",
    currency: "CNY",
    status,
    createdAt: timestamp,
    updatedAt: timestamp,
    skus: [
      {
        id: `${id}-sku`,
        code: `${id}-code`,
        inventory: 10,
        cost: "40.00",
        alertThreshold: 5,
      },
    ],
  };
}

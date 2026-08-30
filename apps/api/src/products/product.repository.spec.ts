import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAuthContext } from "../auth/contracts/index.js";
import { PrismaProductRepository } from "./product.repository.js";

const databaseMocks = vi.hoisted(() => ({
  product: {
    findMany: vi.fn(),
    count: vi.fn(),
    findFirst: vi.fn(),
  },
}));

vi.mock("@shopmate/database", () => ({
  getPrismaClient: () => databaseMocks,
}));

describe("PrismaProductRepository Merchant Scope", () => {
  const repository = new PrismaProductRepository();
  const context = createAuthContext({
    userId: "user-1",
    merchantId: "merchant-1",
    permissions: [],
  });
  const query = { page: 1, pageSize: 20, status: "ALL" as const };

  beforeEach(() => {
    vi.clearAllMocks();
    databaseMocks.product.findMany.mockResolvedValue([]);
    databaseMocks.product.count.mockResolvedValue(0);
    databaseMocks.product.findFirst.mockResolvedValue(null);
  });

  it("列表查询同时限制商品和嵌套 SKU 的 Merchant", async () => {
    await repository.list(context, query);

    expect(databaseMocks.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { merchantId: "merchant-1" },
        include: { skus: { where: { merchantId: "merchant-1" } } },
      }),
    );
  });

  it("详情查询同时限制商品和嵌套 SKU 的 Merchant", async () => {
    await repository.findById(context, "product-1");

    expect(databaseMocks.product.findFirst).toHaveBeenCalledWith({
      where: { id: "product-1", merchantId: "merchant-1" },
      include: { skus: { where: { merchantId: "merchant-1" } } },
    });
  });
});

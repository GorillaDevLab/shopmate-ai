import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAuthContext } from "../auth/contracts/index.js";
import { PrismaLowStockRepository } from "./low-stock.repository.js";

const databaseMocks = vi.hoisted(() => ({
  sku: {
    findMany: vi.fn(),
  },
}));

vi.mock("@shopmate/database", () => ({
  getPrismaClient: () => databaseMocks,
}));

describe("PrismaLowStockRepository", () => {
  const repository = new PrismaLowStockRepository();

  const context = createAuthContext({
    userId: "user-1",
    merchantId: "merchant-1",
    permissions: [],
  });

  beforeEach(() => {
    vi.clearAllMocks();

    databaseMocks.sku.findMany.mockResolvedValue([]);
  });

  it("始终只查询当前 Merchant 的 SKU", async () => {
    await repository.listMerchantSkus(context);

    expect(databaseMocks.sku.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          merchantId: "merchant-1",
        },
      }),
    );
  });

  it("读取库存、阈值和商品名称", async () => {
    databaseMocks.sku.findMany.mockResolvedValue([
      {
        id: "sku-1",
        merchantId: "merchant-1",
        productId: "product-1",
        code: "SKU-001",
        inventory: 8,
        alertThreshold: 10,
        product: {
          name: "测试商品",
        },
      },
    ]);

    const result = await repository.listMerchantSkus(context);

    expect(result).toEqual([
      {
        id: "sku-1",
        merchantId: "merchant-1",
        productId: "product-1",
        productName: "测试商品",
        code: "SKU-001",
        inventory: 8,
        alertThreshold: 10,
      },
    ]);
  });

  it("无 SKU 时返回空集合", async () => {
    const result = await repository.listMerchantSkus(context);

    expect(result).toEqual([]);
  });
});

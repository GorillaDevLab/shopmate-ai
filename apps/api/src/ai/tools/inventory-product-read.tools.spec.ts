import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { LowStockService } from "../../analytics/low-stock.service.js";
import { AuthPermission } from "../../auth/contracts/auth-context.js";
import type { ProductService } from "../../products/product.service.js";

import {
  createInventoryRisksToolRegistration,
  createProductDetailsToolRegistration,
} from "./inventory-product-read.tools.js";
import { ToolRegistry, type ToolInvocationContext } from "./tool-registry.js";

const context: Readonly<ToolInvocationContext> = {
  userId: "user-1",
  merchantId: "merchant-1",
  permissions: [AuthPermission.ProductsRead, AuthPermission.OrdersRead],
};

describe("库存与商品 AI 读取工具", () => {
  it("商品详情透传 Merchant 上下文并保持 Service 数字", async () => {
    const findById = vi.fn(async () => productFixture());
    const registry = registryWithProductTool(findById);

    const result = await registry.invoke(
      "get_product_details",
      { productId: "product-1" },
      context,
    );

    expect(findById).toHaveBeenCalledWith(context, { productId: "product-1" });
    expect(result).toMatchObject({
      status: "ok",
      data: { priceMinor: 1299, totalInventory: 7, skus: [{ inventory: 7 }] },
    });
  });

  it.each([new NotFoundException(), new ForbiddenException()])(
    "跨 Merchant 或无权限读取返回不泄露范围信息的安全错误",
    async (serviceError) => {
      const findById = vi.fn(async () => Promise.reject(serviceError));
      const registry = registryWithProductTool(findById);

      const result = await registry.invoke(
        "get_product_details",
        { productId: "other-product" },
        context,
      );

      expect(JSON.stringify(result)).not.toContain("other-product");
      expect(result).toMatchObject({ status: "error", error: { retryable: false } });
    },
  );

  it("库存工具调用 LowStockService 并保持风险数字与排序", async () => {
    const analyze = vi.fn(async () => inventoryFixture());
    const registry = registryWithInventoryTool(analyze);

    const result = await registry.invoke(
      "get_inventory_risks",
      { startDate: "2026-08-25", endDate: "2026-08-31", limit: 1 },
      context,
    );

    expect(analyze).toHaveBeenCalledWith(context, "2026-08-31", "2026-08-25");
    expect(result).toMatchObject({
      status: "ok",
      data: {
        period: { timezone: "Asia/Shanghai" },
        items: [{ soldUnits: 21, averageDailyUnits: 3, daysToStockout: 2 }],
      },
    });
  });

  it("没有库存风险时返回明确空结果", async () => {
    const analyze = vi.fn(async () => ({ ...inventoryFixture(), risks: [] }));
    const registry = registryWithInventoryTool(analyze);

    await expect(
      registry.invoke(
        "get_inventory_risks",
        { startDate: "2026-08-25", endDate: "2026-08-31" },
        context,
      ),
    ).resolves.toEqual({
      status: "empty",
      reason: "NO_DATA",
      message: "指定范围内没有低库存风险。",
    });
  });

  it("缺少订单读取权限时不会调用库存 Service", async () => {
    const analyze = vi.fn(async () => inventoryFixture());
    const registry = registryWithInventoryTool(analyze);

    await expect(
      registry.invoke(
        "get_inventory_risks",
        { startDate: "2026-08-25", endDate: "2026-08-31" },
        { ...context, permissions: [AuthPermission.ProductsRead] },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(analyze).not.toHaveBeenCalled();
  });

  it("自由 SQL 在调用 Service 前被 H1 Schema 拒绝", async () => {
    const analyze = vi.fn(async () => inventoryFixture());
    const registry = registryWithInventoryTool(analyze);

    await expect(
      registry.invoke(
        "get_inventory_risks",
        { startDate: "2026-08-25", endDate: "2026-08-31", sql: "SELECT 1" },
        context,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(analyze).not.toHaveBeenCalled();
  });
});

function registryWithProductTool(findById: ProductService["findById"]) {
  const registry = new ToolRegistry({ allowedToolNames: ["get_product_details"] });
  registry.register(createProductDetailsToolRegistration({ findById }));
  return registry;
}

function registryWithInventoryTool(analyze: LowStockService["analyze"]) {
  const registry = new ToolRegistry({ allowedToolNames: ["get_inventory_risks"] });
  registry.register(createInventoryRisksToolRegistration({ analyze }));
  return registry;
}

function productFixture() {
  return {
    id: "product-1",
    name: "便携榨汁杯",
    status: "ACTIVE" as const,
    price: { amountMinor: 1299, currency: "CNY" as const },
    totalInventory: 7,
    skuCount: 1,
    updatedAt: "2026-08-31T00:00:00.000Z",
    description: "商品描述",
    features: [],
    sellingPoints: [],
    skus: [
      {
        id: "sku-1",
        code: "SKU-1",
        inventory: 7,
        cost: { amountMinor: 600, currency: "CNY" as const },
        alertThreshold: 3,
        isLowStock: false,
      },
    ],
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

function inventoryFixture() {
  return {
    window: { startDate: "2026-08-25", endDate: "2026-08-31", days: 7 },
    risks: [
      {
        skuId: "sku-1",
        productId: "product-1",
        productName: "便携榨汁杯",
        code: "SKU-1",
        inventory: 6,
        alertThreshold: 3,
        soldUnits7d: 21,
        averageDailyUnits: 3,
        daysToStockout: 2,
        level: "CRITICAL" as const,
      },
      {
        skuId: "sku-2",
        productId: "product-2",
        productName: "无线蓝牙耳机",
        code: "SKU-2",
        inventory: 8,
        alertThreshold: 10,
        soldUnits7d: 0,
        averageDailyUnits: 0,
        daysToStockout: null,
        level: "WARNING" as const,
      },
    ],
  };
}

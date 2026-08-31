import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAuthContext } from "../auth/contracts/index.js";
import type { InventorySkuRecord, LowStockRepository } from "./low-stock.repository.js";
import { LowStockService } from "./low-stock.service.js";
import type { SalesQueryService } from "./sales-query.service.js";

describe("LowStockService", () => {
  const repository = {
    listMerchantSkus: vi.fn(),
  } satisfies LowStockRepository;

  const salesQueryService = {
    listEffectiveOrders: vi.fn(),
  };

  const service = new LowStockService(
    repository,
    salesQueryService as unknown as Pick<SalesQueryService, "listEffectiveOrders">,
  );

  const context = createAuthContext({
    userId: "user-1",
    merchantId: "merchant-1",
    permissions: [],
  });

  const skuFixtures: readonly InventorySkuRecord[] = [
    {
      id: "sku-a",
      merchantId: "merchant-1",
      productId: "product-a",
      productName: "商品 A",
      code: "SKU-A",
      inventory: 0,
      alertThreshold: 10,
    },
    {
      id: "sku-b",
      merchantId: "merchant-1",
      productId: "product-b",
      productName: "商品 B",
      code: "SKU-B",
      inventory: 6,
      alertThreshold: 3,
    },
    {
      id: "sku-c",
      merchantId: "merchant-1",
      productId: "product-c",
      productName: "商品 C",
      code: "SKU-C",
      inventory: 8,
      alertThreshold: 10,
    },
    {
      id: "sku-d",
      merchantId: "merchant-1",
      productId: "product-d",
      productName: "商品 D",
      code: "SKU-D",
      inventory: 100,
      alertThreshold: 10,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();

    repository.listMerchantSkus.mockResolvedValue(skuFixtures);

    salesQueryService.listEffectiveOrders.mockResolvedValue([
      {
        id: "order-1",
        merchantId: "merchant-1",
        orderNo: "ORDER-1",
        orderedAt: new Date("2026-08-25T04:00:00.000Z"),
        status: "PAID",
        totalAmount: "100.00",
        items: [
          {
            id: "item-1",
            skuId: "sku-b",
            quantity: 10,
            unitPrice: "10.00",
            lineAmount: "100.00",
          },
          {
            id: "item-2",
            skuId: "sku-d",
            quantity: 7,
            unitPrice: "10.00",
            lineAmount: "70.00",
          },
        ],
      },
      {
        id: "order-2",
        merchantId: "merchant-1",
        orderNo: "ORDER-2",
        orderedAt: new Date("2026-08-29T04:00:00.000Z"),
        status: "PAID",
        totalAmount: "110.00",
        items: [
          {
            id: "item-3",
            skuId: "sku-b",
            quantity: 11,
            unitPrice: "10.00",
            lineAmount: "110.00",
          },
        ],
      },
    ]);
  });

  it("查询当前 Merchant 的 SKU 和最近七天有效订单", async () => {
    await service.analyze(context, "2026-08-30");

    expect(repository.listMerchantSkus).toHaveBeenCalledWith(context);

    expect(salesQueryService.listEffectiveOrders).toHaveBeenCalledWith(context, {
      startDate: "2026-08-24",
      endDate: "2026-08-30",
    });
  });

  it("Fixture 复算得到一致的库存风险", async () => {
    const result = await service.analyze(context, "2026-08-30");

    expect(result.window).toEqual({
      startDate: "2026-08-24",
      endDate: "2026-08-30",
      days: 7,
    });

    expect(result.risks).toEqual([
      {
        skuId: "sku-a",
        productId: "product-a",
        productName: "商品 A",
        code: "SKU-A",
        inventory: 0,
        alertThreshold: 10,
        soldUnits7d: 0,
        averageDailyUnits: 0,
        daysToStockout: 0,
        level: "OUT_OF_STOCK",
      },
      {
        skuId: "sku-b",
        productId: "product-b",
        productName: "商品 B",
        code: "SKU-B",
        inventory: 6,
        alertThreshold: 3,
        soldUnits7d: 21,
        averageDailyUnits: 3,
        daysToStockout: 2,
        level: "CRITICAL",
      },
      {
        skuId: "sku-c",
        productId: "product-c",
        productName: "商品 C",
        code: "SKU-C",
        inventory: 8,
        alertThreshold: 10,
        soldUnits7d: 0,
        averageDailyUnits: 0,
        daysToStockout: null,
        level: "WARNING",
      },
    ]);
  });

  it("零库存和零销量均能安全处理", async () => {
    const result = await service.analyze(context, "2026-08-30");

    const outOfStock = result.risks.find((risk) => risk.skuId === "sku-a");

    const zeroSales = result.risks.find((risk) => risk.skuId === "sku-c");

    expect(outOfStock?.daysToStockout).toBe(0);

    expect(zeroSales?.averageDailyUnits).toBe(0);

    expect(zeroSales?.daysToStockout).toBeNull();
  });

  it("NORMAL SKU 不进入风险列表", async () => {
    const result = await service.analyze(context, "2026-08-30");

    expect(result.risks.some((risk) => risk.skuId === "sku-d")).toBe(false);
  });

  it("没有风险 SKU 时返回空风险集合", async () => {
    repository.listMerchantSkus.mockResolvedValue([
      {
        id: "sku-safe",
        merchantId: "merchant-1",
        productId: "product-safe",
        productName: "安全库存商品",
        code: "SKU-SAFE",
        inventory: 100,
        alertThreshold: 10,
      },
    ]);

    salesQueryService.listEffectiveOrders.mockResolvedValue([]);

    const result = await service.analyze(context, "2026-08-30");

    expect(result.risks).toEqual([]);
  });
});

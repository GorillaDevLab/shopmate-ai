import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAuthContext } from "../auth/contracts/index.js";
import type { LowStockRepository } from "./low-stock.repository.js";
import { ProductPerformanceService } from "./product-performance.service.js";
import type { SalesQueryService } from "./sales-query.service.js";

describe("ProductPerformanceService", () => {
  const repository = {
    listMerchantSkus: vi.fn(),
  } satisfies LowStockRepository;

  const salesQueryService = {
    listEffectiveOrders: vi.fn(),
  } satisfies Pick<SalesQueryService, "listEffectiveOrders">;

  const service = new ProductPerformanceService(repository, salesQueryService);

  const context = createAuthContext({
    userId: "user-1",
    merchantId: "merchant-1",
    permissions: [],
  });

  beforeEach(() => {
    vi.clearAllMocks();

    repository.listMerchantSkus.mockResolvedValue([
      {
        id: "sku-a",
        merchantId: "merchant-1",
        productId: "product-a",
        productName: "商品 A",
        code: "SKU-A",
        inventory: 100,
        alertThreshold: 10,
      },
      {
        id: "sku-b",
        merchantId: "merchant-1",
        productId: "product-b",
        productName: "商品 B",
        code: "SKU-B",
        inventory: 100,
        alertThreshold: 10,
      },
      {
        id: "sku-c",
        merchantId: "merchant-1",
        productId: "product-c",
        productName: "商品 C",
        code: "SKU-C",
        inventory: 100,
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
      {
        id: "sku-e",
        merchantId: "merchant-1",
        productId: "product-e",
        productName: "商品 E",
        code: "SKU-E",
        inventory: 100,
        alertThreshold: 10,
      },
    ]);

    salesQueryService.listEffectiveOrders.mockResolvedValue([
      {
        id: "previous-order",
        merchantId: "merchant-1",
        orderNo: "ORDER-PREVIOUS",
        orderedAt: new Date("2026-08-20T04:00:00.000Z"),
        status: "PAID",
        totalAmount: "290.00",
        items: [
          {
            id: "prev-a",
            skuId: "sku-a",
            quantity: 5,
            unitPrice: "10.00",
            lineAmount: "50.00",
          },
          {
            id: "prev-b",
            skuId: "sku-b",
            quantity: 10,
            unitPrice: "10.00",
            lineAmount: "100.00",
          },
          {
            id: "prev-c",
            skuId: "sku-c",
            quantity: 10,
            unitPrice: "10.00",
            lineAmount: "100.00",
          },
          {
            id: "prev-d",
            skuId: "sku-d",
            quantity: 4,
            unitPrice: "10.00",
            lineAmount: "40.00",
          },
        ],
      },
      {
        id: "current-order",
        merchantId: "merchant-1",
        orderNo: "ORDER-CURRENT",
        orderedAt: new Date("2026-08-26T04:00:00.000Z"),
        status: "PAID",
        totalAmount: "370.00",
        items: [
          {
            id: "current-a",
            skuId: "sku-a",
            quantity: 10,
            unitPrice: "10.00",
            lineAmount: "100.00",
          },
          {
            id: "current-b",
            skuId: "sku-b",
            quantity: 10,
            unitPrice: "10.00",
            lineAmount: "100.00",
          },
          {
            id: "current-c",
            skuId: "sku-c",
            quantity: 7,
            unitPrice: "20.00",
            lineAmount: "140.00",
          },
          {
            id: "current-e",
            skuId: "sku-e",
            quantity: 3,
            unitPrice: "10.00",
            lineAmount: "30.00",
          },
        ],
      },
    ]);
  });

  it("查询当前 Merchant SKU 和连续两个七天周期", async () => {
    await service.analyze(context, "2026-08-30");

    expect(repository.listMerchantSkus).toHaveBeenCalledWith(context);

    expect(salesQueryService.listEffectiveOrders).toHaveBeenCalledWith(context, {
      startDate: "2026-08-17",
      endDate: "2026-08-30",
    });
  });

  it("销量并列时按销售额再按 productId 稳定排序", async () => {
    const result = await service.analyze(context, "2026-08-30");

    expect(
      result.products.map((product) => ({
        productId: product.productId,
        salesRank: product.salesRank,
      })),
    ).toEqual([
      {
        productId: "product-a",
        salesRank: 1,
      },
      {
        productId: "product-b",
        salesRank: 2,
      },
      {
        productId: "product-c",
        salesRank: 3,
      },
      {
        productId: "product-e",
        salesRank: 4,
      },
      {
        productId: "product-d",
        salesRank: 5,
      },
    ]);

    expect(result.hotSellers.map((product) => product.productId)).toEqual([
      "product-a",
      "product-b",
      "product-c",
    ]);
  });

  it("销售额排行独立于销量排行", async () => {
    const result = await service.analyze(context, "2026-08-30");

    const revenueOrder = [...result.products]
      .sort((left, right) => left.revenueRank - right.revenueRank)
      .map((product) => product.productId);

    expect(revenueOrder).toEqual(["product-c", "product-a", "product-b", "product-e", "product-d"]);
  });

  it("正确识别上涨下降和新品样本", async () => {
    const result = await service.analyze(context, "2026-08-30");

    const productA = result.products.find((product) => product.productId === "product-a");

    const productC = result.products.find((product) => product.productId === "product-c");

    const productE = result.products.find((product) => product.productId === "product-e");

    expect(productA?.unitTrend).toEqual({
      current: 10,
      previous: 5,
      direction: "UP",
      changePercent: 100,
    });

    expect(productC?.unitTrend).toEqual({
      current: 7,
      previous: 10,
      direction: "DOWN",
      changePercent: -30,
    });

    expect(productE?.unitTrend).toEqual({
      current: 3,
      previous: 0,
      direction: "NEW",
      changePercent: null,
    });

    expect(result.risingProducts.map((product) => product.productId)).toEqual(["product-a"]);

    expect(result.decliningProducts.map((product) => product.productId)).toEqual([
      "product-c",
      "product-d",
    ]);
  });

  it("低表现商品返回明确判断依据", async () => {
    const result = await service.analyze(context, "2026-08-30");

    const productC = result.lowPerformers.find((product) => product.productId === "product-c");

    const productD = result.lowPerformers.find((product) => product.productId === "product-d");

    expect(productC?.lowPerformanceReasons).toEqual(["DECLINED_AT_LEAST_30_PERCENT"]);

    expect(productD?.lowPerformanceReasons).toEqual(["NO_SALES", "DECLINED_AT_LEAST_30_PERCENT"]);
  });

  it("没有历史周期时安全返回 NO_HISTORY", async () => {
    salesQueryService.listEffectiveOrders.mockResolvedValue([
      {
        id: "current-only",
        merchantId: "merchant-1",
        orderNo: "CURRENT-ONLY",
        orderedAt: new Date("2026-08-26T04:00:00.000Z"),
        status: "PAID",
        totalAmount: "100.00",
        items: [
          {
            id: "current-only-a",
            skuId: "sku-a",
            quantity: 10,
            unitPrice: "10.00",
            lineAmount: "100.00",
          },
        ],
      },
    ]);

    const result = await service.analyze(context, "2026-08-30");

    const productA = result.products.find((product) => product.productId === "product-a");

    expect(productA?.previousUnitsSold).toBeNull();
    expect(productA?.previousRevenueCents).toBeNull();

    expect(productA?.unitTrend.direction).toBe("NO_HISTORY");

    expect(productA?.revenueTrend.direction).toBe("NO_HISTORY");
  });

  it("结果包含固定的本期和上期窗口", async () => {
    const result = await service.analyze(context, "2026-08-30");

    expect(result.currentWindow).toEqual({
      startDate: "2026-08-24",
      endDate: "2026-08-30",
      days: 7,
    });

    expect(result.previousWindow).toEqual({
      startDate: "2026-08-17",
      endDate: "2026-08-23",
      days: 7,
    });
  });
});

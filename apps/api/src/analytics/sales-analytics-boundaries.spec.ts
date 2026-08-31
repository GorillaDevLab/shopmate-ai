import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAuthContext } from "../auth/contracts/index.js";
import { DashboardService } from "./dashboard.service.js";
import type { LowStockRepository } from "./low-stock.repository.js";
import { ProductPerformanceService } from "./product-performance.service.js";
import { PrismaSalesQueryRepository } from "./sales-query.repository.js";
import type { SalesQueryService } from "./sales-query.service.js";

const databaseMocks = vi.hoisted(() => ({
  order: {
    findMany: vi.fn(),
  },
}));

vi.mock("@shopmate/database", () => ({
  getPrismaClient: () => databaseMocks,
}));

describe("E7 销售指标与趋势边界", () => {
  const context = createAuthContext({
    userId: "user-e7",
    merchantId: "merchant-e7",
    permissions: [],
  });

  describe("有效订单查询", () => {
    const repository = new PrismaSalesQueryRepository();

    beforeEach(() => {
      vi.clearAllMocks();

      databaseMocks.order.findMany.mockResolvedValue([]);
    });

    it("始终限制 Merchant、排除取消订单并使用左闭右开日期范围", async () => {
      const startInclusive = new Date("2026-08-16T16:00:00.000Z");

      const endExclusive = new Date("2026-08-30T16:00:00.000Z");

      await repository.listEffectiveOrders(context, {
        startInclusive,
        endExclusive,
      });

      expect(databaseMocks.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            merchantId: "merchant-e7",
            status: {
              not: "CANCELLED",
            },
            orderedAt: {
              gte: startInclusive,
              lt: endExclusive,
            },
          },
        }),
      );
    });
  });

  describe("Dashboard 销售汇总与趋势", () => {
    const salesQueryService = {
      listEffectiveOrders: vi.fn(),
    };

    const service = new DashboardService(salesQueryService as never);

    beforeEach(() => {
      vi.clearAllMocks();

      salesQueryService.listEffectiveOrders.mockResolvedValue(createSalesFixture());
    });

    it("固定 Fixture 的今日、本月和七天销售金额完全一致", async () => {
      const result = await service.summarize(context, "2026-08-30");

      expect(result.today).toEqual({
        revenueCents: 5000,
        revenue: "50.00",
        orderCount: 1,
        unitsSold: 2,
        averageOrderValueCents: 5000,
        averageOrderValue: "50.00",
      });

      expect(result.monthToDate.metrics).toEqual({
        revenueCents: 31000,
        revenue: "310.00",
        orderCount: 3,
        unitsSold: 25,
        averageOrderValueCents: 10333,
        averageOrderValue: "103.33",
      });

      expect(result.recent.metrics).toEqual({
        revenueCents: 21000,
        revenue: "210.00",
        orderCount: 2,
        unitsSold: 15,
        averageOrderValueCents: 10500,
        averageOrderValue: "105.00",
      });

      expect(result.recent.previousMetrics).toEqual({
        revenueCents: 10000,
        revenue: "100.00",
        orderCount: 1,
        unitsSold: 10,
        averageOrderValueCents: 10000,
        averageOrderValue: "100.00",
      });
    });

    it("本期与上期销售趋势变化可复算", async () => {
      const result = await service.summarize(context, "2026-08-30");

      expect(result.recent.changes.revenue).toEqual({
        current: 21000,
        previous: 10000,
        direction: "UP",
        changePercent: 110,
      });

      expect(result.recent.changes.orderCount).toEqual({
        current: 2,
        previous: 1,
        direction: "UP",
        changePercent: 100,
      });

      expect(result.recent.changes.unitsSold).toEqual({
        current: 15,
        previous: 10,
        direction: "UP",
        changePercent: 50,
      });

      expect(result.recent.changes.averageOrderValue).toEqual({
        current: 10500,
        previous: 10000,
        direction: "UP",
        changePercent: 5,
      });
    });

    it("七天趋势包含全部日期且空日期明确补零", async () => {
      const result = await service.summarize(context, "2026-08-30");

      expect(result.recent.dailyTrend.map((point) => point.date)).toEqual([
        "2026-08-24",
        "2026-08-25",
        "2026-08-26",
        "2026-08-27",
        "2026-08-28",
        "2026-08-29",
        "2026-08-30",
      ]);

      const emptyDay = result.recent.dailyTrend.find((point) => point.date === "2026-08-25");

      expect(emptyDay).toEqual({
        date: "2026-08-25",
        revenueCents: 0,
        revenue: "0.00",
        orderCount: 0,
        unitsSold: 0,
        averageOrderValueCents: 0,
        averageOrderValue: "0.00",
      });
    });

    it("完全空数据时所有指标和客单价安全返回零", async () => {
      salesQueryService.listEffectiveOrders.mockResolvedValue([]);

      const result = await service.summarize(context, "2026-08-30");

      expect(result.today).toEqual({
        revenueCents: 0,
        revenue: "0.00",
        orderCount: 0,
        unitsSold: 0,
        averageOrderValueCents: 0,
        averageOrderValue: "0.00",
      });

      expect(result.monthToDate.metrics).toEqual({
        revenueCents: 0,
        revenue: "0.00",
        orderCount: 0,
        unitsSold: 0,
        averageOrderValueCents: 0,
        averageOrderValue: "0.00",
      });

      expect(result.recent.dailyTrend).toHaveLength(7);

      expect(
        result.recent.dailyTrend.every(
          (point) => point.revenueCents === 0 && point.orderCount === 0 && point.unitsSold === 0,
        ),
      ).toBe(true);
    });
  });

  describe("热销、趋势与低表现", () => {
    const skuRepository = {
      listMerchantSkus: vi.fn(),
    } satisfies LowStockRepository;

    const salesQueryService = {
      listEffectiveOrders: vi.fn(),
    } satisfies Pick<SalesQueryService, "listEffectiveOrders">;

    const service = new ProductPerformanceService(skuRepository, salesQueryService);

    beforeEach(() => {
      vi.clearAllMocks();

      skuRepository.listMerchantSkus.mockResolvedValue([
        {
          id: "sku-a",
          merchantId: "merchant-e7",
          productId: "product-a",
          productName: "商品 A",
          code: "SKU-A",
          inventory: 100,
          alertThreshold: 10,
        },
        {
          id: "sku-b",
          merchantId: "merchant-e7",
          productId: "product-b",
          productName: "商品 B",
          code: "SKU-B",
          inventory: 100,
          alertThreshold: 10,
        },
        {
          id: "sku-c",
          merchantId: "merchant-e7",
          productId: "product-c",
          productName: "商品 C",
          code: "SKU-C",
          inventory: 100,
          alertThreshold: 10,
        },
        {
          id: "sku-d",
          merchantId: "merchant-e7",
          productId: "product-d",
          productName: "商品 D",
          code: "SKU-D",
          inventory: 100,
          alertThreshold: 10,
        },
      ]);

      salesQueryService.listEffectiveOrders.mockResolvedValue(createSalesFixture());
    });

    it("固定 Fixture 正确识别热销、上涨、下降和新品", async () => {
      const result = await service.analyze(context, "2026-08-30");

      expect(
        result.products.map((product) => ({
          productId: product.productId,
          rank: product.salesRank,
          unitsSold: product.unitsSold,
        })),
      ).toEqual([
        {
          productId: "product-a",
          rank: 1,
          unitsSold: 10,
        },
        {
          productId: "product-b",
          rank: 2,
          unitsSold: 3,
        },
        {
          productId: "product-c",
          rank: 3,
          unitsSold: 2,
        },
        {
          productId: "product-d",
          rank: 4,
          unitsSold: 0,
        },
      ]);

      expect(result.hotSellers.map((product) => product.productId)).toEqual([
        "product-a",
        "product-b",
        "product-c",
      ]);

      expect(result.risingProducts.map((product) => product.productId)).toEqual(["product-a"]);

      expect(result.decliningProducts.map((product) => product.productId)).toEqual(["product-b"]);

      const productC = result.products.find((product) => product.productId === "product-c");

      expect(productC?.unitTrend.direction).toBe("NEW");
    });

    it("低表现商品返回可解释依据", async () => {
      const result = await service.analyze(context, "2026-08-30");

      const productB = result.lowPerformers.find((product) => product.productId === "product-b");

      const productD = result.lowPerformers.find((product) => product.productId === "product-d");

      expect(productB?.unitTrend).toEqual({
        current: 3,
        previous: 5,
        direction: "DOWN",
        changePercent: -40,
      });

      expect(productB?.lowPerformanceReasons).toEqual(["DECLINED_AT_LEAST_30_PERCENT"]);

      expect(productD?.lowPerformanceReasons).toEqual(["NO_SALES"]);
    });

    it("完全没有销售历史时返回明确的 NO_HISTORY 和零销量行为", async () => {
      salesQueryService.listEffectiveOrders.mockResolvedValue([]);

      const result = await service.analyze(context, "2026-08-30");

      const productA = result.products.find((product) => product.productId === "product-a");

      expect(productA?.previousUnitsSold).toBeNull();

      expect(productA?.unitTrend.direction).toBe("NO_HISTORY");

      expect(productA?.unitsSold).toBe(0);

      expect(productA?.lowPerformanceReasons).toEqual(["NO_SALES"]);
    });
  });
});

function createSalesFixture() {
  return [
    {
      id: "order-previous",
      merchantId: "merchant-e7",
      orderNo: "ORDER-PREVIOUS",
      orderedAt: new Date("2026-08-20T04:00:00.000Z"),
      status: "PAID",
      totalAmount: "100.00",
      items: [
        {
          id: "previous-a",
          skuId: "sku-a",
          quantity: 5,
          unitPrice: "10.00",
          lineAmount: "50.00",
        },
        {
          id: "previous-b",
          skuId: "sku-b",
          quantity: 5,
          unitPrice: "10.00",
          lineAmount: "50.00",
        },
      ],
    },
    {
      id: "order-current",
      merchantId: "merchant-e7",
      orderNo: "ORDER-CURRENT",
      orderedAt: new Date("2026-08-24T04:00:00.000Z"),
      status: "PAID",
      totalAmount: "160.00",
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
          quantity: 3,
          unitPrice: "20.00",
          lineAmount: "60.00",
        },
      ],
    },
    {
      id: "order-today",
      merchantId: "merchant-e7",
      orderNo: "ORDER-TODAY",
      orderedAt: new Date("2026-08-30T04:00:00.000Z"),
      status: "PAID",
      totalAmount: "50.00",
      items: [
        {
          id: "current-c",
          skuId: "sku-c",
          quantity: 2,
          unitPrice: "25.00",
          lineAmount: "50.00",
        },
      ],
    },
  ];
}

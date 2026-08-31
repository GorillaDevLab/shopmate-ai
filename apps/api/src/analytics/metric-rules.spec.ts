import { describe, expect, it } from "vitest";

import {
  calculateInventoryRisk,
  calculateSalesMetrics,
  calculateTrend,
  formatCents,
  parseMoneyToCents,
  rankProductPerformance,
} from "./metric-rules.js";

describe("Analytics 指标规则", () => {
  describe("库存风险", () => {
    it("用固定 7 天窗口计算日均销量", () => {
      const result = calculateInventoryRisk({
        inventory: 30,
        alertThreshold: 10,
        soldUnits7d: 14,
      });

      expect(result.averageDailyUnits).toBe(2);
      expect(result.daysToStockout).toBe(15);
      expect(result.level).toBe("NORMAL");
    });

    it("零销量不会发生除零", () => {
      const result = calculateInventoryRisk({
        inventory: 50,
        alertThreshold: 10,
        soldUnits7d: 0,
      });

      expect(result.averageDailyUnits).toBe(0);
      expect(result.daysToStockout).toBeNull();
      expect(result.level).toBe("NORMAL");
    });

    it("零库存直接识别为售罄", () => {
      const result = calculateInventoryRisk({
        inventory: 0,
        alertThreshold: 10,
        soldUnits7d: 0,
      });

      expect(result.daysToStockout).toBe(0);
      expect(result.level).toBe("OUT_OF_STOCK");
    });

    it("预计三天内售罄属于严重风险", () => {
      const result = calculateInventoryRisk({
        inventory: 6,
        alertThreshold: 3,
        soldUnits7d: 21,
      });

      expect(result.averageDailyUnits).toBe(3);
      expect(result.daysToStockout).toBe(2);
      expect(result.level).toBe("CRITICAL");
    });

    it("正库存的预计售罄天数不会被舍入为零", () => {
      const result = calculateInventoryRisk({
        inventory: 1,
        alertThreshold: 3,
        soldUnits7d: 1_000,
      });

      expect(result.daysToStockout).toBe(0.1);
      expect(result.level).toBe("CRITICAL");
    });

    it("低于预警库存时属于预警风险", () => {
      const result = calculateInventoryRisk({
        inventory: 8,
        alertThreshold: 10,
        soldUnits7d: 0,
      });

      expect(result.level).toBe("WARNING");
    });
  });

  describe("销售指标", () => {
    it("金额始终以整数分计算", () => {
      expect(parseMoneyToCents("79.00")).toBe(7900);
      expect(parseMoneyToCents("39.9")).toBe(3990);
      expect(formatCents(3990)).toBe("39.90");
    });

    it("计算销售额、订单数、销量和客单价", () => {
      const result = calculateSalesMetrics([
        {
          totalAmount: "100.00",
          items: [{ quantity: 2 }, { quantity: 1 }],
        },
        {
          totalAmount: "50.50",
          items: [{ quantity: 3 }],
        },
      ]);

      expect(result).toEqual({
        revenueCents: 15050,
        revenue: "150.50",
        orderCount: 2,
        unitsSold: 6,
        averageOrderValueCents: 7525,
        averageOrderValue: "75.25",
      });
    });

    it("客单价按分进行四舍五入", () => {
      const result = calculateSalesMetrics([
        {
          totalAmount: "3.34",
          items: [],
        },
        {
          totalAmount: "3.34",
          items: [],
        },
        {
          totalAmount: "3.33",
          items: [],
        },
      ]);

      expect(result.revenueCents).toBe(1001);
      expect(result.averageOrderValueCents).toBe(334);
      expect(result.averageOrderValue).toBe("3.34");
    });

    it("零订单客单价固定为零", () => {
      expect(calculateSalesMetrics([])).toEqual({
        revenueCents: 0,
        revenue: "0.00",
        orderCount: 0,
        unitsSold: 0,
        averageOrderValueCents: 0,
        averageOrderValue: "0.00",
      });
    });
  });

  describe("趋势规则", () => {
    it("识别上涨和下降", () => {
      expect(calculateTrend(120, 100)).toEqual({
        current: 120,
        previous: 100,
        direction: "UP",
        changePercent: 20,
      });

      expect(calculateTrend(70, 100)).toEqual({
        current: 70,
        previous: 100,
        direction: "DOWN",
        changePercent: -30,
      });
    });

    it("上期为零时不会除零", () => {
      expect(calculateTrend(10, 0)).toEqual({
        current: 10,
        previous: 0,
        direction: "NEW",
        changePercent: null,
      });
    });

    it("没有历史周期时安全返回 NO_HISTORY", () => {
      expect(calculateTrend(10, null)).toEqual({
        current: 10,
        previous: null,
        direction: "NO_HISTORY",
        changePercent: null,
      });
    });
  });

  describe("商品表现与热销规则", () => {
    it("按销量、销售额和 productId 稳定排序", () => {
      const result = rankProductPerformance([
        {
          productId: "product-b",
          unitsSold: 5,
          revenueCents: 1000,
          previousUnitsSold: 5,
        },
        {
          productId: "product-a",
          unitsSold: 5,
          revenueCents: 1000,
          previousUnitsSold: 5,
        },
        {
          productId: "product-c",
          unitsSold: 5,
          revenueCents: 1200,
          previousUnitsSold: 5,
        },
        {
          productId: "product-d",
          unitsSold: 6,
          revenueCents: 900,
          previousUnitsSold: 5,
        },
      ]);

      expect(result.map((product) => product.productId)).toEqual([
        "product-d",
        "product-c",
        "product-a",
        "product-b",
      ]);

      expect(result[0]?.isHotSeller).toBe(true);
      expect(result[1]?.isHotSeller).toBe(true);
      expect(result[2]?.isHotSeller).toBe(true);
      expect(result[3]?.isHotSeller).toBe(false);
    });

    it("零销量识别为低表现", () => {
      const [result] = rankProductPerformance([
        {
          productId: "product-a",
          unitsSold: 0,
          revenueCents: 0,
          previousUnitsSold: 0,
        },
      ]);

      expect(result?.performance).toBe("LOW");
    });

    it("销量下降至少百分之三十识别为低表现", () => {
      const [result] = rankProductPerformance([
        {
          productId: "product-a",
          unitsSold: 7,
          revenueCents: 7000,
          previousUnitsSold: 10,
        },
      ]);

      expect(result?.trend.direction).toBe("DOWN");
      expect(result?.trend.changePercent).toBe(-30);
      expect(result?.performance).toBe("LOW");
    });
  });
});

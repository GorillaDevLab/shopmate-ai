import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAuthContext } from "../auth/contracts/index.js";
import type { InventorySkuRecord, LowStockRepository } from "./low-stock.repository.js";
import { LowStockService } from "./low-stock.service.js";
import { calculateInventoryRisk } from "./metric-rules.js";
import type { SalesQueryService } from "./sales-query.service.js";

describe("E6 库存分析边界", () => {
  describe("库存风险公式边界", () => {
    const cases = [
      {
        sku: "SKU-ZERO-BOTH",
        input: {
          inventory: 0,
          alertThreshold: 0,
          soldUnits7d: 0,
        },
        expected: {
          averageDailyUnits: 0,
          daysToStockout: 0,
          level: "OUT_OF_STOCK",
        },
      },
      {
        sku: "SKU-ZERO-SALES",
        input: {
          inventory: 12,
          alertThreshold: 5,
          soldUnits7d: 0,
        },
        expected: {
          averageDailyUnits: 0,
          daysToStockout: null,
          level: "NORMAL",
        },
      },
      {
        sku: "SKU-CRITICAL-EDGE",
        input: {
          inventory: 3,
          alertThreshold: 1,
          soldUnits7d: 7,
        },
        expected: {
          averageDailyUnits: 1,
          daysToStockout: 3,
          level: "CRITICAL",
        },
      },
      {
        sku: "SKU-WARNING-EDGE",
        input: {
          inventory: 7,
          alertThreshold: 1,
          soldUnits7d: 7,
        },
        expected: {
          averageDailyUnits: 1,
          daysToStockout: 7,
          level: "WARNING",
        },
      },
      {
        sku: "SKU-THRESHOLD-EQUAL",
        input: {
          inventory: 8,
          alertThreshold: 8,
          soldUnits7d: 0,
        },
        expected: {
          averageDailyUnits: 0,
          daysToStockout: null,
          level: "WARNING",
        },
      },
      {
        sku: "SKU-NORMAL",
        input: {
          inventory: 8,
          alertThreshold: 7,
          soldUnits7d: 7,
        },
        expected: {
          averageDailyUnits: 1,
          daysToStockout: 8,
          level: "NORMAL",
        },
      },
    ] as const;

    it.each(cases)("$sku 公式分支结果正确", ({ input, expected }) => {
      const result = calculateInventoryRisk(input);

      expect(result.input).toEqual(input);

      expect(result.averageDailyUnits).toBe(expected.averageDailyUnits);

      expect(result.daysToStockout).toBe(expected.daysToStockout);

      expect(result.level).toBe(expected.level);
    });

    it.each([
      {
        sku: "SKU-NEGATIVE-INVENTORY",
        input: {
          inventory: -1,
          alertThreshold: 5,
          soldUnits7d: 0,
        },
        error: "inventory must be a non-negative integer",
      },
      {
        sku: "SKU-NEGATIVE-THRESHOLD",
        input: {
          inventory: 10,
          alertThreshold: -1,
          soldUnits7d: 0,
        },
        error: "alertThreshold must be a non-negative integer",
      },
      {
        sku: "SKU-NEGATIVE-SALES",
        input: {
          inventory: 10,
          alertThreshold: 5,
          soldUnits7d: -1,
        },
        error: "soldUnits7d must be a non-negative integer",
      },
    ])("$sku 非法输入可以定位", ({ input, error }) => {
      expect(() => calculateInventoryRisk(input)).toThrow(error);
    });
  });

  describe("LowStockService 七天窗口与排序", () => {
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
      userId: "user-e6",
      merchantId: "merchant-e6",
      permissions: [],
    });

    beforeEach(() => {
      vi.clearAllMocks();

      repository.listMerchantSkus.mockResolvedValue([]);

      salesQueryService.listEffectiveOrders.mockResolvedValue([]);
    });

    it("使用固定 asOfDate 计算跨月七天窗口且不读取系统当前日期", async () => {
      const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
        throw new Error("E6 test must not read system current date");
      });

      try {
        const result = await service.analyze(context, "2026-09-03");

        expect(salesQueryService.listEffectiveOrders).toHaveBeenCalledWith(context, {
          startDate: "2026-08-28",
          endDate: "2026-09-03",
        });

        expect(result.window).toEqual({
          startDate: "2026-08-28",
          endDate: "2026-09-03",
          days: 7,
        });
      } finally {
        dateNowSpy.mockRestore();
      }
    });

    it("按照风险等级、售罄天数、库存和 SKU code 稳定排序", async () => {
      const skus: readonly InventorySkuRecord[] = [
        {
          id: "sku-warning-b",
          merchantId: "merchant-e6",
          productId: "product-warning-b",
          productName: "预警商品 B",
          code: "SKU-WARNING-B",
          inventory: 8,
          alertThreshold: 8,
        },
        {
          id: "sku-critical-slow",
          merchantId: "merchant-e6",
          productId: "product-critical-slow",
          productName: "严重风险慢",
          code: "SKU-CRITICAL-SLOW",
          inventory: 3,
          alertThreshold: 1,
        },
        {
          id: "sku-normal",
          merchantId: "merchant-e6",
          productId: "product-normal",
          productName: "正常商品",
          code: "SKU-NORMAL",
          inventory: 8,
          alertThreshold: 1,
        },
        {
          id: "sku-out",
          merchantId: "merchant-e6",
          productId: "product-out",
          productName: "售罄商品",
          code: "SKU-OUT",
          inventory: 0,
          alertThreshold: 0,
        },
        {
          id: "sku-warning-days",
          merchantId: "merchant-e6",
          productId: "product-warning-days",
          productName: "七天预警商品",
          code: "SKU-WARNING-DAYS",
          inventory: 5,
          alertThreshold: 1,
        },
        {
          id: "sku-critical-fast",
          merchantId: "merchant-e6",
          productId: "product-critical-fast",
          productName: "严重风险快",
          code: "SKU-CRITICAL-FAST",
          inventory: 2,
          alertThreshold: 1,
        },
        {
          id: "sku-warning-a",
          merchantId: "merchant-e6",
          productId: "product-warning-a",
          productName: "预警商品 A",
          code: "SKU-WARNING-A",
          inventory: 8,
          alertThreshold: 8,
        },
      ];

      repository.listMerchantSkus.mockResolvedValue(skus);

      salesQueryService.listEffectiveOrders.mockResolvedValue([
        {
          id: "order-e6",
          merchantId: "merchant-e6",
          orderNo: "ORDER-E6",
          orderedAt: new Date("2026-09-01T04:00:00.000Z"),
          status: "PAID",
          totalAmount: "280.00",
          items: [
            {
              id: "item-critical-fast",
              skuId: "sku-critical-fast",
              quantity: 7,
              unitPrice: "10.00",
              lineAmount: "70.00",
            },
            {
              id: "item-critical-slow",
              skuId: "sku-critical-slow",
              quantity: 7,
              unitPrice: "10.00",
              lineAmount: "70.00",
            },
            {
              id: "item-warning-days",
              skuId: "sku-warning-days",
              quantity: 7,
              unitPrice: "10.00",
              lineAmount: "70.00",
            },
            {
              id: "item-normal",
              skuId: "sku-normal",
              quantity: 7,
              unitPrice: "10.00",
              lineAmount: "70.00",
            },
          ],
        },
      ]);

      const result = await service.analyze(context, "2026-09-03");

      expect(
        result.risks.map((risk) => ({
          sku: risk.code,
          level: risk.level,
          daysToStockout: risk.daysToStockout,
        })),
      ).toEqual([
        {
          sku: "SKU-OUT",
          level: "OUT_OF_STOCK",
          daysToStockout: 0,
        },
        {
          sku: "SKU-CRITICAL-FAST",
          level: "CRITICAL",
          daysToStockout: 2,
        },
        {
          sku: "SKU-CRITICAL-SLOW",
          level: "CRITICAL",
          daysToStockout: 3,
        },
        {
          sku: "SKU-WARNING-DAYS",
          level: "WARNING",
          daysToStockout: 5,
        },
        {
          sku: "SKU-WARNING-A",
          level: "WARNING",
          daysToStockout: null,
        },
        {
          sku: "SKU-WARNING-B",
          level: "WARNING",
          daysToStockout: null,
        },
      ]);

      expect(result.risks.some((risk) => risk.code === "SKU-NORMAL")).toBe(false);
    });
  });
});

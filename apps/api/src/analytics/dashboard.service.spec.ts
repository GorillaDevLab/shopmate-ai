import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAuthContext } from "../auth/contracts/index.js";
import { DashboardService } from "./dashboard.service.js";

describe("DashboardService", () => {
  const salesQueryService = {
    listEffectiveOrders: vi.fn(),
  };

  const service = new DashboardService(salesQueryService as never);

  const context = createAuthContext({
    userId: "user-1",
    merchantId: "merchant-1",
    permissions: [],
  });

  beforeEach(() => {
    vi.clearAllMocks();

    salesQueryService.listEffectiveOrders.mockResolvedValue([
      {
        id: "order-month",
        merchantId: "merchant-1",
        orderNo: "ORDER-MONTH",
        orderedAt: new Date("2026-08-10T04:00:00.000Z"),
        status: "PAID",
        totalAmount: "100.00",
        items: [
          {
            id: "item-month",
            skuId: "sku-a",
            quantity: 2,
            unitPrice: "50.00",
            lineAmount: "100.00",
          },
        ],
      },
      {
        id: "order-previous",
        merchantId: "merchant-1",
        orderNo: "ORDER-PREVIOUS",
        orderedAt: new Date("2026-08-20T04:00:00.000Z"),
        status: "PAID",
        totalAmount: "80.00",
        items: [
          {
            id: "item-previous",
            skuId: "sku-a",
            quantity: 1,
            unitPrice: "80.00",
            lineAmount: "80.00",
          },
        ],
      },
      {
        id: "order-current",
        merchantId: "merchant-1",
        orderNo: "ORDER-CURRENT",
        orderedAt: new Date("2026-08-24T04:00:00.000Z"),
        status: "PAID",
        totalAmount: "120.00",
        items: [
          {
            id: "item-current",
            skuId: "sku-b",
            quantity: 3,
            unitPrice: "40.00",
            lineAmount: "120.00",
          },
        ],
      },
      {
        id: "order-today",
        merchantId: "merchant-1",
        orderNo: "ORDER-TODAY",
        orderedAt: new Date("2026-08-30T04:00:00.000Z"),
        status: "PAID",
        totalAmount: "50.00",
        items: [
          {
            id: "item-today",
            skuId: "sku-c",
            quantity: 2,
            unitPrice: "25.00",
            lineAmount: "50.00",
          },
        ],
      },
    ]);
  });

  it("查询覆盖本月和最近两个七天周期所需范围", async () => {
    await service.summarize(context, "2026-08-30");

    expect(salesQueryService.listEffectiveOrders).toHaveBeenCalledWith(context, {
      startDate: "2026-08-01",
      endDate: "2026-08-30",
    });
  });

  it("Fixture 复算今日和本月汇总正确", async () => {
    const result = await service.summarize(context, "2026-08-30");

    expect(result.today).toEqual({
      revenueCents: 5000,
      revenue: "50.00",
      orderCount: 1,
      unitsSold: 2,
      averageOrderValueCents: 5000,
      averageOrderValue: "50.00",
    });

    expect(result.monthToDate).toEqual({
      startDate: "2026-08-01",
      endDate: "2026-08-30",
      metrics: {
        revenueCents: 35000,
        revenue: "350.00",
        orderCount: 4,
        unitsSold: 8,
        averageOrderValueCents: 8750,
        averageOrderValue: "87.50",
      },
    });
  });

  it("计算最近七天和上一个七天周期指标变化", async () => {
    const result = await service.summarize(context, "2026-08-30");

    expect(result.recent.currentWindow).toEqual({
      startDate: "2026-08-24",
      endDate: "2026-08-30",
      days: 7,
    });

    expect(result.recent.previousWindow).toEqual({
      startDate: "2026-08-17",
      endDate: "2026-08-23",
      days: 7,
    });

    expect(result.recent.metrics).toEqual({
      revenueCents: 17000,
      revenue: "170.00",
      orderCount: 2,
      unitsSold: 5,
      averageOrderValueCents: 8500,
      averageOrderValue: "85.00",
    });

    expect(result.recent.previousMetrics).toEqual({
      revenueCents: 8000,
      revenue: "80.00",
      orderCount: 1,
      unitsSold: 1,
      averageOrderValueCents: 8000,
      averageOrderValue: "80.00",
    });

    expect(result.recent.changes.revenue).toEqual({
      current: 17000,
      previous: 8000,
      direction: "UP",
      changePercent: 112.5,
    });

    expect(result.recent.changes.orderCount).toEqual({
      current: 2,
      previous: 1,
      direction: "UP",
      changePercent: 100,
    });

    expect(result.recent.changes.unitsSold).toEqual({
      current: 5,
      previous: 1,
      direction: "UP",
      changePercent: 400,
    });

    expect(result.recent.changes.averageOrderValue).toEqual({
      current: 8500,
      previous: 8000,
      direction: "UP",
      changePercent: 6.3,
    });
  });

  it("最近七天每天都有趋势点且无订单日补零", async () => {
    const result = await service.summarize(context, "2026-08-30");

    expect(result.recent.dailyTrend).toHaveLength(7);

    expect(result.recent.dailyTrend.map((point) => point.date)).toEqual([
      "2026-08-24",
      "2026-08-25",
      "2026-08-26",
      "2026-08-27",
      "2026-08-28",
      "2026-08-29",
      "2026-08-30",
    ]);

    expect(result.recent.dailyTrend[1]).toEqual({
      date: "2026-08-25",
      revenueCents: 0,
      revenue: "0.00",
      orderCount: 0,
      unitsSold: 0,
      averageOrderValueCents: 0,
      averageOrderValue: "0.00",
    });
  });

  it("零订单时所有汇总安全返回零且客单价为零", async () => {
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

    expect(result.recent.metrics.averageOrderValue).toBe("0.00");

    expect(result.monthToDate.metrics.averageOrderValue).toBe("0.00");
  });

  it("按照 Asia Shanghai 自然日划分趋势点", async () => {
    salesQueryService.listEffectiveOrders.mockResolvedValue([
      {
        id: "before-boundary",
        merchantId: "merchant-1",
        orderNo: "ORDER-BEFORE",
        orderedAt: new Date("2026-08-29T15:59:59.999Z"),
        status: "PAID",
        totalAmount: "10.00",
        items: [
          {
            id: "item-before",
            skuId: "sku-a",
            quantity: 1,
            unitPrice: "10.00",
            lineAmount: "10.00",
          },
        ],
      },
      {
        id: "after-boundary",
        merchantId: "merchant-1",
        orderNo: "ORDER-AFTER",
        orderedAt: new Date("2026-08-29T16:00:00.000Z"),
        status: "PAID",
        totalAmount: "20.00",
        items: [
          {
            id: "item-after",
            skuId: "sku-a",
            quantity: 1,
            unitPrice: "20.00",
            lineAmount: "20.00",
          },
        ],
      },
    ]);

    const result = await service.summarize(context, "2026-08-30");

    const august29 = result.recent.dailyTrend.find((point) => point.date === "2026-08-29");

    const august30 = result.recent.dailyTrend.find((point) => point.date === "2026-08-30");

    expect(august29?.revenue).toBe("10.00");
    expect(august30?.revenue).toBe("20.00");
  });

  it("拒绝不存在的日历日期", async () => {
    await expect(service.summarize(context, "2026-02-30")).rejects.toThrow(
      "date is not a valid calendar date",
    );
  });
});

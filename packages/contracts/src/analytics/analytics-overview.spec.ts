import { describe, expect, it } from "vitest";
import { AnalyticsOverviewResponseSchema } from "../index.js";

const valid = {
  period: { startDate: "2026-08-30", endDate: "2026-08-31", days: 2 },
  comparisonPeriod: { startDate: "2026-08-28", endDate: "2026-08-29", days: 2 },
  totals: {
    current: { revenueMinor: 3000, orders: 3, units: 4 },
    previous: { revenueMinor: 2000, orders: 2, units: 2 },
  },
  daily: [
    { date: "2026-08-30", revenueMinor: 1000, orders: 1, units: 1 },
    { date: "2026-08-31", revenueMinor: 2000, orders: 2, units: 3 },
  ],
  previousDaily: [
    { date: "2026-08-28", revenueMinor: 500 },
    { date: "2026-08-29", revenueMinor: 1500 },
  ],
  channels: [
    {
      id: "store-1",
      name: "北京朝阳店",
      platform: "OFFLINE",
      revenueMinor: 3000,
      previousRevenueMinor: 2000,
      orders: 3,
      units: 4,
      dailyRevenueMinor: [1000, 2000],
    },
  ],
  products: [
    { productId: "p1", name: "保温杯", units: 4, revenueMinor: 3000, previousRevenueMinor: 0 },
  ],
};

describe("AnalyticsOverviewResponseSchema", () => {
  it("接受完整覆盖统计周期的经营分析数据", () => {
    expect(AnalyticsOverviewResponseSchema.parse(valid)).toEqual(valid);
  });

  it("接受没有门店数据的商家（渠道为空）", () => {
    expect(AnalyticsOverviewResponseSchema.safeParse({ ...valid, channels: [] }).success).toBe(
      true,
    );
  });

  it("拒绝与统计周期不等长的日序列", () => {
    const result = AnalyticsOverviewResponseSchema.safeParse({
      ...valid,
      daily: valid.daily.slice(1),
    });
    expect(result.success).toBe(false);
  });

  it("拒绝渠道日序列缺天", () => {
    const channels = [{ ...valid.channels[0], dailyRevenueMinor: [1000] }];
    expect(AnalyticsOverviewResponseSchema.safeParse({ ...valid, channels }).success).toBe(false);
  });

  it("拒绝负数金额", () => {
    const totals = { ...valid.totals, current: { revenueMinor: -1, orders: 0, units: 0 } };
    expect(AnalyticsOverviewResponseSchema.safeParse({ ...valid, totals }).success).toBe(false);
  });
});

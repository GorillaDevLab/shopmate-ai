import type { AnalyticsOverviewResponse } from "@shopmate/contracts";
import { describe, expect, it, vi } from "vitest";

import { AuthPermission } from "../../auth/contracts/auth-context.js";
import { createBusinessOverviewTool, toOutput } from "./business-overview.tool.js";

const overview: AnalyticsOverviewResponse = {
  period: { startDate: "2026-08-02", endDate: "2026-08-31", days: 30 },
  comparisonPeriod: { startDate: "2026-07-03", endDate: "2026-08-01", days: 30 },
  totals: {
    current: { revenueMinor: 1_781_820, orders: 27, units: 279 },
    previous: { revenueMinor: 3_000_000, orders: 40, units: 300 },
  },
  daily: [],
  previousDaily: [],
  channels: [
    {
      id: "s1",
      name: "北京朝阳店",
      platform: "OFFLINE",
      revenueMinor: 1_200_000,
      previousRevenueMinor: 1_000_000,
      orders: 20,
      units: 200,
      dailyRevenueMinor: [],
    },
  ],
  products: [
    {
      productId: "p1",
      name: "云感纯棉短袖T恤",
      units: 171,
      revenueMinor: 1_350_900,
      previousRevenueMinor: 0,
    },
  ],
};

describe("get_business_overview", () => {
  it("converts money to yuan and precomputes change and share ratios", () => {
    const output = toOutput(overview);
    expect(output.status).toBe("ok");
    if (output.status !== "ok") return;
    expect(output.data.current).toEqual({
      revenueYuan: 17_818.2,
      orders: 27,
      units: 279,
      averageOrderValueYuan: 659.93,
    });
    expect(output.data.revenueChangeRatio).toBe(-0.4061);
    expect(output.data.channels[0]).toMatchObject({
      revenueYuan: 12_000,
      revenueChangeRatio: 0.2,
      revenueShareRatio: 0.6735,
    });
    // 上期为 0 时不给出变化比例，避免“无穷大”增长。
    expect(output.data.topProducts[0].revenueChangeRatio).toBeNull();
  });

  it("reports empty when neither period has orders", () => {
    const empty = {
      ...overview,
      totals: {
        current: { revenueMinor: 0, orders: 0, units: 0 },
        previous: { revenueMinor: 0, orders: 0, units: 0 },
      },
    };
    expect(toOutput(empty)).toMatchObject({ status: "empty", reason: "NO_DATA" });
  });

  it("defaults to the last 30 days and passes the caller's merchant context", async () => {
    const service = { get: vi.fn(async () => overview) };
    const tool = createBusinessOverviewTool(service);
    const context = {
      userId: "u1",
      merchantId: "m1",
      permissions: [AuthPermission.OrdersRead],
    };
    await tool.handler({ endDate: "2026-08-31" }, context);
    expect(service.get).toHaveBeenCalledWith(context, {
      asOfDate: "2026-08-31",
      startDate: "2026-08-02",
    });
    expect(tool.requiredPermissions).toEqual([AuthPermission.OrdersRead]);
  });
});

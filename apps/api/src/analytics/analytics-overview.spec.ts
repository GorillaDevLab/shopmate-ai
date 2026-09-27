import { AnalyticsOverviewResponseSchema } from "@shopmate/contracts";
import { describe, expect, it } from "vitest";

import {
  buildAnalyticsOverview,
  previousWindow,
  UNASSIGNED_CHANNEL_ID,
  type OverviewOrder,
} from "./analytics-overview.js";

const current = { startDate: "2026-08-30", endDate: "2026-08-31", days: 2 };
const previous = previousWindow(current);
const chaoyang = { id: "s1", name: "北京朝阳店", platform: "OFFLINE" };
const taobao = { id: "s2", name: "淘宝旗舰店", platform: "TAOBAO" };

// 上海时间 = UTC+8；T04:00Z 即当地中午，避免跨日边界干扰。
function order(
  date: string,
  total: string,
  store: OverviewOrder["store"],
  items: [string, number, string][] = [["p1", 1, total]],
): OverviewOrder {
  return {
    orderedAt: new Date(`${date}T04:00:00.000Z`),
    totalAmount: total,
    store,
    items: items.map(([productId, quantity, lineAmount]) => ({
      productId,
      productName: `商品${productId}`,
      quantity,
      lineAmount,
    })),
  };
}

describe("previousWindow", () => {
  it("返回紧邻本期之前的等长周期", () => {
    expect(previous).toEqual({ startDate: "2026-08-28", endDate: "2026-08-29", days: 2 });
  });
});

describe("buildAnalyticsOverview", () => {
  const orders = [
    order("2026-08-30", "100.00", chaoyang, [["p1", 2, "100.00"]]),
    order("2026-08-31", "50.50", taobao, [["p2", 1, "50.50"]]),
    order("2026-08-31", "30.00", chaoyang, [["p1", 1, "30.00"]]),
    order("2026-08-29", "80.00", chaoyang, [["p1", 1, "80.00"]]),
    order("2026-08-20", "999.00", taobao),
  ];
  const result = buildAnalyticsOverview(current, previous, orders);

  it("输出符合契约", () => {
    expect(AnalyticsOverviewResponseSchema.parse(result)).toEqual(result);
  });

  it("汇总本期与上一周期，忽略两个周期之外的订单", () => {
    expect(result.totals.current).toEqual({ revenueMinor: 18050, orders: 3, units: 4 });
    expect(result.totals.previous).toEqual({ revenueMinor: 8000, orders: 1, units: 1 });
  });

  it("按上海自然日生成完整日序列", () => {
    expect(result.daily).toEqual([
      { date: "2026-08-30", revenueMinor: 10000, orders: 1, units: 2 },
      { date: "2026-08-31", revenueMinor: 8050, orders: 2, units: 2 },
    ]);
    expect(result.previousDaily).toEqual([
      { date: "2026-08-28", revenueMinor: 0 },
      { date: "2026-08-29", revenueMinor: 8000 },
    ]);
  });

  it("把 UTC 前一天 16:00 之后的订单计入上海次日", () => {
    const late = {
      ...order("2026-08-30", "10.00", chaoyang),
      orderedAt: new Date("2026-08-30T16:30:00.000Z"),
    };
    const shifted = buildAnalyticsOverview(current, previous, [late]);
    expect(shifted.daily.map((day) => day.revenueMinor)).toEqual([0, 1000]);
  });

  it("按本期销售额排序渠道，并带上一周期与日序列", () => {
    expect(result.channels.map((channel) => channel.name)).toEqual(["北京朝阳店", "淘宝旗舰店"]);
    expect(result.channels[0]).toMatchObject({
      revenueMinor: 13000,
      previousRevenueMinor: 8000,
      orders: 2,
      units: 3,
      dailyRevenueMinor: [10000, 3000],
    });
  });

  it("按本期销售额取商品前五，并带上一周期销售额", () => {
    expect(result.products[0]).toEqual({
      productId: "p1",
      name: "商品p1",
      units: 3,
      revenueMinor: 13000,
      previousRevenueMinor: 8000,
    });
  });

  it("商家没有接入门店时不返回渠道拆分", () => {
    const noStores = buildAnalyticsOverview(current, previous, [
      order("2026-08-31", "10.00", null),
    ]);
    expect(noStores.channels).toEqual([]);
    expect(noStores.totals.current.revenueMinor).toBe(1000);
  });

  it("部分订单未关联门店时单独列出未关联渠道", () => {
    const mixed = buildAnalyticsOverview(current, previous, [
      order("2026-08-31", "10.00", null),
      order("2026-08-31", "20.00", chaoyang),
    ]);
    expect(mixed.channels.map((channel) => channel.id)).toEqual(["s1", UNASSIGNED_CHANNEL_ID]);
  });

  it("没有订单时返回全零序列", () => {
    const empty = buildAnalyticsOverview(current, previous, []);
    expect(empty.daily.every((day) => day.revenueMinor === 0)).toBe(true);
    expect(empty.products).toEqual([]);
  });
});

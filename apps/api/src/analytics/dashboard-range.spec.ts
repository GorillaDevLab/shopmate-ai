import { describe, expect, it } from "vitest";
import { AnalyticsDashboardResponseSchema } from "@shopmate/contracts";
import { createAuthContext } from "../auth/contracts/index.js";
import { DashboardService } from "./dashboard.service.js";
import { DashboardApiService } from "./dashboard-api.service.js";
import { LowStockService } from "./low-stock.service.js";
import { ProductPerformanceService } from "./product-performance.service.js";
import { SalesQueryService } from "./sales-query.service.js";
import type { SalesOrderRecord } from "./sales-query.repository.js";

const context = createAuthContext({ userId: "u", merchantId: "m", permissions: [] });
function order(id: string, date: string, amount: string, quantity: number): SalesOrderRecord {
  return {
    id,
    merchantId: "m",
    orderNo: id,
    orderedAt: new Date(date),
    status: "PAID",
    totalAmount: amount,
    items: [{ id, skuId: "s", quantity, unitPrice: amount, lineAmount: amount }],
  };
}
function createService() {
  const orders = [
    order("prior", "2026-07-15T00:00:00Z", "10.00", 1),
    order("aug", "2026-08-10T00:00:00Z", "60.00", 6),
    order("edge", "2026-08-30T16:00:00Z", "30.00", 3),
  ];
  const query = new SalesQueryService({
    listEffectiveOrders: async (auth, range) =>
      orders.filter(
        (o) =>
          o.merchantId === auth.merchantId &&
          o.orderedAt >= range.startInclusive &&
          o.orderedAt < range.endExclusive,
      ),
  });
  const skus = {
    listMerchantSkus: async () => [
      {
        id: "s",
        merchantId: "m",
        productId: "p",
        productName: "测试商品",
        code: "SKU",
        inventory: 3,
        alertThreshold: 10,
      },
    ],
  };
  return new DashboardApiService(
    new DashboardService(query),
    new LowStockService(skus, query),
    new ProductPerformanceService(skus, query),
  );
}
describe("看板整页统计范围", () => {
  it("30 天同时影响汇总、完整趋势、排行与库存预测，并比较前 30 天", async () => {
    const result = await createService().get(context, {
      asOfDate: "2026-08-31",
      startDate: "2026-08-02",
    });
    expect(AnalyticsDashboardResponseSchema.safeParse(result).success).toBe(true);
    expect(result.period.days).toBe(30);
    expect(result.metrics).toContainEqual({ key: "sales", value: 9000, changeRatio: 8 });
    expect(result.trend).toHaveLength(30);
    expect(result.trend.at(-1)).toEqual({ date: "2026-08-31", revenueMinor: 3000 });
    expect(result.products[0]).toMatchObject({ sold: 9, salesMinor: 9000 });
    expect(result.inventoryAlerts[0]).toMatchObject({
      inventory: 3,
      recentSold: 9,
      forecast: { status: "estimated", days: 10 },
    });
  });
  it("单日区间只包含上海当日销量，默认仍为七天", async () => {
    const result = await createService().get(context, {
      asOfDate: "2026-08-31",
      startDate: "2026-08-31",
    });
    expect(result.period.days).toBe(1);
    expect(result.metrics[0]?.value).toBe(3000);
    expect(result.inventoryAlerts[0]?.forecast).toEqual({ status: "estimated", days: 1 });
    expect((await createService().get(context, { asOfDate: "2026-08-31" })).period.days).toBe(7);
  });
  it("非法和反向时段被拒绝，长历史时段可用", async () => {
    for (const startDate of ["2026-02-30", "2026-09-01"]) {
      await expect(
        createService().get(context, { asOfDate: "2026-08-31", startDate }),
      ).rejects.toMatchObject({ status: 400 });
    }
    const result = await createService().get(context, {
      asOfDate: "2026-08-31",
      startDate: "2026-07-01",
    });
    expect(result.period.days).toBe(62);
    expect(result.trend).toHaveLength(62);
  });
});

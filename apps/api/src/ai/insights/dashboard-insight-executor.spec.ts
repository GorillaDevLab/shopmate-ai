import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { AuthPermission } from "../../auth/contracts/auth-context.js";

import { DashboardInsightExecutor } from "./dashboard-insight-executor.js";

const context = {
  userId: "user-1",
  merchantId: "merchant-1",
  permissions: [AuthPermission.OrdersRead, AuthPermission.ProductsRead],
} as const;

const productQuery = {
  dataset: "sales",
  metric: "revenue",
  aggregation: "sum",
  groupBy: "product",
  dateRange: { start: "2026-01-01", end: "2026-08-31" },
  filters: [],
  order: "desc",
  limit: 2,
  visualization: "pie",
} as const;

describe("受限经营查询执行器", () => {
  it("在当前 Merchant Scope 内生成商品销售额饼图", async () => {
    const performance = {
      analyze: vi.fn().mockResolvedValue({
        products: [
          { productId: "p-1", productName: "短袖", unitsSold: 3, revenueCents: 12000 },
          { productId: "p-2", productName: "水杯", unitsSold: 2, revenueCents: 8000 },
        ],
      }),
    };
    const executor = new DashboardInsightExecutor(stubDashboard(), performance, stubInventory());

    await expect(executor.execute(context, productQuery)).resolves.toMatchObject({
      kind: "pie",
      unit: "currencyMinor",
      slices: [
        { key: "p-1", label: "短袖", value: 12000 },
        { key: "p-2", label: "水杯", value: 8000 },
      ],
    });
    expect(performance.analyze).toHaveBeenCalledWith(context, "2026-08-31", "2026-01-01");
  });

  it("为无销售数据返回结构化空饼图", async () => {
    const executor = new DashboardInsightExecutor(
      stubDashboard(),
      { analyze: vi.fn().mockResolvedValue({ products: [] }) },
      stubInventory(),
    );
    await expect(executor.execute(context, productQuery)).resolves.toMatchObject({
      kind: "pie",
      slices: [],
    });
  });

  it("根据销售摘要生成纯结构化报告", async () => {
    const executor = new DashboardInsightExecutor(
      stubDashboard(),
      stubPerformance(),
      stubInventory(),
    );
    await expect(
      executor.execute(context, { ...productQuery, groupBy: null, visualization: "report" }),
    ).resolves.toMatchObject({
      kind: "report",
      metrics: expect.arrayContaining([{ label: "销售额", value: "¥200.00" }]),
    });
  });

  it("库存报告使用当前商家的库存风险数据", async () => {
    const inventory = {
      analyze: vi.fn().mockResolvedValue({
        risks: [
          {
            productId: "p-1",
            productName: "短袖",
            skuId: "s-1",
            code: "SKU-1",
            inventory: 3,
            level: "CRITICAL",
          },
        ],
      }),
    };
    const executor = new DashboardInsightExecutor(stubDashboard(), stubPerformance(), inventory);
    await expect(
      executor.execute(context, {
        ...productQuery,
        dataset: "inventory",
        metric: "inventory",
        groupBy: null,
        visualization: "report",
      }),
    ).resolves.toMatchObject({
      kind: "report",
      metrics: expect.arrayContaining([{ label: "风险 SKU", value: "1 项" }]),
    });
  });

  it("缺少读取权限时不调用领域服务", async () => {
    const dashboard = stubDashboard();
    const executor = new DashboardInsightExecutor(dashboard, stubPerformance(), stubInventory());
    await expect(
      executor.execute(
        { ...context, permissions: [] },
        { ...productQuery, groupBy: null, visualization: "report" },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(dashboard.summarize).not.toHaveBeenCalled();
  });
});

function stubDashboard() {
  return {
    summarize: vi.fn().mockResolvedValue({
      recent: {
        metrics: { revenueCents: 20000, orderCount: 5, unitsSold: 5, averageOrderValueCents: 4000 },
        dailyTrend: [],
      },
    }),
  };
}

function stubPerformance() {
  return { analyze: vi.fn().mockResolvedValue({ products: [] }) };
}

function stubInventory() {
  return { analyze: vi.fn().mockResolvedValue({ risks: [] }) };
}

import { describe, expect, it, vi } from "vitest";
const database = vi.hoisted(() => ({
  order: { findMany: vi.fn() },
  store: { findMany: vi.fn(), count: vi.fn() },
}));
vi.mock("@shopmate/database", () => ({ getPrismaClient: () => database }));
import { StoreSalesReader } from "./store-sales-reader.js";
import { validateDashboardInsightQuery } from "./dashboard-insight-validator.js";
import { AuthPermission } from "../../auth/contracts/index.js";

const context = { userId: "u", merchantId: "m", permissions: [AuthPermission.OrdersRead] };
const query = {
  dataset: "sales",
  metric: "revenue",
  aggregation: "sum",
  groupBy: "store",
  dateRange: { start: "2026-08-15", end: "2026-09-13" },
  filters: [],
  order: "desc",
  limit: 12,
  visualization: "pie",
};

describe("store sales analytics", () => {
  it("counts only the authenticated merchant's stores and denies missing permission", async () => {
    database.store.count.mockResolvedValue(150);
    await expect(new StoreSalesReader().count(context)).resolves.toBe(150);
    expect(database.store.count).toHaveBeenCalledWith({ where: { merchantId: "m" } });
    await expect(new StoreSalesReader().count({ ...context, permissions: [] })).rejects.toThrow();
    expect(database.store.count).toHaveBeenCalledTimes(1);
  });
  it("uses order totals for store revenue and counts orders without items", async () => {
    database.order.findMany.mockResolvedValue([
      {
        store: null,
        totalAmount: "90.00",
        items: [{ quantity: 1, lineAmount: "100.00", sku: { product: { id: "p", name: "商品" } } }],
      },
      { store: null, totalAmount: "20.00", items: [] },
    ]);
    const reader = new StoreSalesReader();
    await expect(reader.read(context, validateDashboardInsightQuery(query))).resolves.toEqual([
      { key: "unassigned", label: "未分配门店", value: 11000 },
    ]);
    await expect(
      reader.read(
        context,
        validateDashboardInsightQuery({ ...query, metric: "orderCount", aggregation: "count" }),
      ),
    ).resolves.toEqual([{ key: "unassigned", label: "未分配门店", value: 2 }]);
    await expect(
      reader.read(
        context,
        validateDashboardInsightQuery({
          ...query,
          metric: "averageOrderValue",
          aggregation: "average",
          visualization: "bar",
        }),
      ),
    ).resolves.toEqual([{ key: "unassigned", label: "未分配门店", value: 5500 }]);
    await expect(
      reader.read(
        context,
        validateDashboardInsightQuery({
          ...query,
          filters: [{ field: "product", operator: "equals", values: ["p"] }],
        }),
      ),
    ).resolves.toEqual([{ key: "unassigned", label: "未分配门店", value: 10000 }]);
  });
  it("rejects missing permissions and excessive result sets", async () => {
    await expect(
      new StoreSalesReader().read(
        { ...context, permissions: [] },
        validateDashboardInsightQuery(query),
      ),
    ).rejects.toThrow();
    database.order.findMany.mockResolvedValue(Array.from({ length: 20001 }, () => ({})));
    await expect(
      new StoreSalesReader().read(context, validateDashboardInsightQuery(query)),
    ).rejects.toThrow("上限");
  });
  it("keeps legacy unassigned orders visible and counts each order once", async () => {
    const item = { quantity: 2, lineAmount: "12.34", sku: { product: { id: "p", name: "商品" } } };
    database.order.findMany.mockResolvedValue([
      { store: null, totalAmount: "24.68", items: [item, item] },
    ]);
    await expect(
      new StoreSalesReader().read(
        context,
        validateDashboardInsightQuery({ ...query, metric: "orderCount", aggregation: "count" }),
      ),
    ).resolves.toEqual([{ key: "unassigned", label: "未分配门店", value: 1 }]);
    await expect(
      new StoreSalesReader().read(
        context,
        validateDashboardInsightQuery({
          ...query,
          metric: "averageOrderValue",
          aggregation: "average",
          visualization: "bar",
        }),
      ),
    ).resolves.toEqual([{ key: "unassigned", label: "未分配门店", value: 2468 }]);
  });
  it("queries paid orders in the authenticated merchant and aggregates integer cents", async () => {
    database.order.findMany.mockResolvedValue([
      {
        store: { id: "s", name: "北京店", platform: "OFFLINE" },
        totalAmount: "12.34",
        items: [{ quantity: 2, lineAmount: "12.34", sku: { product: { id: "p", name: "商品" } } }],
      },
      {
        store: { id: "s", name: "北京店", platform: "OFFLINE" },
        totalAmount: "10.00",
        items: [{ quantity: 1, lineAmount: "10.00", sku: { product: { id: "p", name: "商品" } } }],
      },
    ]);
    const result = await new StoreSalesReader().read(context, validateDashboardInsightQuery(query));
    expect(result).toEqual([{ key: "s", label: "北京店", value: 2234 }]);
    expect(database.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ merchantId: "m", status: "PAID" }),
      }),
    );
  });
  it("rejects foreign store IDs before querying sales", async () => {
    database.store.findMany.mockResolvedValue([]);
    database.order.findMany.mockClear();
    await expect(
      new StoreSalesReader().read(
        context,
        validateDashboardInsightQuery({
          ...query,
          filters: [{ field: "store", operator: "equals", values: ["foreign"] }],
        }),
      ),
    ).rejects.toThrow();
    expect(database.order.findMany).not.toHaveBeenCalled();
  });
});

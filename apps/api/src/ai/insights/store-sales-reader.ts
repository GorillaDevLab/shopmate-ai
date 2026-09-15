import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { getPrismaClient } from "@shopmate/database";
import type { DashboardInsightQuery } from "@shopmate/contracts";
import { AuthPermission, type AuthContext } from "../../auth/contracts/index.js";

export class StoreSalesReader {
  async catalog(context: AuthContext) {
    if (!context.permissions.includes(AuthPermission.OrdersRead)) return [];
    return getPrismaClient().store.findMany({
      where: { merchantId: context.merchantId },
      select: { id: true, name: true, platform: true },
      take: 100,
      orderBy: { id: "asc" },
    });
  }

  async read(context: AuthContext, query: DashboardInsightQuery) {
    requireOrders(context);
    const filters = query.filters.map((filter) => ({
      field: filter.field,
      values: [...filter.values],
    }));
    await this.checkStores(context, filters);
    const rows = await getPrismaClient().order.findMany({
      where: {
        merchantId: context.merchantId,
        status: "PAID",
        orderedAt: {
          gte: new Date(`${query.dateRange.start}T00:00:00+08:00`),
          lt: new Date(Date.parse(`${query.dateRange.end}T00:00:00+08:00`) + 86400000),
        },
        AND: filters
          .filter((filter) => filter.field !== "product")
          .map((filter) =>
            filter.field === "store"
              ? { storeId: { in: filter.values } }
              : { store: { platform: { in: filter.values }, merchantId: context.merchantId } },
          ),
      },
      include: { store: true, items: { include: { sku: { include: { product: true } } } } },
      take: 20001,
      orderBy: { id: "asc" },
    });
    if (rows.length > 20000)
      throw new BadRequestException("数据量超出单次分析上限，请缩短日期范围");
    return aggregate(rows, query);
  }

  private async checkStores(
    context: AuthContext,
    filters: readonly { field: string; values: string[] }[],
  ) {
    const ids = [
      ...new Set(
        filters.filter((filter) => filter.field === "store").flatMap((filter) => filter.values),
      ),
    ];
    if (!ids.length) return;
    const stores = await getPrismaClient().store.findMany({
      where: { merchantId: context.merchantId, id: { in: ids } },
      select: { id: true },
    });
    if (stores.length !== ids.length) throw new ForbiddenException("无法访问所选门店");
  }
}

function requireOrders(context: AuthContext) {
  if (!context.permissions.includes(AuthPermission.OrdersRead))
    throw new ForbiddenException("没有订单读取权限");
}

type Row = {
  orderedAt: Date;
  totalAmount: { toString(): string };
  store: { id: string; name: string; platform: string } | null;
  items: {
    quantity: number;
    lineAmount: { toString(): string };
    sku: { product: { id: string; name: string } };
  }[];
};
type Bucket = { key: string; label: string; cents: number; units: number; orders: number };
const platforms: Record<string, string> = {
  OFFLINE: "实体门店",
  TAOBAO: "淘宝",
  DOUYIN: "抖音",
  XIAOHONGSHU: "小红书",
};

function aggregate(rows: readonly Row[], query: DashboardInsightQuery) {
  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    const productScoped =
      query.groupBy === "product" || query.filters.some((filter) => filter.field === "product");
    if (!productScoped) {
      // Order totals include order-level discounts; item sums are only product attribution.
      const [key, label] = group(row, null, query.groupBy);
      addBucket(
        buckets,
        key,
        label,
        cents(row.totalAmount.toString()),
        row.items.reduce((sum, item) => sum + item.quantity, 0),
        1,
      );
      continue;
    }
    addProductBuckets(buckets, row, query);
  }
  return [...buckets.values()].map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    value:
      query.metric === "orderCount"
        ? bucket.orders
        : query.metric === "unitsSold"
          ? bucket.units
          : query.metric === "averageOrderValue"
            ? Math.round(bucket.cents / bucket.orders)
            : bucket.cents,
  }));
}

function addProductBuckets(buckets: Map<string, Bucket>, row: Row, query: DashboardInsightQuery) {
  const items = row.items.filter((item) =>
    query.filters
      .filter((filter) => filter.field === "product")
      .every((filter) => filter.values.includes(item.sku.product.id)),
  );
  const seen = new Set<string>();
  for (const item of items) {
    const [key, label] = group(row, item, query.groupBy);
    addBucket(
      buckets,
      key,
      label,
      cents(item.lineAmount.toString()),
      item.quantity,
      seen.has(key) ? 0 : 1,
    );
    seen.add(key);
  }
}

function addBucket(
  buckets: Map<string, Bucket>,
  key: string,
  label: string,
  amount: number,
  units: number,
  orders: number,
) {
  const bucket = buckets.get(key) ?? { key, label, cents: 0, units: 0, orders: 0 };
  bucket.cents += amount;
  if (!Number.isSafeInteger(bucket.cents)) throw new BadRequestException("金额超出安全计算范围");
  bucket.units += units;
  bucket.orders += orders;
  buckets.set(key, bucket);
}

function group(
  row: Row,
  item: Row["items"][number] | null,
  dimension: DashboardInsightQuery["groupBy"],
): [string, string] {
  if (dimension === "product" && item) return [item.sku.product.id, item.sku.product.name];
  if (dimension === "platform") {
    const key = row.store?.platform ?? "unassigned";
    return [key, platforms[key] ?? "未分配渠道"];
  }
  if (dimension === "date") {
    const date = new Date(row.orderedAt.getTime() + 28800000).toISOString().slice(0, 10);
    return [date, date];
  }
  if (dimension === "store")
    return [row.store?.id ?? "unassigned", row.store?.name ?? "未分配门店"];
  return ["total", "合计"];
}

function cents(value: string) {
  const [whole, decimal = ""] = value.split(".");
  return Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
}

import "dotenv/config";
import { createAnalyticsDemo } from "./analytics-demo-data.js";
import { getPrismaClient, disconnectPrismaClient } from "./index.js";
import type { Prisma } from "../generated/prisma/client.js";

async function main() {
  const asOf = process.argv.find((arg) => arg.startsWith("--as-of="))?.slice(8) ?? "";
  const data = createAnalyticsDemo(asOf);
  if (!process.argv.includes("--apply")) {
    printPreview(asOf, data);
    return;
  }
  // A separate operator opt-in prevents accidentally seeding a production URL.
  if (process.env.DEMO_DATABASE_WRITE !== "isolated-demo-only")
    throw new Error("先确认独立演示数据库并设置 DEMO_DATABASE_WRITE=isolated-demo-only");
  const prisma = getPrismaClient();
  await prisma.$transaction(
    async (tx) => {
      for (const tenant of data) await writeTenant(tx, tenant);
    },
    { timeout: 180000 },
  );
  process.stdout.write("演示数据导入完成：2 个商家、12 个网点、6000 笔订单。\n");
}

type Transaction = Prisma.TransactionClient;
type Tenant = ReturnType<typeof createAnalyticsDemo>[number];

function printPreview(asOf: string, data: Tenant[]) {
  process.stdout.write(
    JSON.stringify(
      {
        dryRun: true,
        asOf,
        merchants: data.map((tenant) => ({
          id: tenant.id,
          stores: tenant.stores.length,
          products: tenant.products.length,
          orders: tenant.orders.length,
        })),
      },
      null,
      2,
    ) + "\n",
  );
}

async function writeTenant(
  tx: Transaction,
  tenant: ReturnType<typeof createAnalyticsDemo>[number],
) {
  await checkNamespace(tx, tenant);
  const merchant = { id: tenant.id, name: tenant.name, slug: tenant.slug };
  await tx.merchant.upsert({ where: { id: tenant.id }, create: merchant, update: {} });
  await writeCatalog(tx, tenant);
  await writeOrders(tx, tenant);
}

async function checkNamespace(tx: Transaction, tenant: Tenant) {
  const existing = await tx.merchant.findUnique({ where: { id: tenant.id } });
  if (existing && (existing.slug !== tenant.slug || existing.name !== tenant.name))
    throw new Error("演示 ID 已被其他商家占用，停止导入");
  const collisions = await Promise.all([
    tx.product.count({
      where: { id: { in: tenant.products.map((item) => item.id) }, merchantId: { not: tenant.id } },
    }),
    tx.sku.count({
      where: { id: { in: tenant.skus.map((item) => item.id) }, merchantId: { not: tenant.id } },
    }),
    tx.order.count({
      where: { id: { in: tenant.orders.map((item) => item.id) }, merchantId: { not: tenant.id } },
    }),
    tx.orderItem.count({
      where: {
        id: { in: tenant.orders.flatMap((order) => order.items.map((item) => item.id)) },
        order: { merchantId: { not: tenant.id } },
      },
    }),
  ]);
  if (collisions.some(Boolean)) throw new Error("演示记录 ID 冲突，停止导入");
}

async function writeCatalog(tx: Transaction, tenant: Tenant) {
  for (const store of tenant.stores) {
    const value = { ...store, merchantId: tenant.id };
    await tx.store.upsert({
      where: { merchantId_id: { merchantId: tenant.id, id: store.id } },
      create: value,
      update: value,
    });
  }
  for (const product of tenant.products) {
    const value = {
      id: product.id,
      merchantId: tenant.id,
      name: product.name,
      price: money(product.priceCents),
      description: "合成演示商品，不代表平台真实交易",
    };
    await tx.product.upsert({ where: { id: product.id }, create: value, update: value });
  }
  for (const sku of tenant.skus) {
    const { costCents, ...fields } = sku;
    const value = { ...fields, merchantId: tenant.id, cost: money(costCents) };
    await tx.sku.upsert({ where: { id: sku.id }, create: value, update: value });
  }
}

async function writeOrders(tx: Transaction, tenant: Tenant) {
  for (const order of tenant.orders) {
    const { items, totalCents, ...fields } = order;
    const value = {
      ...fields,
      merchantId: tenant.id,
      orderedAt: new Date(order.orderedAt),
      totalAmount: money(totalCents),
    };
    await tx.order.upsert({ where: { id: order.id }, create: value, update: value });
    for (const item of items) {
      const { unitCents, ...itemFields } = item;
      const itemValue = {
        ...itemFields,
        orderId: order.id,
        unitPrice: money(unitCents),
        lineAmount: money(unitCents * item.quantity),
      };
      await tx.orderItem.upsert({ where: { id: item.id }, create: itemValue, update: itemValue });
    }
  }
}

const money = (cents: number) => (cents / 100).toFixed(2);
try {
  await main();
} catch (error) {
  process.stderr.write(
    `演示数据导入失败：${error instanceof Error ? error.message : "未知错误"}\n`,
  );
  process.exitCode = 1;
} finally {
  await disconnectPrismaClient();
}

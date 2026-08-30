import "dotenv/config";

import { disconnectPrismaClient, getPrismaClient } from "./index.js";
import { calculateEffectiveSales, demoOrders } from "./order-seed-data.js";
import { demoMerchant } from "./seed-data.js";

async function seedOrders(): Promise<void> {
  const prisma = getPrismaClient();

  const merchant = await prisma.merchant.findUnique({
    where: {
      slug: demoMerchant.slug,
    },
  });

  if (!merchant) {
    throw new Error("Demo merchant does not exist. Run the product seed first.");
  }

  for (const demoOrder of demoOrders) {
    const order = await prisma.order.upsert({
      where: {
        merchantId_orderNo: {
          merchantId: merchant.id,
          orderNo: demoOrder.orderNo,
        },
      },
      update: {
        orderedAt: new Date(demoOrder.orderedAt),
        status: demoOrder.status,
        totalAmount: demoOrder.totalAmount,
      },
      create: {
        id: demoOrder.id,
        merchantId: merchant.id,
        orderNo: demoOrder.orderNo,
        orderedAt: new Date(demoOrder.orderedAt),
        status: demoOrder.status,
        totalAmount: demoOrder.totalAmount,
      },
    });

    await prisma.orderItem.deleteMany({
      where: {
        orderId: order.id,
      },
    });

    await prisma.orderItem.createMany({
      data: demoOrder.items.map((item) => ({
        id: item.id,
        orderId: order.id,
        skuId: item.skuId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        lineAmount: item.lineAmount,
      })),
    });
  }

  const orderCount = await prisma.order.count({
    where: {
      merchantId: merchant.id,
      orderNo: {
        startsWith: "DEMO-ORDER-202608",
      },
    },
  });

  const itemCount = await prisma.orderItem.count({
    where: {
      order: {
        merchantId: merchant.id,
        orderNo: {
          startsWith: "DEMO-ORDER-202608",
        },
      },
    },
  });

  process.stdout.write(
    `Order seed completed: ${orderCount} orders, ${itemCount} items, effective sales ${calculateEffectiveSales(
      demoOrders,
    )} CNY.\n`,
  );
}

try {
  await seedOrders();
} catch (error) {
  process.stderr.write(
    `Order seed failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );

  process.exitCode = 1;
} finally {
  await disconnectPrismaClient();
}

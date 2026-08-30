import "dotenv/config";

import {
  disconnectPrismaClient,
  getPrismaClient,
} from "./index.js";
import {
  demoMerchant,
  demoProducts,
} from "./seed-data.js";

async function seed(): Promise<void> {
  const prisma = getPrismaClient();

  const merchant = await prisma.merchant.upsert({
    where: {
      slug: demoMerchant.slug,
    },
    update: {
      name: demoMerchant.name,
      status: "ACTIVE",
    },
    create: {
      id: demoMerchant.id,
      name: demoMerchant.name,
      slug: demoMerchant.slug,
      status: "ACTIVE",
    },
  });

  for (const item of demoProducts) {
    const product = await prisma.product.upsert({
      where: {
        id: item.id,
      },
      update: {
        merchantId: merchant.id,
        name: item.name,
        description: item.description,
        features: [...item.features],
        sellingPoints: [...item.sellingPoints],
        price: item.price,
        currency: "CNY",
        status: "ACTIVE",
      },
      create: {
        id: item.id,
        merchantId: merchant.id,
        name: item.name,
        description: item.description,
        features: [...item.features],
        sellingPoints: [...item.sellingPoints],
        price: item.price,
        currency: "CNY",
        status: "ACTIVE",
      },
    });

    await prisma.sku.upsert({
      where: {
        merchantId_code: {
          merchantId: merchant.id,
          code: item.sku.code,
        },
      },
      update: {
        productId: product.id,
        cost: item.sku.cost,
        inventory: item.sku.inventory,
        alertThreshold: item.sku.alertThreshold,
      },
      create: {
        id: item.sku.id,
        merchantId: merchant.id,
        productId: product.id,
        code: item.sku.code,
        cost: item.sku.cost,
        inventory: item.sku.inventory,
        alertThreshold: item.sku.alertThreshold,
      },
    });
  }

  const productCount = await prisma.product.count({
    where: {
      merchantId: merchant.id,
      id: {
        in: demoProducts.map((item) => item.id),
      },
    },
  });

  const skuCount = await prisma.sku.count({
    where: {
      merchantId: merchant.id,
      code: {
        in: demoProducts.map((item) => item.sku.code),
      },
    },
  });

  const lowStockCount = await prisma.sku.count({
    where: {
      merchantId: merchant.id,
      code: {
        in: demoProducts.map((item) => item.sku.code),
      },
      OR: demoProducts
        .filter(
          (item) =>
            item.sku.inventory <= item.sku.alertThreshold,
        )
        .map((item) => ({
          code: item.sku.code,
        })),
    },
  });

  process.stdout.write(
    `Seed completed: ${productCount} products, ${skuCount} SKUs, ${lowStockCount} low-stock SKUs.\n`,
  );
}

try {
  await seed();
} catch (error) {
  process.stderr.write(
    `Seed failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
} finally {
  await disconnectPrismaClient();
}

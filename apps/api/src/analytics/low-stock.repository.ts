import { Injectable } from "@nestjs/common";
import { getPrismaClient } from "@shopmate/database";

import type { AuthContext } from "../auth/contracts/index.js";

export const LOW_STOCK_REPOSITORY = Symbol("LOW_STOCK_REPOSITORY");

export interface InventorySkuRecord {
  readonly id: string;
  readonly merchantId: string;
  readonly productId: string;
  readonly productName: string;
  readonly code: string;
  readonly inventory: number;
  readonly alertThreshold: number;
}

export interface LowStockRepository {
  listMerchantSkus(context: AuthContext): Promise<readonly InventorySkuRecord[]>;
}

@Injectable()
export class PrismaLowStockRepository implements LowStockRepository {
  async listMerchantSkus(context: AuthContext): Promise<readonly InventorySkuRecord[]> {
    const rows = await getPrismaClient().sku.findMany({
      where: {
        merchantId: context.merchantId,
      },
      select: {
        id: true,
        merchantId: true,
        productId: true,
        code: true,
        inventory: true,
        alertThreshold: true,
        product: {
          select: {
            name: true,
          },
        },
      },
      orderBy: {
        code: "asc",
      },
    });

    return rows.map((row) => ({
      id: row.id,
      merchantId: row.merchantId,
      productId: row.productId,
      productName: row.product.name,
      code: row.code,
      inventory: row.inventory,
      alertThreshold: row.alertThreshold,
    }));
  }
}

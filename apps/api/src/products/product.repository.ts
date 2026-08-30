import { getPrismaClient } from "@shopmate/database";
import type { ProductListQuery, ProductStatus } from "@shopmate/contracts";

import type { AuthContext } from "../auth/contracts/index.js";

export const PRODUCT_REPOSITORY = Symbol("PRODUCT_REPOSITORY");

export interface ProductSkuRecord {
  readonly id: string;
  readonly code: string;
  readonly inventory: number;
  readonly cost: string;
  readonly alertThreshold: number;
}

export interface ProductRecord {
  readonly id: string;
  readonly merchantId: string;
  readonly name: string;
  readonly description: string | null;
  readonly features: unknown;
  readonly sellingPoints: unknown;
  readonly price: string;
  readonly currency: string;
  readonly status: ProductStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly skus: readonly ProductSkuRecord[];
}

export interface ProductPage {
  readonly rows: readonly ProductRecord[];
  readonly total: number;
}

export interface ProductRepository {
  list(context: AuthContext, query: ProductListQuery): Promise<ProductPage>;
  findById(context: AuthContext, productId: string): Promise<ProductRecord | null>;
}

export class PrismaProductRepository implements ProductRepository {
  async list(context: AuthContext, query: ProductListQuery): Promise<ProductPage> {
    const prisma = getPrismaClient();
    const where = {
      merchantId: context.merchantId,
      ...(query.status === "ALL" ? {} : { status: query.status }),
    };
    const [rows, total] = await Promise.all([
      prisma.product.findMany({
        where,
        include: { skus: { where: { merchantId: context.merchantId } } },
        orderBy: { updatedAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.product.count({ where }),
    ]);
    return { rows: rows.map(toProductRecord), total };
  }

  async findById(context: AuthContext, productId: string): Promise<ProductRecord | null> {
    const row = await getPrismaClient().product.findFirst({
      where: { id: productId, merchantId: context.merchantId },
      include: { skus: { where: { merchantId: context.merchantId } } },
    });
    return row ? toProductRecord(row) : null;
  }
}

function toProductRecord(row: {
  readonly id: string;
  readonly merchantId: string;
  readonly name: string;
  readonly description: string | null;
  readonly features: unknown;
  readonly sellingPoints: unknown;
  readonly price: { toString(): string };
  readonly currency: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly skus: readonly {
    readonly id: string;
    readonly code: string;
    readonly inventory: number;
    readonly cost: { toString(): string };
    readonly alertThreshold: number;
  }[];
}): ProductRecord {
  return {
    id: row.id,
    merchantId: row.merchantId,
    name: row.name,
    description: row.description,
    features: row.features,
    sellingPoints: row.sellingPoints,
    price: row.price.toString(),
    currency: row.currency,
    status: row.status as ProductStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    skus: row.skus.map((sku) => ({
      id: sku.id,
      code: sku.code,
      inventory: sku.inventory,
      cost: sku.cost.toString(),
      alertThreshold: sku.alertThreshold,
    })),
  };
}

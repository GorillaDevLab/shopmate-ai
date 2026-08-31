import { Injectable } from "@nestjs/common";
import { getPrismaClient } from "@shopmate/database";

import type { AuthContext } from "../auth/contracts/index.js";

export const SALES_QUERY_REPOSITORY = Symbol("SALES_QUERY_REPOSITORY");

export interface SalesDateRange {
  readonly startInclusive: Date;
  readonly endExclusive: Date;
}

export interface SalesOrderItemRecord {
  readonly id: string;
  readonly skuId: string;
  readonly quantity: number;
  readonly unitPrice: string;
  readonly lineAmount: string;
}

export interface SalesOrderRecord {
  readonly id: string;
  readonly merchantId: string;
  readonly orderNo: string;
  readonly orderedAt: Date;
  readonly status: string;
  readonly totalAmount: string;
  readonly items: readonly SalesOrderItemRecord[];
}

export interface SalesQueryRepository {
  listEffectiveOrders(
    context: AuthContext,
    range: SalesDateRange,
  ): Promise<readonly SalesOrderRecord[]>;
}

@Injectable()
export class PrismaSalesQueryRepository implements SalesQueryRepository {
  async listEffectiveOrders(
    context: AuthContext,
    range: SalesDateRange,
  ): Promise<readonly SalesOrderRecord[]> {
    const rows = await getPrismaClient().order.findMany({
      where: {
        merchantId: context.merchantId,
        status: {
          not: "CANCELLED",
        },
        orderedAt: {
          gte: range.startInclusive,
          lt: range.endExclusive,
        },
      },
      include: {
        items: true,
      },
      orderBy: [
        {
          orderedAt: "asc",
        },
        {
          orderNo: "asc",
        },
      ],
    });

    return rows.map(toSalesOrderRecord);
  }
}

function toSalesOrderRecord(row: {
  readonly id: string;
  readonly merchantId: string;
  readonly orderNo: string;
  readonly orderedAt: Date;
  readonly status: string;
  readonly totalAmount: {
    toString(): string;
  };
  readonly items: readonly {
    readonly id: string;
    readonly skuId: string;
    readonly quantity: number;
    readonly unitPrice: {
      toString(): string;
    };
    readonly lineAmount: {
      toString(): string;
    };
  }[];
}): SalesOrderRecord {
  return {
    id: row.id,
    merchantId: row.merchantId,
    orderNo: row.orderNo,
    orderedAt: row.orderedAt,
    status: row.status,
    totalAmount: row.totalAmount.toString(),
    items: row.items.map((item) => ({
      id: item.id,
      skuId: item.skuId,
      quantity: item.quantity,
      unitPrice: item.unitPrice.toString(),
      lineAmount: item.lineAmount.toString(),
    })),
  };
}

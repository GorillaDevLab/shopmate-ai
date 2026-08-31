import { Inject, Injectable } from "@nestjs/common";

import type { AuthContext } from "../auth/contracts/index.js";
import { LOW_STOCK_REPOSITORY, type LowStockRepository } from "./low-stock.repository.js";
import {
  calculateTrend,
  formatCents,
  parseMoneyToCents,
  rankProductPerformance,
  type TrendResult,
} from "./metric-rules.js";
import { SalesQueryService } from "./sales-query.service.js";

const PERFORMANCE_WINDOW_DAYS = 7;
const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

export type LowPerformanceReason = "NO_SALES" | "DECLINED_AT_LEAST_30_PERCENT";

export interface ProductPerformanceRecord {
  readonly productId: string;
  readonly productName: string;
  readonly skuCodes: readonly string[];

  readonly unitsSold: number;
  readonly revenueCents: number;
  readonly revenue: string;

  readonly previousUnitsSold: number | null;
  readonly previousRevenueCents: number | null;
  readonly previousRevenue: string | null;

  readonly salesRank: number;
  readonly revenueRank: number;
  readonly isHotSeller: boolean;

  readonly unitTrend: TrendResult;
  readonly revenueTrend: TrendResult;

  readonly performance: "LOW" | "NORMAL";
  readonly lowPerformanceReasons: readonly LowPerformanceReason[];
}

export interface ProductPerformanceResult {
  readonly currentWindow: {
    readonly startDate: string;
    readonly endDate: string;
    readonly days: number;
  };

  readonly previousWindow: {
    readonly startDate: string;
    readonly endDate: string;
    readonly days: number;
  };

  readonly products: readonly ProductPerformanceRecord[];
  readonly hotSellers: readonly ProductPerformanceRecord[];
  readonly risingProducts: readonly ProductPerformanceRecord[];
  readonly decliningProducts: readonly ProductPerformanceRecord[];
  readonly lowPerformers: readonly ProductPerformanceRecord[];
}

interface ProductAggregate {
  unitsSold: number;
  revenueCents: number;
}

@Injectable()
export class ProductPerformanceService {
  constructor(
    @Inject(LOW_STOCK_REPOSITORY)
    private readonly repository: LowStockRepository,
    @Inject(SalesQueryService)
    private readonly salesQueryService: Pick<SalesQueryService, "listEffectiveOrders">,
  ) {}

  async analyze(context: AuthContext, asOfDate: string): Promise<ProductPerformanceResult> {
    assertValidDate(asOfDate);

    const currentStart = subtractCalendarDays(asOfDate, PERFORMANCE_WINDOW_DAYS - 1);

    const previousEnd = subtractCalendarDays(currentStart, 1);

    const previousStart = subtractCalendarDays(previousEnd, PERFORMANCE_WINDOW_DAYS - 1);

    const [skus, orders] = await Promise.all([
      this.repository.listMerchantSkus(context),
      this.salesQueryService.listEffectiveOrders(context, {
        startDate: previousStart,
        endDate: asOfDate,
      }),
    ]);

    const skuToProduct = new Map<string, string>();
    const productNames = new Map<string, string>();
    const skuCodesByProduct = new Map<string, string[]>();

    for (const sku of skus) {
      skuToProduct.set(sku.id, sku.productId);

      if (!productNames.has(sku.productId)) {
        productNames.set(sku.productId, sku.productName);
      }

      const codes = skuCodesByProduct.get(sku.productId) ?? [];
      codes.push(sku.code);
      skuCodesByProduct.set(sku.productId, codes);
    }

    const currentAggregates = new Map<string, ProductAggregate>();

    const previousAggregates = new Map<string, ProductAggregate>();

    let previousPeriodHasOrders = false;

    for (const order of orders) {
      const orderDate = toShanghaiDateKey(order.orderedAt);

      const isCurrent = orderDate >= currentStart && orderDate <= asOfDate;

      const isPrevious = orderDate >= previousStart && orderDate <= previousEnd;

      if (isPrevious) {
        previousPeriodHasOrders = true;
      }

      if (!isCurrent && !isPrevious) {
        continue;
      }

      const target = isCurrent ? currentAggregates : previousAggregates;

      for (const item of order.items) {
        const productId = skuToProduct.get(item.skuId);

        if (!productId) {
          continue;
        }

        const aggregate = target.get(productId) ?? {
          unitsSold: 0,
          revenueCents: 0,
        };

        aggregate.unitsSold += item.quantity;
        aggregate.revenueCents += parseMoneyToCents(item.lineAmount);

        target.set(productId, aggregate);
      }
    }

    const performanceInputs = Array.from(productNames.keys()).map((productId) => {
      const current = currentAggregates.get(productId) ?? {
        unitsSold: 0,
        revenueCents: 0,
      };

      const previous = previousAggregates.get(productId) ?? {
        unitsSold: 0,
        revenueCents: 0,
      };

      return {
        productId,
        unitsSold: current.unitsSold,
        revenueCents: current.revenueCents,
        previousUnitsSold: previousPeriodHasOrders ? previous.unitsSold : null,
      };
    });

    const ranked = rankProductPerformance(performanceInputs);

    const revenueRanking = [...ranked].sort((left, right) => {
      if (left.revenueCents !== right.revenueCents) {
        return right.revenueCents - left.revenueCents;
      }

      if (left.unitsSold !== right.unitsSold) {
        return right.unitsSold - left.unitsSold;
      }

      return left.productId.localeCompare(right.productId);
    });

    const revenueRankByProduct = new Map<string, number>();

    revenueRanking.forEach((product, index) => {
      revenueRankByProduct.set(product.productId, index + 1);
    });

    const products = ranked.map((product): ProductPerformanceRecord => {
      const previous = previousAggregates.get(product.productId) ?? {
        unitsSold: 0,
        revenueCents: 0,
      };

      const previousRevenueCents = previousPeriodHasOrders ? previous.revenueCents : null;

      const revenueTrend = calculateTrend(product.revenueCents, previousRevenueCents);

      const reasons: LowPerformanceReason[] = [];

      if (product.unitsSold === 0) {
        reasons.push("NO_SALES");
      }

      if (
        product.trend.direction === "DOWN" &&
        product.trend.changePercent !== null &&
        product.trend.changePercent <= -30
      ) {
        reasons.push("DECLINED_AT_LEAST_30_PERCENT");
      }

      return {
        productId: product.productId,
        productName: productNames.get(product.productId) ?? product.productId,
        skuCodes: [...(skuCodesByProduct.get(product.productId) ?? [])].sort(),

        unitsSold: product.unitsSold,
        revenueCents: product.revenueCents,
        revenue: formatCents(product.revenueCents),

        previousUnitsSold: product.previousUnitsSold,
        previousRevenueCents,
        previousRevenue: previousRevenueCents === null ? null : formatCents(previousRevenueCents),

        salesRank: product.rank,
        revenueRank: revenueRankByProduct.get(product.productId) ?? 0,

        isHotSeller: product.isHotSeller,

        unitTrend: product.trend,
        revenueTrend,

        performance: product.performance,

        lowPerformanceReasons: reasons,
      };
    });

    return {
      currentWindow: {
        startDate: currentStart,
        endDate: asOfDate,
        days: PERFORMANCE_WINDOW_DAYS,
      },

      previousWindow: {
        startDate: previousStart,
        endDate: previousEnd,
        days: PERFORMANCE_WINDOW_DAYS,
      },

      products,

      hotSellers: products.filter((product) => product.isHotSeller),

      risingProducts: products.filter((product) => product.unitTrend.direction === "UP"),

      decliningProducts: products.filter((product) => product.unitTrend.direction === "DOWN"),

      lowPerformers: products.filter((product) => product.performance === "LOW"),
    };
  }
}

function toShanghaiDateKey(date: Date): string {
  return new Date(date.getTime() + SHANGHAI_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

function subtractCalendarDays(date: string, days: number): string {
  const parsed = parseDateOnly(date);

  return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day - days))
    .toISOString()
    .slice(0, 10);
}

function assertValidDate(value: string): void {
  parseDateOnly(value);
}

function parseDateOnly(value: string): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
} {
  const match = DATE_PATTERN.exec(value);

  if (!match) {
    throw new RangeError("date must use YYYY-MM-DD format");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const timestamp = Date.UTC(year, month - 1, day);

  const parsed = new Date(timestamp);

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new RangeError("date is not a valid calendar date");
  }

  return {
    year,
    month,
    day,
  };
}

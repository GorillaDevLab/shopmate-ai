import { Inject, Injectable } from "@nestjs/common";

import type { AuthContext } from "../auth/contracts/index.js";
import { calculateInventoryRisk, type InventoryRiskLevel } from "./metric-rules.js";
import { LOW_STOCK_REPOSITORY, type LowStockRepository } from "./low-stock.repository.js";
import { SalesQueryService } from "./sales-query.service.js";

const SALES_WINDOW_DAYS = 7;

export interface LowStockRiskRecord {
  readonly skuId: string;
  readonly productId: string;
  readonly productName: string;
  readonly code: string;
  readonly inventory: number;
  readonly alertThreshold: number;
  readonly soldUnits7d: number;
  readonly averageDailyUnits: number;
  readonly daysToStockout: number | null;
  readonly level: InventoryRiskLevel;
}

export interface LowStockAnalysisResult {
  readonly window: {
    readonly startDate: string;
    readonly endDate: string;
    readonly days: number;
  };
  readonly risks: readonly LowStockRiskRecord[];
}

@Injectable()
export class LowStockService {
  constructor(
    @Inject(LOW_STOCK_REPOSITORY)
    private readonly repository: LowStockRepository,
    @Inject(SalesQueryService)
    private readonly salesQueryService: Pick<SalesQueryService, "listEffectiveOrders">,
  ) {}

  async analyze(context: AuthContext, asOfDate: string): Promise<LowStockAnalysisResult> {
    const startDate = subtractCalendarDays(asOfDate, SALES_WINDOW_DAYS - 1);

    const [skus, orders] = await Promise.all([
      this.repository.listMerchantSkus(context),
      this.salesQueryService.listEffectiveOrders(context, {
        startDate,
        endDate: asOfDate,
      }),
    ]);

    const soldUnitsBySku = new Map<string, number>();

    for (const order of orders) {
      for (const item of order.items) {
        soldUnitsBySku.set(item.skuId, (soldUnitsBySku.get(item.skuId) ?? 0) + item.quantity);
      }
    }

    const risks = skus
      .map((sku) => {
        const soldUnits7d = soldUnitsBySku.get(sku.id) ?? 0;

        const risk = calculateInventoryRisk({
          inventory: sku.inventory,
          alertThreshold: sku.alertThreshold,
          soldUnits7d,
        });

        return {
          skuId: sku.id,
          productId: sku.productId,
          productName: sku.productName,
          code: sku.code,
          inventory: sku.inventory,
          alertThreshold: sku.alertThreshold,
          soldUnits7d,
          averageDailyUnits: risk.averageDailyUnits,
          daysToStockout: risk.daysToStockout,
          level: risk.level,
        } satisfies LowStockRiskRecord;
      })
      .filter((risk) => risk.level !== "NORMAL")
      .sort(compareRisk);

    return {
      window: {
        startDate,
        endDate: asOfDate,
        days: SALES_WINDOW_DAYS,
      },
      risks,
    };
  }
}

const RISK_PRIORITY: Record<InventoryRiskLevel, number> = {
  OUT_OF_STOCK: 0,
  CRITICAL: 1,
  WARNING: 2,
  NORMAL: 3,
};

function compareRisk(left: LowStockRiskRecord, right: LowStockRiskRecord): number {
  const priorityDifference = RISK_PRIORITY[left.level] - RISK_PRIORITY[right.level];

  if (priorityDifference !== 0) {
    return priorityDifference;
  }

  const leftDays = left.daysToStockout ?? Number.POSITIVE_INFINITY;

  const rightDays = right.daysToStockout ?? Number.POSITIVE_INFINITY;

  if (leftDays !== rightDays) {
    return leftDays - rightDays;
  }

  if (left.inventory !== right.inventory) {
    return left.inventory - right.inventory;
  }

  return left.code.localeCompare(right.code);
}

function subtractCalendarDays(date: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new RangeError("date must use YYYY-MM-DD format");
  }

  const parsed = new Date(`${date}T00:00:00.000Z`);

  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError("date is invalid");
  }

  parsed.setUTCDate(parsed.getUTCDate() - days);

  return parsed.toISOString().slice(0, 10);
}

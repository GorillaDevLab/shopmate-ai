export const ANALYTICS_RULES = {
  salesWindowDays: 7,
  criticalStockoutDays: 3,
  warningStockoutDays: 7,
  hotSellerLimit: 3,
  lowPerformanceDeclinePercent: -30,
} as const;

export type InventoryRiskLevel = "OUT_OF_STOCK" | "CRITICAL" | "WARNING" | "NORMAL";

export interface InventoryRiskInput {
  readonly inventory: number;
  readonly alertThreshold: number;
  readonly soldUnits7d: number;
}

export interface InventoryRiskResult {
  readonly input: InventoryRiskInput;
  readonly averageDailyUnits: number;
  readonly daysToStockout: number | null;
  readonly level: InventoryRiskLevel;
}

export type TrendDirection = "UP" | "DOWN" | "FLAT" | "NEW" | "NO_HISTORY";

export interface TrendResult {
  readonly current: number;
  readonly previous: number | null;
  readonly direction: TrendDirection;
  readonly changePercent: number | null;
}

export interface EffectiveSalesOrderInput {
  readonly totalAmount: string;
  readonly items: readonly {
    readonly quantity: number;
  }[];
}

export interface SalesMetrics {
  readonly revenueCents: number;
  readonly revenue: string;
  readonly orderCount: number;
  readonly unitsSold: number;
  readonly averageOrderValueCents: number;
  readonly averageOrderValue: string;
}

export interface ProductPerformanceInput {
  readonly productId: string;
  readonly unitsSold: number;
  readonly revenueCents: number;
  readonly previousUnitsSold: number | null;
}

export type ProductPerformanceLevel = "LOW" | "NORMAL";

export interface RankedProductPerformance extends ProductPerformanceInput {
  readonly rank: number;
  readonly isHotSeller: boolean;
  readonly trend: TrendResult;
  readonly performance: ProductPerformanceLevel;
}

const MONEY_PATTERN = /^\d+(?:\.\d{1,2})?$/u;

export function calculateInventoryRisk(
  input: InventoryRiskInput,
  windowDays: number = ANALYTICS_RULES.salesWindowDays,
): InventoryRiskResult {
  if (!Number.isInteger(windowDays) || windowDays < 1) {
    throw new RangeError("inventory sales window must be a positive integer");
  }
  assertNonNegativeInteger(input.inventory, "inventory");
  assertNonNegativeInteger(input.alertThreshold, "alertThreshold");
  assertNonNegativeInteger(input.soldUnits7d, "soldUnits7d");

  const averageDailyUnits = roundTo(input.soldUnits7d / windowDays, 2);

  let daysToStockout: number | null;

  if (input.inventory === 0) {
    daysToStockout = 0;
  } else if (input.soldUnits7d === 0) {
    daysToStockout = null;
  } else {
    daysToStockout = Math.max(0.1, roundTo((input.inventory * windowDays) / input.soldUnits7d, 1));
  }

  let level: InventoryRiskLevel;

  if (input.inventory === 0) {
    level = "OUT_OF_STOCK";
  } else if (daysToStockout !== null && daysToStockout <= ANALYTICS_RULES.criticalStockoutDays) {
    level = "CRITICAL";
  } else if (
    (daysToStockout !== null && daysToStockout <= ANALYTICS_RULES.warningStockoutDays) ||
    input.inventory <= input.alertThreshold
  ) {
    level = "WARNING";
  } else {
    level = "NORMAL";
  }

  return {
    input: { ...input },
    averageDailyUnits,
    daysToStockout,
    level,
  };
}

export function calculateSalesMetrics(orders: readonly EffectiveSalesOrderInput[]): SalesMetrics {
  let revenueCents = 0;
  let unitsSold = 0;

  for (const order of orders) {
    revenueCents += parseMoneyToCents(order.totalAmount);

    for (const item of order.items) {
      assertNonNegativeInteger(item.quantity, "quantity");

      unitsSold += item.quantity;
    }
  }

  const orderCount = orders.length;

  const averageOrderValueCents = orderCount === 0 ? 0 : Math.round(revenueCents / orderCount);

  return {
    revenueCents,
    revenue: formatCents(revenueCents),
    orderCount,
    unitsSold,
    averageOrderValueCents,
    averageOrderValue: formatCents(averageOrderValueCents),
  };
}

export function calculateTrend(current: number, previous: number | null): TrendResult {
  assertNonNegativeNumber(current, "current");

  if (previous === null) {
    return {
      current,
      previous,
      direction: "NO_HISTORY",
      changePercent: null,
    };
  }

  assertNonNegativeNumber(previous, "previous");

  if (previous === 0) {
    if (current === 0) {
      return {
        current,
        previous,
        direction: "FLAT",
        changePercent: 0,
      };
    }

    return {
      current,
      previous,
      direction: "NEW",
      changePercent: null,
    };
  }

  const changePercent = roundTo(((current - previous) / previous) * 100, 1);

  if (current > previous) {
    return {
      current,
      previous,
      direction: "UP",
      changePercent,
    };
  }

  if (current < previous) {
    return {
      current,
      previous,
      direction: "DOWN",
      changePercent,
    };
  }

  return {
    current,
    previous,
    direction: "FLAT",
    changePercent: 0,
  };
}

export function rankProductPerformance(
  products: readonly ProductPerformanceInput[],
): readonly RankedProductPerformance[] {
  const sorted = [...products].sort((left, right) => {
    if (left.unitsSold !== right.unitsSold) {
      return right.unitsSold - left.unitsSold;
    }

    if (left.revenueCents !== right.revenueCents) {
      return right.revenueCents - left.revenueCents;
    }

    return left.productId.localeCompare(right.productId);
  });

  return sorted.map((product, index) => {
    const trend = calculateTrend(product.unitsSold, product.previousUnitsSold);

    const isLowPerformance =
      product.unitsSold === 0 ||
      (trend.direction === "DOWN" &&
        trend.changePercent !== null &&
        trend.changePercent <= ANALYTICS_RULES.lowPerformanceDeclinePercent);

    return {
      ...product,
      rank: index + 1,
      isHotSeller: index < ANALYTICS_RULES.hotSellerLimit,
      trend,
      performance: isLowPerformance ? "LOW" : "NORMAL",
    };
  });
}

export function parseMoneyToCents(value: string): number {
  if (!MONEY_PATTERN.test(value)) {
    throw new RangeError("money must be a non-negative decimal with at most two decimal places");
  }

  const [yuan, decimal = ""] = value.split(".");
  const fraction = decimal.padEnd(2, "0");

  const cents = Number(yuan) * 100 + Number(fraction);

  if (!Number.isSafeInteger(cents)) {
    throw new RangeError("money exceeds the supported integer range");
  }

  return cents;
}

export function formatCents(cents: number): string {
  assertNonNegativeInteger(cents, "cents");

  const yuan = Math.floor(cents / 100);
  const fraction = String(cents % 100).padStart(2, "0");

  return `${yuan}.${fraction}`;
}

function roundTo(value: number, decimalPlaces: number): number {
  const factor = 10 ** decimalPlaces;

  return Math.round(value * factor) / factor;
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative integer`);
  }
}

function assertNonNegativeNumber(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative number`);
  }
}

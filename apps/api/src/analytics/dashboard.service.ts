import { Injectable } from "@nestjs/common";

import type { AuthContext } from "../auth/contracts/index.js";
import {
  calculateSalesMetrics,
  calculateTrend,
  type SalesMetrics,
  type TrendResult,
} from "./metric-rules.js";
import type { SalesOrderRecord } from "./sales-query.repository.js";
import { SalesQueryService } from "./sales-query.service.js";

const RECENT_WINDOW_DAYS = 7;
const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

export interface DailySalesPoint extends SalesMetrics {
  readonly date: string;
}

export interface DashboardMetricChanges {
  readonly revenue: TrendResult;
  readonly orderCount: TrendResult;
  readonly unitsSold: TrendResult;
  readonly averageOrderValue: TrendResult;
}

export interface DashboardSummaryResult {
  readonly asOfDate: string;

  readonly today: SalesMetrics;

  readonly monthToDate: {
    readonly startDate: string;
    readonly endDate: string;
    readonly metrics: SalesMetrics;
  };

  readonly recent: {
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
    readonly metrics: SalesMetrics;
    readonly previousMetrics: SalesMetrics;
    readonly changes: DashboardMetricChanges;
    readonly dailyTrend: readonly DailySalesPoint[];
  };
}

@Injectable()
export class DashboardService {
  constructor(private readonly salesQueryService: SalesQueryService) {}

  async summarize(context: AuthContext, asOfDate: string): Promise<DashboardSummaryResult> {
    const parsedAsOfDate = parseDateOnly(asOfDate);

    const monthStart = formatDateOnly(Date.UTC(parsedAsOfDate.year, parsedAsOfDate.month - 1, 1));

    const currentStart = subtractCalendarDays(asOfDate, RECENT_WINDOW_DAYS - 1);

    const previousEnd = subtractCalendarDays(currentStart, 1);

    const previousStart = subtractCalendarDays(previousEnd, RECENT_WINDOW_DAYS - 1);

    const queryStart = previousStart < monthStart ? previousStart : monthStart;

    const orders = await this.salesQueryService.listEffectiveOrders(context, {
      startDate: queryStart,
      endDate: asOfDate,
    });

    const ordersByDate = groupOrdersByShanghaiDate(orders);

    const today = calculateSalesMetrics(ordersByDate.get(asOfDate) ?? []);

    const monthOrders = orders.filter((order) => {
      const date = toShanghaiDateKey(order.orderedAt);

      return date >= monthStart && date <= asOfDate;
    });

    const currentOrders = orders.filter((order) => {
      const date = toShanghaiDateKey(order.orderedAt);

      return date >= currentStart && date <= asOfDate;
    });

    const previousOrders = orders.filter((order) => {
      const date = toShanghaiDateKey(order.orderedAt);

      return date >= previousStart && date <= previousEnd;
    });

    const monthMetrics = calculateSalesMetrics(monthOrders);

    const currentMetrics = calculateSalesMetrics(currentOrders);

    const previousMetrics = calculateSalesMetrics(previousOrders);

    const dailyTrend = buildDailyTrend(currentStart, asOfDate, ordersByDate);

    return {
      asOfDate,
      today,
      monthToDate: {
        startDate: monthStart,
        endDate: asOfDate,
        metrics: monthMetrics,
      },
      recent: {
        currentWindow: {
          startDate: currentStart,
          endDate: asOfDate,
          days: RECENT_WINDOW_DAYS,
        },
        previousWindow: {
          startDate: previousStart,
          endDate: previousEnd,
          days: RECENT_WINDOW_DAYS,
        },
        metrics: currentMetrics,
        previousMetrics,
        changes: {
          revenue: calculateTrend(currentMetrics.revenueCents, previousMetrics.revenueCents),
          orderCount: calculateTrend(currentMetrics.orderCount, previousMetrics.orderCount),
          unitsSold: calculateTrend(currentMetrics.unitsSold, previousMetrics.unitsSold),
          averageOrderValue: calculateTrend(
            currentMetrics.averageOrderValueCents,
            previousMetrics.averageOrderValueCents,
          ),
        },
        dailyTrend,
      },
    };
  }
}

function buildDailyTrend(
  startDate: string,
  endDate: string,
  ordersByDate: ReadonlyMap<string, readonly SalesOrderRecord[]>,
): readonly DailySalesPoint[] {
  const result: DailySalesPoint[] = [];

  let currentDate = startDate;

  while (currentDate <= endDate) {
    const metrics = calculateSalesMetrics(ordersByDate.get(currentDate) ?? []);

    result.push({
      date: currentDate,
      ...metrics,
    });

    currentDate = addCalendarDays(currentDate, 1);
  }

  return result;
}

function groupOrdersByShanghaiDate(
  orders: readonly SalesOrderRecord[],
): Map<string, SalesOrderRecord[]> {
  const grouped = new Map<string, SalesOrderRecord[]>();

  for (const order of orders) {
    const date = toShanghaiDateKey(order.orderedAt);

    const existing = grouped.get(date);

    if (existing) {
      existing.push(order);
    } else {
      grouped.set(date, [order]);
    }
  }

  return grouped;
}

function toShanghaiDateKey(date: Date): string {
  return new Date(date.getTime() + SHANGHAI_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

function subtractCalendarDays(date: string, days: number): string {
  return addCalendarDays(date, -days);
}

function addCalendarDays(date: string, days: number): string {
  const parsed = parseDateOnly(date);

  return formatDateOnly(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
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

function formatDateOnly(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

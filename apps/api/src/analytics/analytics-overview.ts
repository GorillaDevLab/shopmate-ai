import {
  ANALYTICS_OVERVIEW_MAX_CHANNELS,
  ANALYTICS_OVERVIEW_TOP_PRODUCTS,
  type AnalyticsChannel,
  type AnalyticsOverviewResponse,
  type AnalyticsProduct,
} from "@shopmate/contracts";

import { parseMoneyToCents } from "./metric-rules.js";

const DAY_MS = 86_400_000;
const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
export const UNASSIGNED_CHANNEL_ID = "unassigned";

export interface OverviewWindow {
  readonly startDate: string;
  readonly endDate: string;
  readonly days: number;
}

export interface OverviewOrder {
  readonly orderedAt: Date;
  readonly totalAmount: string;
  readonly store: { readonly id: string; readonly name: string; readonly platform: string } | null;
  readonly items: readonly {
    readonly productId: string;
    readonly productName: string;
    readonly quantity: number;
    readonly lineAmount: string;
  }[];
}

type Totals = { revenueMinor: number; orders: number; units: number };

/** 按上海自然日聚合本期与等长上一周期，口径与经营看板一致（有效订单 = 非取消订单）。 */
export function buildAnalyticsOverview(
  current: OverviewWindow,
  previous: OverviewWindow,
  orders: readonly OverviewOrder[],
): AnalyticsOverviewResponse {
  const state = createState(current, previous);
  for (const order of orders) accumulate(state, order, current.days);
  return {
    period: current,
    comparisonPeriod: previous,
    totals: state.totals,
    daily: state.daily,
    previousDaily: state.previousDaily,
    channels: rankChannels(state.channels),
    products: [...state.products.values()]
      .filter((product) => product.revenueMinor > 0)
      .sort((a, b) => b.revenueMinor - a.revenueMinor || a.productId.localeCompare(b.productId))
      .slice(0, ANALYTICS_OVERVIEW_TOP_PRODUCTS),
  };
}

type OverviewState = ReturnType<typeof createState>;

function createState(current: OverviewWindow, previous: OverviewWindow) {
  const currentDates = dateRange(current);
  const previousDates = dateRange(previous);
  return {
    currentIndex: indexOf(currentDates),
    previousIndex: indexOf(previousDates),
    daily: currentDates.map((date) => ({ date, revenueMinor: 0, orders: 0, units: 0 })),
    previousDaily: previousDates.map((date) => ({ date, revenueMinor: 0 })),
    totals: { current: emptyTotals(), previous: emptyTotals() },
    channels: new Map<string, AnalyticsChannel>(),
    products: new Map<string, AnalyticsProduct>(),
  };
}

function accumulate(state: OverviewState, order: OverviewOrder, days: number) {
  const date = toShanghaiDateKey(order.orderedAt);
  const day = state.currentIndex.get(date);
  const previousDay = state.previousIndex.get(date);
  if (day === undefined && previousDay === undefined) return;
  const revenue = parseMoneyToCents(order.totalAmount);
  const units = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const channel = channelFor(state.channels, order.store, days);
  if (day !== undefined) {
    addTotals(state.totals.current, revenue, units);
    addTotals(state.daily[day], revenue, units);
    addTotals(channel, revenue, units);
    channel.dailyRevenueMinor[day] += revenue;
  } else if (previousDay !== undefined) {
    addTotals(state.totals.previous, revenue, units);
    state.previousDaily[previousDay].revenueMinor += revenue;
    channel.previousRevenueMinor += revenue;
  }
  for (const item of order.items) addProduct(state.products, item, day !== undefined);
}

/** 上一周期 = 紧邻本期之前、天数相同的连续日期。 */
export function previousWindow(current: OverviewWindow): OverviewWindow {
  const end = Date.parse(current.startDate) - DAY_MS;
  return {
    startDate: formatDate(end - (current.days - 1) * DAY_MS),
    endDate: formatDate(end),
    days: current.days,
  };
}

function channelFor(
  channels: Map<string, AnalyticsChannel>,
  store: OverviewOrder["store"],
  days: number,
): AnalyticsChannel {
  const id = store?.id ?? UNASSIGNED_CHANNEL_ID;
  let channel = channels.get(id);
  if (!channel) {
    channel = {
      id,
      name: store?.name ?? "未关联渠道",
      platform: store?.platform ?? null,
      revenueMinor: 0,
      previousRevenueMinor: 0,
      orders: 0,
      units: 0,
      dailyRevenueMinor: new Array<number>(days).fill(0),
    };
    channels.set(id, channel);
  }
  return channel;
}

// 商家尚未接入门店时所有订单都落在"未关联渠道"，这种情况下渠道拆分没有意义，返回空列表。
function rankChannels(channels: Map<string, AnalyticsChannel>): AnalyticsChannel[] {
  const list = [...channels.values()];
  if (list.every((channel) => channel.id === UNASSIGNED_CHANNEL_ID)) return [];
  return list
    .sort((a, b) => b.revenueMinor - a.revenueMinor || a.id.localeCompare(b.id))
    .slice(0, ANALYTICS_OVERVIEW_MAX_CHANNELS);
}

function addProduct(
  products: Map<string, AnalyticsProduct>,
  item: OverviewOrder["items"][number],
  isCurrent: boolean,
) {
  const product = products.get(item.productId) ?? {
    productId: item.productId,
    name: item.productName,
    units: 0,
    revenueMinor: 0,
    previousRevenueMinor: 0,
  };
  const amount = parseMoneyToCents(item.lineAmount);
  if (isCurrent) {
    product.units += item.quantity;
    product.revenueMinor += amount;
  } else {
    product.previousRevenueMinor += amount;
  }
  products.set(item.productId, product);
}

function addTotals(target: Totals, revenue: number, units: number) {
  target.revenueMinor += revenue;
  target.orders += 1;
  target.units += units;
}

function emptyTotals(): Totals {
  return { revenueMinor: 0, orders: 0, units: 0 };
}

function dateRange(window: OverviewWindow): string[] {
  const start = Date.parse(window.startDate);
  return Array.from({ length: window.days }, (_, index) => formatDate(start + index * DAY_MS));
}

function indexOf(dates: readonly string[]): Map<string, number> {
  return new Map(dates.map((date, index) => [date, index]));
}

function toShanghaiDateKey(date: Date): string {
  return formatDate(date.getTime() + SHANGHAI_UTC_OFFSET_MS);
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

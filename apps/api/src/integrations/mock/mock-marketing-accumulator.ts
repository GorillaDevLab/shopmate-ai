import {
  ConnectorCampaignMetricSchema,
  ConnectorTimestampSchema,
  type ConnectorCampaignMetric,
} from "@shopmate/contracts";
import { z } from "zod";
import { DAY_MS, MockConfigSchema, openingTime, type MockConfig } from "./mock-config.js";
import { campaignRow, type CampaignTotal } from "./mock-marketing.js";
import { owned } from "./mock-causal-state.js";
import type { TimelineEvent } from "./mock-history.js";
import type { CausalMutation } from "./mock-causal-reducer.js";
import { dailyDemand } from "./mock-history.js";
export interface MarketingAccumulator {
  apply(event: TimelineEvent, effects: readonly CausalMutation[]): void;
  snapshot(until: unknown): readonly ConnectorCampaignMetric[];
  observe(until: unknown): readonly ConnectorCampaignMetric[];
}
export function createMarketingAccumulator(
  input: unknown,
  initial: unknown = [],
): MarketingAccumulator {
  const config = owned(MockConfigSchema.parse(input));
  const rows = owned(z.array(ConnectorCampaignMetricSchema).max(config.days).parse(initial));
  const totals = hydrateTotals(config, rows);
  return Object.freeze({
    apply: (event: TimelineEvent, effects: readonly CausalMutation[]) =>
      acceptPayment(config, totals, event, effects),
    snapshot: (until: unknown) => snapshot(config, totals, until),
    observe: (until: unknown) => observe(config, totals, until),
  });
}
function observe(
  config: MockConfig,
  totals: ReadonlyMap<string, CampaignTotal>,
  input: unknown,
): readonly ConnectorCampaignMetric[] {
  const timestamp = ConnectorTimestampSchema.parse(input);
  if (new Date(timestamp).toISOString() !== timestamp)
    throw new Error("Canonical UTC timestamp required");
  const start = Date.parse(config.historyStart),
    until = Math.min(Date.parse(timestamp), start + config.days * DAY_MS);
  const current = Math.floor((until - start) / DAY_MS);
  const rows: ConnectorCampaignMetric[] = [];
  // PAY settles within five minutes, so only this day and the previous day can change.
  for (const day of [current - 1, current]) {
    const opened = start + day * DAY_MS;
    if (day < 0 || day >= config.days || opened < openingTime(config) || opened >= until) continue;
    const row = campaignRow(config, day, until, totals);
    if (row.source.updatedAt === timestamp)
      rows.push({ ...row, source: { ...row.source, version: null } });
  }
  return owned(rows);
}
function hydrateTotals(
  config: MockConfig,
  rows: readonly ConnectorCampaignMetric[],
): Map<string, CampaignTotal> {
  const totals = new Map<string, CampaignTotal>();
  for (const row of rows) {
    const [day, total] = hydratedTotal(config, row);
    if (totals.has(row.externalCampaignId)) throw new Error("Duplicate marketing hydration");
    validateHydratedRow(config, day, row, total);
    totals.set(row.externalCampaignId, total);
  }
  return totals;
}
function hydratedTotal(
  config: MockConfig,
  row: ConnectorCampaignMetric,
): readonly [number, CampaignTotal] {
  const day = hydratedDay(config, row);
  const total = {
    orders: row.attributedOrders!,
    revenue: row.attributedRevenueMinor!,
    lastPaymentAt: Date.parse(row.source.updatedAt!),
  };
  if (total.orders > dailyDemand(config, day) || (total.orders === 0) !== (total.revenue === 0))
    throw new Error("Impossible attributed totals");
  return [day, total];
}
function hydratedDay(config: MockConfig, row: ConnectorCampaignMetric): number {
  const day = Number(
    row.externalCampaignId.slice(`${config.binding.externalStoreId}:campaign:`.length),
  );
  const at = row.source.updatedAt;
  if (
    row.externalStoreId !== config.binding.externalStoreId ||
    !Number.isInteger(day) ||
    day < 0 ||
    day >= config.days ||
    row.externalCampaignId !== `${config.binding.externalStoreId}:campaign:${day}` ||
    at === null ||
    new Date(at).toISOString() !== at
  )
    throw new Error("Invalid marketing hydration scope, time or duplicate");
  const values = [
    row.attributedOrders,
    row.attributedRevenueMinor,
    row.spendMinor,
    row.clicks,
    row.impressions,
  ];
  if (values.some((value) => value === null) || row.currency !== "CNY")
    throw new Error("Unknown marketing hydration facts");
  return day;
}
function validateHydratedRow(
  config: MockConfig,
  day: number,
  row: ConnectorCampaignMetric,
  total: CampaignTotal,
): void {
  const at = row.source.updatedAt!;
  const expected = campaignRow(
    config,
    day,
    Date.parse(at),
    new Map([[row.externalCampaignId, total]]),
  );
  if (
    JSON.stringify({ ...row, source: { ...row.source, version: expected.source.version } }) !==
      JSON.stringify(expected) ||
    Date.parse(at) < Date.parse(config.historyStart) + day * DAY_MS ||
    Date.parse(at) > Date.parse(config.historyStart) + (day + 1) * DAY_MS + 300000 ||
    Date.parse(config.historyStart) + day * DAY_MS < openingTime(config)
  )
    throw new Error("Inconsistent marketing hydration");
}
function acceptPayment(
  config: MockConfig,
  totals: Map<string, CampaignTotal>,
  event: TimelineEvent,
  effects: readonly CausalMutation[],
): void {
  if (event.kind !== "PAY" || !event.candidate?.campaignId) return;
  const order = effects.find((effect) => effect.kind === "ORDER");
  if (!order || order.kind !== "ORDER" || order.after.paidMinor === 0) return;
  const id = event.candidate.campaignId;
  const day = Math.floor((event.candidate.at - Date.parse(config.historyStart)) / DAY_MS);
  if (
    id !== `${config.binding.externalStoreId}:campaign:${day}` ||
    day < 0 ||
    day >= config.days ||
    order.after.paidAt !== new Date(event.at).toISOString() ||
    order.after.paidMinor === null
  )
    throw new Error("Invalid attributed payment");
  const prior = totals.get(id) ?? { orders: 0, revenue: 0, lastPaymentAt: 0 };
  totals.set(id, {
    orders: prior.orders + 1,
    revenue: prior.revenue + order.after.paidMinor,
    lastPaymentAt: Math.max(prior.lastPaymentAt, event.at),
  });
}
function snapshot(
  config: MockConfig,
  totals: ReadonlyMap<string, CampaignTotal>,
  input: unknown,
): readonly ConnectorCampaignMetric[] {
  const timestamp = ConnectorTimestampSchema.parse(input);
  if (new Date(timestamp).toISOString() !== timestamp)
    throw new Error("Canonical UTC timestamp required");
  const until = Math.min(
    Date.parse(timestamp),
    Date.parse(config.historyStart) + config.days * DAY_MS,
  );
  const rows: ConnectorCampaignMetric[] = [];
  for (let day = 0; day < config.days; day++) {
    const start = Date.parse(config.historyStart) + day * DAY_MS;
    if (start >= openingTime(config) && start < until) {
      const row = campaignRow(config, day, until, totals);
      rows.push({ ...row, source: { ...row.source, version: null } });
    }
  }
  return owned(rows);
}

import { ConnectorCampaignMetricSchema, type ConnectorCampaignMetric } from "@shopmate/contracts";
import { sourceAt } from "./mock-catalog.js";
import { DAY_MS, openingTime, type MockConfig } from "./mock-config.js";
import type { ReplayState } from "./mock-types.js";
import { campaignPlan } from "./mock-campaign-plan.js";

interface CampaignTotal {
  orders: number;
  revenue: number;
  lastPaymentAt: number;
}

function campaign(
  config: MockConfig,
  day: number,
  until: number,
  totals: ReadonlyMap<string, CampaignTotal>,
): ConnectorCampaignMetric {
  const start = Date.parse(config.historyStart) + day * DAY_MS;
  const end = Math.min(start + DAY_MS, until);
  const id = `${config.binding.externalStoreId}:campaign:${day}`;
  const paid = totals.get(id) ?? { orders: 0, revenue: 0, lastPaymentAt: start };
  const spend = Math.floor((campaignPlan(config, day).spendMinor * (end - start)) / DAY_MS);
  // Bound the observed coarse click counter by already observed conversions.
  const clicks = Math.max(paid.orders, Math.floor(spend / 80));
  return ConnectorCampaignMetricSchema.parse({
    externalStoreId: config.binding.externalStoreId,
    externalCampaignId: id,
    source: sourceAt(new Date(Math.max(end, paid.lastPaymentAt)).toISOString()),
    date: new Date(start + 8 * 3_600_000).toISOString().slice(0, 10),
    impressions: clicks * 30,
    clicks,
    attributedOrders: paid.orders,
    spendMinor: spend,
    attributedRevenueMinor: paid.revenue,
    currency: "CNY",
  });
}

export function generateMarketing(
  config: MockConfig,
  state: ReplayState,
  until: number,
): ConnectorCampaignMetric[] {
  const totals = new Map<string, CampaignTotal>();
  for (const [id, fact] of state.economics) {
    const paid = state.orders.get(id)!.paidMinor!;
    if (!fact.campaignId || paid === 0) continue;
    const previous = totals.get(fact.campaignId) ?? { orders: 0, revenue: 0, lastPaymentAt: 0 };
    totals.set(fact.campaignId, {
      orders: previous.orders + 1,
      revenue: previous.revenue + paid,
      lastPaymentAt: Math.max(previous.lastPaymentAt, Date.parse(state.orders.get(id)!.paidAt!)),
    });
  }
  const rows: ConnectorCampaignMetric[] = [];
  for (let day = 0; day < config.days; day += 1) {
    const start = Date.parse(config.historyStart) + day * DAY_MS;
    if (start >= openingTime(config) && start < until)
      rows.push(campaign(config, day, until, totals));
  }
  return rows;
}

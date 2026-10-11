import { plannedCandidate, launchedCandidate } from "./mock-scenario-candidates.js";
import { scenarioAt } from "./mock-scenario-plans.js";
import { ConnectorTimestampSchema, type ConnectorSku } from "@shopmate/contracts";
import { generateCatalog, type CatalogEntry } from "./mock-catalog.js";
import { DAY_MS, MockConfigSchema, openingTime, type MockConfig } from "./mock-config.js";
import { seededInteger } from "./mock-random.js";
import { campaignPlan } from "./mock-campaign-plan.js";

export interface OrderCandidate {
  readonly id: string;
  readonly at: number;
  readonly sku: ConnectorSku;
  readonly quantity: number;
  readonly discountBps: number;
  readonly campaignId: string | null;
  readonly cancel: boolean;
  readonly refund: boolean;
  readonly partialRefund: boolean;
  readonly returnGoods: boolean;
}
export interface TimelineEvent {
  readonly at: number;
  readonly kind:
    | "RESTOCK"
    | "RESERVE"
    | "PAY"
    | "CANCEL"
    | "SHIP"
    | "COMPLETE"
    | "REFUND"
    | "RETURN";
  readonly candidate?: OrderCandidate;
  readonly skuId?: string;
  readonly stock?: number;
}
const hourWeights = [1, 1, 1, 1, 1, 1, 2, 3, 4, 5, 6, 7, 7, 5, 5, 6, 7, 8, 10, 12, 14, 12, 8, 4];
const weekWeights = [125, 92, 95, 100, 100, 115, 130];

export function dailyDemand(config: MockConfig, day: number): number {
  const at = Date.parse(config.historyStart) + day * DAY_MS;
  if (at < openingTime(config)) return 0;
  const weekday = new Date(at + 8 * 3_600_000).getUTCDay();
  const growth =
    10_000 - config.growthBps + (config.growthBps * day) / Math.max(1, config.days - 1);
  const organic = Math.floor(
    (config.dailyOrders * weekWeights[weekday]! * growth * 0.8) / 1_000_000,
  );
  return Math.max(
    1,
    Math.min(
      Math.ceil(config.dailyOrders * 1.35),
      organic + campaignPlan(config, day).potentialOrders,
    ),
  );
}

function hourFor(value: number): number {
  for (let hour = 0; hour < hourWeights.length; hour += 1) {
    value -= hourWeights[hour]!;
    if (value < 0) return hour;
  }
  return 23;
}

function baselineCandidateFor(
  config: MockConfig,
  skus: readonly ConnectorSku[],
  day: number,
  index: number,
): OrderCandidate {
  const random = (key: string, max: number) =>
    seededInteger(config.seed, ["order", day, index, key], max);
  const hero = random("hero", 100) < 65;
  const sku = skus[random("sku", hero ? Math.min(10, skus.length) : skus.length)]!;
  const at = candidateTime(config, day, random);
  return {
    id: `${config.binding.externalStoreId}:order:${day}:${index}`,
    at,
    sku,
    quantity: 1 + random("quantity", 2),
    ...commercialFlags(config, sku, skus[0]!, day, random),
    cancel: random("cancel", 100) < 12,
    partialRefund: random("partial", 2) === 0,
    returnGoods: random("return", 2) === 0,
  };
}
function commercialFlags(
  config: MockConfig,
  sku: ConnectorSku,
  heroSku: ConnectorSku,
  day: number,
  random: (key: string, max: number) => number,
) {
  const progress = day / Math.max(1, config.days - 1);
  const problematic = config.profile === "problematic";
  const refundBps =
    problematic && progress > 0.7 && sku === heroSku
      ? Math.min(5000, config.refundBps * 3)
      : config.refundBps;
  const attributionBps = Math.min(
    10_000,
    Math.floor((campaignPlan(config, day).potentialOrders * 10_000) / dailyDemand(config, day)),
  );
  return {
    discountBps: problematic ? 500 + Math.floor(progress * 2500) : 500,
    campaignId:
      random("attribution", 10_000) < attributionBps
        ? `${config.binding.externalStoreId}:campaign:${day}`
        : null,
    refund: random("refund", 10_000) < refundBps,
  };
}
function candidateFor(
  config: MockConfig,
  skus: readonly ConnectorSku[],
  day: number,
  index: number,
): OrderCandidate | null {
  const baseline = baselineCandidateFor(config, skus, day, index);
  // Resolve the launch SKU first so every intervention belongs to the order's final target.
  const launched = launchedCandidate(config, baseline, skus);
  return launched && plannedCandidate(config, launched, skus.indexOf(launched.sku));
}

function candidateTime(
  config: MockConfig,
  day: number,
  random: (key: string, max: number) => number,
): number {
  const hour = hourFor(
    random(
      "hour",
      hourWeights.reduce((sum, weight) => sum + weight, 0),
    ),
  );
  return (
    Date.parse(config.historyStart) +
    day * DAY_MS +
    hour * 3_600_000 +
    random("second", 3600) * 1000
  );
}

function orderEvents(candidate: OrderCandidate): TimelineEvent[] {
  const event = (kind: TimelineEvent["kind"], after: number): TimelineEvent => ({
    kind,
    at: candidate.at + after,
    candidate,
  });
  if (candidate.cancel) return [event("RESERVE", 0), event("CANCEL", 30 * 60_000)];
  const events = [
    event("RESERVE", 0),
    event("PAY", 5 * 60_000),
    event("SHIP", DAY_MS),
    event("COMPLETE", 2 * DAY_MS),
  ];
  if (candidate.refund) events.push(event("REFUND", 3 * DAY_MS));
  if (candidate.refund && candidate.returnGoods) events.push(event("RETURN", 5 * DAY_MS));
  return events;
}

function restockEvents(
  config: MockConfig,
  skus: readonly ConnectorSku[],
  until: number,
  after = Number.NEGATIVE_INFINITY,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const horizon = Date.parse(config.historyStart) + config.days * DAY_MS;
  const opening = openingTime(config);
  const first = Number.isFinite(after)
    ? opening +
      Math.max(0, Math.floor((after - 5 * DAY_MS - opening) / (7 * DAY_MS)) + 1) * 7 * DAY_MS
    : opening;
  for (let at = first; at <= until && at < horizon; at += 7 * DAY_MS) {
    skus.forEach((sku, index) => {
      // Leave one hero SKU without recent replenishment so lost demand follows actual stock depletion.
      if (
        config.profile === "growing" &&
        index === 0 &&
        at !== openingTime(config) &&
        at > Date.parse(config.historyStart) + (config.days - 14) * DAY_MS
      )
        return;
      const share = index < 10 ? 0.065 : 0.35 / skus.length;
      const mutation = scenarioAt(config, at)?.mutations.find((m) => m.skuIndex === index);
      if (mutation?.restockBps === 0) return;
      const arrival = at + (mutation?.restockDelayDays ?? 0) * DAY_MS;
      if (arrival <= after || arrival > until) return;
      events.push({
        kind: "RESTOCK",
        at: arrival,
        skuId: sku.externalSkuId,
        stock: Math.floor(
          (Math.max(25, Math.ceil(config.dailyOrders * 7 * 2 * share)) *
            (mutation?.restockBps ?? 10000)) /
            10000,
        ),
      });
    });
  }
  return events;
}

export function generateTimeline(
  config: MockConfig,
  catalog: readonly CatalogEntry[],
  until: number,
): TimelineEvent[] {
  const skus = catalog.flatMap((entry) => entry.product.skus);
  const events = restockEvents(config, skus, until);
  for (
    let day = 0;
    day < config.days && Date.parse(config.historyStart) + day * DAY_MS <= until;
    day += 1
  ) {
    for (let index = 0; index < dailyDemand(config, day); index += 1) {
      const candidate = candidateFor(config, skus, day, index);
      if (candidate) events.push(...orderEvents(candidate));
    }
  }
  return orderedTimeline(events.filter((event) => event.at <= until));
}

/** Generates at most one day without replaying earlier history; delayed settlements look back five days. */
export function generateTimelineWindow(
  input: unknown,
  afterInput: unknown,
  untilInput: unknown,
): TimelineEvent[] {
  const config = MockConfigSchema.parse(input);
  const after = Date.parse(ConnectorTimestampSchema.parse(afterInput));
  const until = Date.parse(ConnectorTimestampSchema.parse(untilInput));
  if (until <= after || until - after > DAY_MS) throw new RangeError("Invalid timeline window");
  const skus = generateCatalog(config).flatMap((entry) => entry.product.skus);
  const events = restockEvents(config, skus, until, after);
  const start = Date.parse(config.historyStart);
  // RETURN is the longest delayed effect; older candidates cannot affect this window.
  const firstDay = Math.max(0, Math.floor((after - 5 * DAY_MS - start) / DAY_MS));
  const lastDay = Math.min(config.days - 1, Math.floor((until - start) / DAY_MS));
  for (let day = firstDay; day <= lastDay; day += 1) {
    for (let index = 0; index < dailyDemand(config, day); index += 1) {
      const candidate = candidateFor(config, skus, day, index);
      if (candidate) events.push(...orderEvents(candidate));
    }
  }
  return orderedTimeline(events.filter((event) => event.at > after && event.at <= until));
}

function orderedTimeline(events: TimelineEvent[]): TimelineEvent[] {
  return events.sort(compareTimelineEvents);
}

/** Preserve offline causal ordering; publication grouping has its own UTF-8 key ordering. */
export function compareTimelineEvents(a: TimelineEvent, b: TimelineEvent): number {
  const rank = {
    RESTOCK: 0,
    RESERVE: 1,
    PAY: 2,
    CANCEL: 3,
    SHIP: 4,
    COMPLETE: 5,
    REFUND: 6,
    RETURN: 7,
  };
  return (
    a.at - b.at ||
    rank[a.kind] - rank[b.kind] ||
    compareKeys(a.candidate?.id ?? a.skuId!, b.candidate?.id ?? b.skuId!)
  );
}
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

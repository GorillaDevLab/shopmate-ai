import type { SourceGroupSnapshot, SourceGroupEntityKey } from "./mock-source-group-types.js";
import { ConnectorStoreSchema, ConnectorTimestampSchema } from "@shopmate/contracts";
import { z } from "zod";
import { MockConfigSchema, openingTime, DAY_MS, type MockConfig } from "./mock-config.js";
import { generateCatalog, sourceAt } from "./mock-catalog.js";
import { createCausalReducer, type CausalReducer } from "./mock-causal-reducer.js";
import { owned, type CausalHydration } from "./mock-causal-state.js";
import {
  createMarketingAccumulator,
  type MarketingAccumulator,
} from "./mock-marketing-accumulator.js";
import { generateTimelineWindow, type TimelineEvent } from "./mock-history.js";
import { ConnectorCampaignMetricSchema, type ConnectorCampaignMetric } from "@shopmate/contracts";
export interface SourceGroup {
  readonly occurredAt: string;
  readonly events: readonly SourceGroupSnapshot[];
}
export interface SourceGroupHydration {
  readonly causal: CausalHydration;
  readonly marketing: readonly ConnectorCampaignMetric[];
  readonly through: string | null;
}
export interface SourceGroupGenerator {
  window(after: unknown, until: unknown): Iterable<SourceGroup>;
  snapshot(): SourceGroupHydration;
}
const ranks = { STORE: 0, PRODUCT: 10, ORDER: 20, REFUND: 30, INVENTORY: 40, MARKETING: 50 };
function key(event: SourceGroupSnapshot): SourceGroupEntityKey {
  switch (event.kind) {
    case "STORE":
      return [event.kind, event.after.externalStoreId];
    case "PRODUCT":
      return [event.kind, event.after.externalProductId];
    case "ORDER":
      return [event.kind, event.after.externalOrderId];
    case "REFUND":
      return [event.kind, event.after.externalRefundId];
    case "INVENTORY":
      return [event.kind, event.after.externalSkuId, event.after.externalLocationId];
    case "MARKETING":
      return [event.kind, event.after.externalCampaignId, event.after.date];
  }
}
function keyText(event: SourceGroupSnapshot): string {
  return `[${key(event)
    .map((part) => JSON.stringify(part))
    .join(", ")}]`;
}
/** Physical order matches PostgreSQL C collation; stable sort keeps repeated-key causal effects. */
export function orderSourceGroup(
  input: readonly SourceGroupSnapshot[],
): readonly SourceGroupSnapshot[] {
  if (input.length > 16384) throw new RangeError("Timestamp group event budget exceeded");
  const at = input[0]?.occurredAt;
  if (input.some((event) => event.occurredAt !== at)) throw new Error("Mixed timestamp group");
  const events = [...input].sort(
    (a, b) =>
      ranks[a.kind] - ranks[b.kind] ||
      Buffer.compare(Buffer.from(keyText(a)), Buffer.from(keyText(b))),
  );
  const ordinals = new Map<string, number>();
  const result = events.map((event) => {
    const id = keyText(event),
      ordinal = ordinals.get(id) ?? 0;
    ordinals.set(id, ordinal + 1);
    return { ...event, ordinal: String(ordinal) };
  });
  if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024 * 1024)
    throw new RangeError("Timestamp group byte budget exceeded");
  return owned(result);
}
function canonical(input: unknown): string {
  const at = ConnectorTimestampSchema.parse(input);
  if (new Date(at).toISOString() !== at) throw new Error("Canonical UTC timestamp required");
  return at;
}
export function createSourceGroupGenerator(
  input: unknown,
  initial: unknown = { causal: { orders: [], inventory: [] }, marketing: [], through: null },
): SourceGroupGenerator {
  const config = owned(MockConfigSchema.parse(input));
  const dto = z
    .strictObject({
      causal: z.unknown(),
      marketing: z.array(ConnectorCampaignMetricSchema).max(config.days),
      through: z.string().nullable(),
    })
    .parse(initial);
  const causal = createCausalReducer(config, dto.causal),
    marketing = createMarketingAccumulator(config, dto.marketing);
  const state = { through: dto.through === null ? null : canonical(dto.through), active: false };
  validateHydratedThrough(causal.snapshot(), dto.marketing, state.through);
  return Object.freeze({
    window: (after: unknown, until: unknown) =>
      guardedWindow(config, causal, marketing, after, until, state),
    snapshot: () =>
      owned({
        causal: causal.snapshot(),
        marketing: state.through ? marketing.snapshot(state.through) : [],
        through: state.through,
      }),
  });
}
function* guardedWindow(
  config: MockConfig,
  causal: CausalReducer,
  marketing: MarketingAccumulator,
  after: unknown,
  until: unknown,
  state: { through: string | null; active: boolean },
): Generator<SourceGroup> {
  if (state.active) throw new Error("Concurrent source window is active");
  state.active = true;
  try {
    yield* runWindow(config, causal, marketing, after, until, state.through, (at) => {
      state.through = at;
    });
  } finally {
    state.active = false;
  }
}
function validateHydratedThrough(
  causal: CausalHydration,
  marketing: readonly ConnectorCampaignMetric[],
  through: string | null,
): void {
  const rows = [...causal.orders, ...causal.inventory, ...marketing];
  if (through === null && (rows.length || causal.lastEvent))
    throw new Error("Hydration requires owned window position");
  if (
    through &&
    ((causal.lastEvent?.at ?? -Infinity) > Date.parse(through) ||
      rows.some((row) => row.source.updatedAt === null || row.source.updatedAt > through))
  )
    throw new Error("Hydration ahead of window");
}
function opening(config: MockConfig, at: string): SourceGroupSnapshot[] {
  if (Date.parse(at) !== openingTime(config)) return [];
  const store = ConnectorStoreSchema.parse({
    externalStoreId: config.binding.externalStoreId,
    source: { ...sourceAt(at), version: null },
    name: `演示店铺 ${config.profile}`,
    category: "3C配件",
    currency: "CNY",
    timeZone: "Asia/Shanghai",
  });
  const events: SourceGroupSnapshot[] = [
    { kind: "STORE", occurredAt: at, ordinal: "0", after: store },
  ];
  for (const entry of generateCatalog(config))
    events.push({
      kind: "PRODUCT",
      occurredAt: at,
      ordinal: "0",
      after: { ...entry.product, source: { ...entry.product.source, version: null } },
    });
  return events;
}
function timestampGroup(
  config: MockConfig,
  causal: CausalReducer,
  marketing: MarketingAccumulator,
  at: string,
  timeline: readonly TimelineEvent[],
): SourceGroup {
  const effects = opening(config, at);
  for (const event of timeline) {
    const mutations = causal.apply(event);
    marketing.apply(event, mutations);
    effects.push(...mutations.map((mutation) => ({ ...mutation, ordinal: "0" })));
  }
  for (const row of marketing.observe(at))
    effects.push({ kind: "MARKETING", occurredAt: at, ordinal: "0", after: row });
  return owned({ occurredAt: at, events: orderSourceGroup(effects) });
}
function* runWindow(
  config: MockConfig,
  causal: CausalReducer,
  marketing: MarketingAccumulator,
  afterInput: unknown,
  untilInput: unknown,
  through: string | null,
  commit: (at: string) => void,
): Generator<SourceGroup> {
  const after = canonical(afterInput),
    until = canonical(untilInput);
  if (through !== null && after !== through)
    throw new Error("Window must continue owned hydration");
  if (through === null && Date.parse(after) >= openingTime(config))
    throw new Error("Fresh window must include opening");
  if (Date.parse(until) <= Date.parse(after) || Date.parse(until) - Date.parse(after) > DAY_MS)
    throw new RangeError("Invalid source window");
  const timeline = generateTimelineWindow(config, after, until);
  const times = windowTimes(config, timeline, after, until);
  let offset = 0;
  for (const at of [...times].sort((a, b) => a - b)) {
    const first = offset;
    while (offset < timeline.length && timeline[offset]!.at === at) offset++;
    const timestamp = new Date(at).toISOString();
    const group = timestampGroup(
      config,
      causal,
      marketing,
      timestamp,
      timeline.slice(first, offset),
    );
    commit(timestamp);
    if (group.events.length) yield group;
  }
}
function windowTimes(
  config: MockConfig,
  timeline: readonly TimelineEvent[],
  after: string,
  until: string,
): readonly number[] {
  const times = new Set(timeline.map((event) => event.at));
  const start = Date.parse(config.historyStart),
    end = Date.parse(until);
  for (let day = 0; day <= config.days; day++) {
    const at = start + day * DAY_MS;
    if (at > Date.parse(after) && at <= end && at >= openingTime(config)) times.add(at);
  }
  times.add(end);
  return [...times].sort((a, b) => a - b);
}

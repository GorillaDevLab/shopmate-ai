import { expect, it, vi } from "vitest";
import {
  ConnectorOrderSchema,
  ConnectorRefundSchema,
  ConnectorInventorySchema,
  ConnectorCampaignMetricSchema,
  MetricInputV1Schema,
  type MetricInputV1,
  type MetricSourceQuery,
} from "@shopmate/contracts";
import type {
  MetricSourceBundleRepository,
  MetricSourcePrefix,
  NormalizedMetricSourceBundle,
} from "@shopmate/database";
import { createNormalizedMetricSourceAdapter } from "./normalized-metric-source.adapter.js";

const opening = "2026-10-01T00:00:00.000Z";
const end = "2026-10-03T00:00:00.000Z";
const visible = "2026-10-03T01:00:00.000Z";
const hash = "a".repeat(64);
const binding = {
  organizationId: "org-1",
  workspaceId: "workspace-1",
  storeId: "store-1",
  connectionId: "connection-1",
  externalStoreId: "external-1",
};
const window = {
  periodStart: "2026-10-02T00:00:00.000Z",
  periodEnd: end,
  timezone: "Asia/Shanghai",
  currency: "CNY",
} as const;
function query(patch: Partial<MetricSourceQuery> = {}): MetricSourceQuery {
  return {
    binding,
    window,
    visibleAt: visible,
    definitionVersion: "metrics-v1",
    inputRevision: `p2-normalized-v1:${hash}`,
    coverageRequests: [{ kind: "PAID_REVENUE", subject: { kind: "STORE" } }],
    ...patch,
  };
}
function prefix(stream: MetricSourcePrefix["stream"]): MetricSourcePrefix {
  return {
    jobId: `job-${stream}`,
    stream,
    since: opening,
    until: end,
    successfulThrough: end,
    proof: {
      pageCount: 1,
      terminalCount: 1,
      knownCount: 1,
      sourceWatermark: end,
      observedAt: visible,
    },
    receipts: [
      {
        pageId: `page-${stream}`,
        pageHash: hash,
        expectedCursor: null,
        nextCursor: null,
        observedAt: visible,
        sourceWatermark: end,
        ingestedAt: visible,
      },
    ],
  };
}
function order() {
  return ConnectorOrderSchema.parse({
    externalStoreId: binding.externalStoreId,
    externalOrderId: "original-order",
    status: "PAID",
    orderedAt: opening,
    paidAt: "2026-10-01T01:00:00.000Z",
    currency: "CNY",
    source: { version: null, updatedAt: opening, quality: { state: "COMPLETE", issues: [] } },
    items: [
      {
        externalLineId: "line-1",
        externalProductId: "product-1",
        externalSkuId: "sku-1",
        quantity: 1,
        unitPriceMinor: 10500,
        grossMinor: 10500,
        discountMinor: 0,
        netMinor: 10500,
      },
    ],
    grossMinor: 10500,
    discountMinor: 0,
    shippingMinor: 0,
    payableMinor: 10500,
    paidMinor: 10500,
    refundedMinor: 0,
  });
}
function bundle(patch: Partial<NormalizedMetricSourceBundle> = {}): NormalizedMetricSourceBundle {
  return {
    mappingVersion: "p2-normalized-v1",
    binding,
    scopeId: "12345678-1234-4123-8123-123456789abc",
    provider: "MOCK",
    generation: 1,
    window,
    visibleAt: visible,
    businessNow: visible,
    clockRevision: 2,
    sourceOpening: opening,
    sourceWatermark: end,
    inputRevision: query().inputRevision!,
    capturedAt: visible,
    evidenceIds: [`metric-evidence-v1:${hash}`],
    prefixes: ["ORDERS", "REFUNDS", "INVENTORY", "MARKETING"].map((stream) =>
      prefix(stream as MetricSourcePrefix["stream"]),
    ),
    orders: [{ data: order(), sourcePayloadHash: hash, observedAt: visible, ingestedAt: visible }],
    refunds: [],
    inventory: [],
    campaigns: [],
    ...patch,
  };
}
function reader(value: unknown = bundle()) {
  const read = vi.fn(async () => ({ ok: true as const, value }));
  return {
    read,
    source: createNormalizedMetricSourceAdapter({ read } as Pick<
      MetricSourceBundleRepository,
      "read"
    >),
  };
}
async function mapped(value = bundle(), request = query()): Promise<MetricInputV1> {
  const result = await reader(value).source.read(request);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
it("maps canonical facts with honest null extensions and preserved provenance", async () => {
  const input = await mapped();
  expect(MetricInputV1Schema.safeParse(input).success).toBe(true);
  expect(input.paymentFacts?.[0]?.data).toEqual(order());
  expect(input.paymentFacts?.[0]).toMatchObject({
    binding,
    observedAt: visible,
    sourceVersion: `p2-record:${hash}`,
    evidenceIds: bundle().evidenceIds,
  });
  for (const key of [
    "frozenCosts",
    "refundAllocations",
    "returnReceipts",
    "fees",
    "traffic",
    "inventoryExtensions",
  ] as const)
    expect(input[key]).toBeNull();
  expect(input.inputRevision).toBe(query().inputRevision);
  expect(input.sourceWatermark).toBe(end);
  expect(input.status).toBe("ESTIMATED");
  expect(Object.isFrozen(input.paymentFacts?.[0]?.data.items)).toBe(true);
});
it("retains original payments outside the requested day for next-day refund joins", async () => {
  const input = await mapped();
  expect(input.paymentFacts?.[0]?.data.paidAt).toBe("2026-10-01T01:00:00.000Z");
  expect(input.paymentFacts).toHaveLength(1);
});
it("proves requested payment coverage without claiming cost, funnel, or campaign intervals", async () => {
  const coverageRequests: MetricSourceQuery["coverageRequests"] = [
    { kind: "PAID_REVENUE", subject: { kind: "STORE" } },
    { kind: "NET_REVENUE_SETTLEMENT", subject: { kind: "STORE" } },
    { kind: "COGS", subject: { kind: "STORE" } },
    { kind: "CONVERSION_RATE", subject: { kind: "STORE" } },
    { kind: "ROAS", subject: { kind: "CAMPAIGN", externalCampaignId: "campaign-1" } },
  ];
  const input = await mapped(bundle(), query({ coverageRequests }));
  expect(input.metricCoverage.map(({ kind }) => kind)).toEqual([
    "PAID_REVENUE",
    "NET_REVENUE_SETTLEMENT",
  ]);
  expect(input.metricCoverage[0]).toMatchObject({
    coverageBasisPoints: 10000,
    collections: ["paymentFacts"],
    observedAt: visible,
    evidenceIds: input.evidenceIds,
  });
  expect(input.metricCoverage[1]?.collections).toEqual(["paymentFacts", "refundFacts"]);
});
it("permits observed empty completed scans to prove true zero", async () => {
  const input = await mapped(bundle({ orders: [] }));
  expect(input.paymentFacts).toEqual([]);
  expect(input.metricCoverage[0]?.coverageBasisPoints).toBe(10000);
});
it("preserves the repository receiver and pins the exact read request", async () => {
  const repository = {
    value: bundle(),
    async read() {
      return { ok: true as const, value: this.value };
    },
  };
  const source = createNormalizedMetricSourceAdapter(repository);
  expect((await source.read(query())).ok).toBe(true);
  const tracked = reader();
  await tracked.source.read(query());
  expect(tracked.read).toHaveBeenCalledWith({
    binding,
    window,
    visibleAt: visible,
    inputRevision: query().inputRevision,
  });
});
it.each([
  { ...query(), inputRevision: null },
  { ...query(), secret: "unknown" },
  { ...query(), visibleAt: "2026-10-03T01:00:00.0001Z" },
  { ...query(), coverageRequests: [...query().coverageRequests, ...query().coverageRequests] },
  { ...query(), window: { ...window, periodEnd: "2026-10-04T00:00:00.000Z" } },
])("rejects unsafe queries before invoking the dependency: %j", async (request) => {
  const tracked = reader();
  expect(await tracked.source.read(request)).toEqual({
    ok: false,
    error: { code: "INVALID_INPUT", evidenceIds: [] },
  });
  expect(tracked.read).not.toHaveBeenCalled();
});
it.each([
  { prefixes: [] },
  { prefixes: [prefix("ORDERS")] },
  { prefixes: [...bundle().prefixes, prefix("ORDERS")] },
  { prefixes: bundle().prefixes.map((entry) => ({ ...entry, successfulThrough: opening })) },
  { businessNow: end },
  { orders: [{ ...bundle().orders[0]!, observedAt: "2026-10-04T00:00:00.000Z" }] },
  { extra: "unknown" },
])("rejects missing or contradictory source proof: %j", async (patch) => {
  const result = await reader({ ...bundle(), ...patch }).source.read(query());
  expect(result).toEqual({ ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } });
});
it.each([
  [{ binding: { ...binding, connectionId: "other" } }, "SCOPE_MISMATCH"],
  [{ inputRevision: `p2-normalized-v1:${"b".repeat(64)}` }, "VERSION_MISMATCH"],
  [{ visibleAt: end }, "WINDOW_MISMATCH"],
  [{ window: { ...window, periodStart: opening } }, "WINDOW_MISMATCH"],
] as const)("rejects archive context mismatch: %j", async (patch, code) => {
  expect(await reader(bundle(patch)).source.read(query())).toEqual({
    ok: false,
    error: { code, evidenceIds: [] },
  });
});
it("propagates safe unknown-revision errors without trying current data", async () => {
  const read = vi.fn(async () => ({
    ok: false as const,
    error: { code: "NOT_FOUND" as const, evidenceIds: [] },
  }));
  expect(await createNormalizedMetricSourceAdapter({ read }).read(query())).toEqual({
    ok: false,
    error: { code: "NOT_FOUND", evidenceIds: [] },
  });
  expect(read).toHaveBeenCalledTimes(1);
});
it("redacts unexpected repository failures", async () => {
  const read = async () => {
    throw new Error("secret database detail");
  };
  expect(await createNormalizedMetricSourceAdapter({ read }).read(query())).toEqual({
    ok: false,
    error: { code: "SOURCE_UNAVAILABLE", evidenceIds: [] },
  });
});
const providerSource = {
  version: "provider-v2",
  updatedAt: end,
  quality: { state: "COMPLETE", issues: [] },
};
function refund() {
  return ConnectorRefundSchema.parse({
    externalStoreId: binding.externalStoreId,
    source: providerSource,
    externalRefundId: "refund-1",
    externalOrderId: "original-order",
    externalSkuId: null,
    status: "SUCCEEDED",
    requestedMinor: 2000,
    succeededMinor: 2000,
    requestedAt: "2026-10-02T01:00:00.000Z",
    succeededAt: "2026-10-02T02:00:00.000Z",
    currency: "CNY",
  });
}
function inventory() {
  return ConnectorInventorySchema.parse({
    externalStoreId: binding.externalStoreId,
    source: providerSource,
    externalSkuId: "sku-1",
    externalLocationId: "location-1",
    available: 4,
    reserved: 1,
    onHand: 5,
    safetyStock: null,
    leadTimeDays: 2,
  });
}
function campaign() {
  return ConnectorCampaignMetricSchema.parse({
    externalStoreId: binding.externalStoreId,
    source: providerSource,
    externalCampaignId: "campaign-1",
    date: "2026-10-02",
    impressions: 10,
    clicks: 2,
    attributedOrders: 1,
    spendMinor: 100,
    attributedRevenueMinor: 1000,
    currency: "CNY",
  });
}
function allMappedFacts(): NormalizedMetricSourceBundle {
  const metadata = {
    sourcePayloadHash: hash,
    observedAt: visible,
    ingestedAt: "2026-11-01T00:00:00.000Z",
  };
  return bundle({
    refunds: [{ ...metadata, data: refund() }],
    inventory: [{ ...metadata, data: inventory() }],
    campaigns: [{ ...metadata, data: campaign() }],
  });
}
it.each(["orders", "refunds", "inventory", "campaigns"] as const)(
  "rejects duplicate canonical %s so population proof cannot double count",
  async (name) => {
    const raw = allMappedFacts();
    const value = { ...raw, [name]: [...raw[name], ...raw[name]] };
    expect(await reader(value).source.read(query())).toEqual({
      ok: false,
      error: { code: "INVALID_INPUT", evidenceIds: [] },
    });
  },
);
it("preserves refund, inventory, campaign DTOs and physical ingestion after business cutoff", async () => {
  const raw = allMappedFacts();
  const input = await mapped(raw);
  expect(input.refundFacts?.[0]?.data).toEqual(raw.refunds[0]?.data);
  expect(input.inventoryFacts?.[0]?.data).toEqual(raw.inventory[0]?.data);
  expect(input.campaignFacts?.[0]).toMatchObject({
    data: raw.campaigns[0]?.data,
    measuredCoverage: null,
    sourceVersion: "provider-v2",
    observedAt: visible,
  });
  expect(input.inventoryExtensions).toBeNull();
});
it("grants inventory available coverage only to the requested SKU", async () => {
  const coverageRequests: MetricSourceQuery["coverageRequests"] = [
    { kind: "INVENTORY_AVAILABLE", subject: { kind: "SKU", externalSkuId: "sku-1" } },
    { kind: "INVENTORY_AVAILABLE", subject: { kind: "STORE" } },
    { kind: "LEAD_TIME_HOURS", subject: { kind: "SKU", externalSkuId: "sku-1" } },
  ];
  const input = await mapped(allMappedFacts(), query({ coverageRequests }));
  expect(input.metricCoverage).toHaveLength(1);
  expect(input.metricCoverage[0]).toMatchObject({
    kind: "INVENTORY_AVAILABLE",
    subject: { kind: "SKU", externalSkuId: "sku-1" },
    collections: ["inventoryFacts"],
  });
});
it("retains query spelling for equivalent UTC instants and repeats deterministically", async () => {
  const request = query({
    visibleAt: visible.replace(".000", ""),
    window: {
      ...window,
      periodStart: window.periodStart.replace(".000", ""),
      periodEnd: end.replace(".000", ""),
    },
  });
  const input = await mapped(bundle(), request);
  expect(input.visibleAt).toBe(request.visibleAt);
  expect(input.periodStart).toBe(request.window.periodStart);
  expect(input.metricCoverage[0]?.visibleAt).toBe(request.visibleAt);
  expect(await mapped(bundle(), request)).toEqual(input);
});
it("accepts an actual multi-page receipt chain independent of array order", async () => {
  const original = prefix("ORDERS");
  const first = { ...original.receipts[0]!, nextCursor: "cursor-1" };
  const second = {
    ...first,
    pageId: "page-orders-2",
    expectedCursor: "cursor-1",
    nextCursor: null,
  };
  const prefixes = changedOrderPrefix({
    receipts: [second, first],
    proof: { ...original.proof, pageCount: 2, knownCount: 2 },
  });
  expect((await mapped(bundle({ prefixes }))).metricCoverage[0]?.coverageBasisPoints).toBe(10000);
});
it("preserves explicit partial source quality and unknown payment amounts", async () => {
  const data = ConnectorOrderSchema.parse({
    ...order(),
    paidMinor: null,
    source: { ...order().source, quality: { state: "PARTIAL", issues: ["PAYMENT_UNKNOWN"] } },
  });
  const input = await mapped(bundle({ orders: [{ ...bundle().orders[0]!, data }] }));
  expect(input.paymentFacts?.[0]?.data.paidMinor).toBeNull();
  expect(input.paymentFacts?.[0]?.data.source.quality).toEqual(data.source.quality);
});
it("captures the original read method without invoking capture", async () => {
  const original = vi.fn(async () => ({ ok: true as const, value: bundle() }));
  const capture = vi.fn();
  const repository = { read: original, capture };
  const source = createNormalizedMetricSourceAdapter(repository);
  repository.read = vi.fn(async () => {
    throw new Error("replacement must not be invoked");
  });
  expect((await source.read(query())).ok).toBe(true);
  expect(original).toHaveBeenCalledTimes(1);
  expect(capture).not.toHaveBeenCalled();
});
function changedOrderPrefix(patch: Partial<MetricSourcePrefix>): readonly MetricSourcePrefix[] {
  return bundle().prefixes.map((entry) =>
    entry.stream === "ORDERS" ? { ...entry, ...patch } : entry,
  );
}
it.each([
  { receipts: [{ ...prefix("ORDERS").receipts[0]!, nextCursor: "unfinished" }] },
  { receipts: [{ ...prefix("ORDERS").receipts[0]!, expectedCursor: "missing" }] },
  { proof: { ...prefix("ORDERS").proof, pageCount: 2 } },
  { proof: { ...prefix("ORDERS").proof, knownCount: 2 } },
  { proof: { ...prefix("ORDERS").proof, observedAt: "2026-10-04T00:00:00.000Z" } },
  { receipts: [{ ...prefix("ORDERS").receipts[0]!, pageHash: "invalid" }] },
  { since: window.periodStart },
  { proof: { ...prefix("ORDERS").proof, observedAt: end } },
])("rejects malformed actual receipt proof: %j", async (patch) => {
  expect(
    await reader(bundle({ prefixes: changedOrderPrefix(patch) })).source.read(query()),
  ).toEqual({ ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } });
});
it("rejects invented fact observation even when it precedes the cutoff", async () => {
  const orders = [{ ...bundle().orders[0]!, observedAt: end }];
  expect(await reader(bundle({ orders })).source.read(query())).toEqual({
    ok: false,
    error: { code: "INVALID_INPUT", evidenceIds: [] },
  });
});
it("rejects a claimed overall watermark beyond the actual stream proofs", async () => {
  expect(await reader(bundle({ sourceWatermark: visible })).source.read(query())).toEqual({
    ok: false,
    error: { code: "INVALID_INPUT", evidenceIds: [] },
  });
});
it("preserves provider version text without treating it as a business timestamp", async () => {
  const version = "2026-10-01T00:00:00.0001Z";
  const data = { ...order(), source: { ...order().source, version } };
  const input = await mapped(bundle({ orders: [{ ...bundle().orders[0]!, data }] }));
  expect(input.paymentFacts?.[0]?.sourceVersion).toBe(version);
  expect(input.paymentFacts?.[0]?.data.source.version).toBe(version);
});
it.each([
  { source: { ...order().source, updatedAt: "2026-10-01T00:00:00.00001Z" } },
  { paidAt: "2026-10-01T01:00:00.00001Z" },
  { paidAt: "2026-10-04T00:00:00.000Z" },
  { externalStoreId: "other-store" },
  { paidMinor: Number.MAX_SAFE_INTEGER + 1 },
  { privateCustomer: "unexpected" },
])("rejects malformed, unsafe, or future canonical facts: %j", async (patch) => {
  const orders = [{ ...bundle().orders[0]!, data: { ...order(), ...patch } }];
  expect(await reader({ ...bundle(), orders }).source.read(query())).toEqual({
    ok: false,
    error: { code: "INVALID_INPUT", evidenceIds: [] },
  });
});
it.each([
  undefined,
  {},
  { ok: true, value: bundle(), secret: "unexpected" },
  { ok: false, error: { code: "NOT_FOUND", evidenceIds: [], detail: "secret" } },
])("rejects malformed dependency envelopes without leaking details: %j", async (value) => {
  const read = async () => value;
  const source = createNormalizedMetricSourceAdapter({ read } as Pick<
    MetricSourceBundleRepository,
    "read"
  >);
  expect(await source.read(query())).toEqual({
    ok: false,
    error: { code: "INVALID_INPUT", evidenceIds: [] },
  });
});

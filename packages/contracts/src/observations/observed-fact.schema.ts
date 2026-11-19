import { z } from "zod";
import {
  ConnectorBindingSchema,
  ConnectorFailureCodeSchema,
  CurrencySchema,
  CursorSchema,
  ExternalIdSchema,
  MinorAmountSchema,
  QuantitySchema,
  SourceVersionSchema,
} from "../commerce/connector-common.schema.js";
import { MockScenarioPlanSchema } from "../commerce/mock-scenario.schema.js";
import { EventEntitySchema } from "../events/event-evidence.schema.js";
import {
  BasisPointsSchema,
  MetricCollectionSchema,
  MetricCoverageV1Schema,
  MetricFeeKindSchema,
  MetricInputV1Schema,
  MetricSubjectSchema,
  type MetricCampaignFact,
  type MetricInventoryExtension,
  type MetricInputV1,
  type MetricTraffic,
  type MetricRefundFact,
  MetricIssueCodeSchema,
  MetricWindowSchema,
  SignedMinorSchema,
} from "../metrics/metric.schema.js";

import { TenantContextSchema } from "../tenant/tenant.schema.js";

const utcMs = z.iso
  .datetime({ precision: 3 })
  .refine(
    (value) =>
      !value.startsWith("0000") &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    "Expected a canonical UTC millisecond timestamp",
  );
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const generation = QuantitySchema.max(2147483647);
const modelVersion = z.literal("mock-business-observed-v1");
const sequence = QuantitySchema.min(1);
const hours = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const observedVersionPattern = /^observed-v1:g:(0|[1-9]\d*):e:([1-9]\d*)$/u;
const observedVersion = z
  .string()
  .max(80)
  .refine((value) => {
    const parts = observedVersionPattern.exec(value);
    return (
      parts !== null &&
      generation.safeParse(Number(parts[1])).success &&
      sequence.safeParse(Number(parts[2])).success
    );
  });
const scope = { binding: ConnectorBindingSchema, generation };
const exactWindow = MetricWindowSchema.refine(
  ({ periodStart, periodEnd }) =>
    [periodStart, periodEnd].every((time) => utcMs.safeParse(time).success),
  "Window endpoints must be canonical UTC millisecond timestamps",
);

export const ObservedDomainSchema = z.enum([
  "FROZEN_COST",
  "REFUND_ALLOCATION",
  "RETURN_RECEIPT",
  "FEE",
  "TRAFFIC",
  "CAMPAIGN_MEASUREMENT",
  "LISTING",
  "PRICE",
  "INVENTORY_LOT",
  "SUPPLIER_NOTICE",
  "INVENTORY_POSITION",
  "SYNC_TRANSITION",
]);
export type ObservedDomain = z.infer<typeof ObservedDomainSchema>;

export const ObservedSubjectSchema = EventEntitySchema;
export type ObservedSubject = z.infer<typeof ObservedSubjectSchema>;
const [storeSubject, skuSubject, campaignSubject, connectionSubject] =
  ObservedSubjectSchema.options;

const envelope = z.strictObject({
  schemaVersion: z.literal(1),
  ledgerVersion: z.literal("observed-facts-v1"),
  ...scope,
  factId: ExternalIdSchema,
  sequence,
  priorVersion: observedVersion.nullable(),
  sourceVersion: observedVersion,
  producerVersion: SourceVersionSchema,
  modelVersion,
  occurredAt: utcMs,
  observedAt: utcMs,
  payloadHash: sha256,
});

function hasValidEnvelope(fact: z.infer<typeof envelope>): boolean {
  if (fact.occurredAt > fact.observedAt) return false;
  if (fact.sourceVersion !== "observed-v1:g:" + fact.generation + ":e:" + fact.sequence)
    return false;
  if (fact.priorVersion === null) return true;

  const prior = observedVersionPattern.exec(fact.priorVersion);
  return prior !== null && Number(prior[1]) === fact.generation && Number(prior[2]) < fact.sequence;
}

function observedFact<
  D extends ObservedDomain,
  S extends z.ZodType<ObservedSubject>,
  P extends z.ZodType,
>(domain: D, subject: S, payload: P) {
  return envelope
    .extend({ domain: z.literal(domain), subject, payload })
    .refine(hasValidEnvelope, "Fact version or occurrence does not match its observation");
}

const basis = z.enum(["CONFIRMED", "ESTIMATED", "UNAVAILABLE"]);
const lineIds = {
  externalOrderId: ExternalIdSchema,
  externalLineId: ExternalIdSchema,
  externalSkuId: ExternalIdSchema,
};
const locationIds = {
  externalSkuId: ExternalIdSchema,
  externalLocationId: ExternalIdSchema,
};

const frozenCost = observedFact(
  "FROZEN_COST",
  skuSubject,
  z
    .strictObject({
      ...lineIds,
      quantity: sequence,
      frozenAt: utcMs,
      skuCostVersion: SourceVersionSchema.nullable(),
      unitCostMinor: MinorAmountSchema.nullable(),
      basis,
      currency: CurrencySchema,
      reason: MetricIssueCodeSchema.extract(["COST_MISSING", "COST_ESTIMATED"]).nullable(),
    })
    .readonly(),
).refine(({ payload, subject, observedAt }) => {
  if (payload.externalSkuId !== subject.externalSkuId || payload.frozenAt > observedAt)
    return false;
  if (payload.basis === "UNAVAILABLE") {
    return payload.unitCostMinor === null && payload.reason === "COST_MISSING";
  }
  return (
    payload.skuCostVersion !== null &&
    payload.unitCostMinor !== null &&
    payload.reason === (payload.basis === "ESTIMATED" ? "COST_ESTIMATED" : null)
  );
}, "Frozen cost must match its SKU, historical pricing basis and observation");

const refundAllocation = observedFact(
  "REFUND_ALLOCATION",
  skuSubject,
  z
    .strictObject({
      ...lineIds,
      externalRefundId: ExternalIdSchema,
      quantity: QuantitySchema.nullable(),
      merchandiseMinor: MinorAmountSchema.nullable(),
      buyerShippingMinor: MinorAmountSchema.nullable(),
      settledAt: utcMs,
      currency: CurrencySchema,
      reason: MetricIssueCodeSchema.extract(["REFUND_UNKNOWN"]).nullable(),
    })
    .readonly(),
).refine(({ payload, subject, observedAt }) => {
  const unknown = [payload.quantity, payload.merchandiseMinor, payload.buyerShippingMinor].includes(
    null,
  );
  return (
    payload.externalSkuId === subject.externalSkuId &&
    payload.settledAt <= observedAt &&
    payload.reason === (unknown ? "REFUND_UNKNOWN" : null)
  );
}, "Refund allocation must match its SKU, source quality and observation");

const returnReceipt = observedFact(
  "RETURN_RECEIPT",
  skuSubject,
  z
    .strictObject({
      ...lineIds,
      externalRefundId: ExternalIdSchema,
      externalReceiptId: ExternalIdSchema,
      acceptedAt: utcMs.nullable(),
      resellableQuantity: QuantitySchema.nullable(),
      reason: MetricIssueCodeSchema.extract(["RETURN_UNKNOWN"]).nullable(),
    })
    .readonly(),
).refine(({ payload, subject, observedAt }) => {
  if (payload.externalSkuId !== subject.externalSkuId) return false;
  if (payload.acceptedAt === null && payload.resellableQuantity !== null) return false;
  return (
    (payload.acceptedAt === null || payload.acceptedAt <= observedAt) &&
    payload.reason === (payload.resellableQuantity === null ? "RETURN_UNKNOWN" : null)
  );
}, "A measured return needs an observed acceptance for the same SKU");

const fee = observedFact(
  "FEE",
  storeSubject,
  z
    .strictObject({
      chargeId: ExternalIdSchema,
      kind: MetricFeeKindSchema,
      externalOrderId: ExternalIdSchema.nullable(),
      externalCampaignId: ExternalIdSchema.nullable(),
      window: exactWindow,
      amountMinor: MinorAmountSchema.nullable(),
      basis,
      coverageBasisPoints: BasisPointsSchema,
      reason: MetricIssueCodeSchema.extract([
        "FEE_MISSING",
        "FEE_ESTIMATED",
        "PARTIAL_COVERAGE",
      ]).nullable(),
    })
    .readonly(),
).refine(({ payload, observedAt }) => {
  if (payload.window.periodEnd > observedAt) return false;
  if (payload.basis === "UNAVAILABLE") {
    return payload.amountMinor === null && payload.reason === "FEE_MISSING";
  }
  if (payload.amountMinor === null) return false;
  if (payload.basis === "ESTIMATED") return payload.reason === "FEE_ESTIMATED";
  return payload.reason === (payload.coverageBasisPoints < 10000 ? "PARTIAL_COVERAGE" : null);
}, "Fee amount and reason must reflect its basis and closed observation window");

const traffic = observedFact(
  "TRAFFIC",
  z.union([storeSubject, skuSubject]),
  z
    .strictObject({
      window: exactWindow,
      visitors: QuantitySchema.nullable(),
      cart: QuantitySchema.nullable(),
      checkout: QuantitySchema.nullable(),
      paidOrders: QuantitySchema.nullable(),
      measurementVersion: SourceVersionSchema,
      coverageBasisPoints: BasisPointsSchema,
      reason: MetricIssueCodeSchema.extract(["TRAFFIC_MISSING", "PARTIAL_COVERAGE"]).nullable(),
    })
    .readonly(),
).refine(({ payload, observedAt }) => {
  const unknown = [payload.visitors, payload.cart, payload.checkout, payload.paidOrders].includes(
    null,
  );
  if (payload.window.periodEnd > observedAt) return false;
  if (unknown) return payload.reason === "TRAFFIC_MISSING";
  return payload.reason === (payload.coverageBasisPoints < 10000 ? "PARTIAL_COVERAGE" : null);
}, "Traffic reason must reflect source quality for its closed window");

const dayMs = 24 * 60 * 60 * 1000;
const shanghaiDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  calendar: "iso8601",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function shanghaiBusinessDate(instant: number): string {
  const parts = shanghaiDateFormatter.formatToParts(instant);
  const year = parts.find(({ type }) => type === "year")?.value.padStart(4, "0");
  const month = parts.find(({ type }) => type === "month")?.value;
  const day = parts.find(({ type }) => type === "day")?.value;
  return year + "-" + month + "-" + day;
}

function withinBusinessDate(businessDate: string, window: z.infer<typeof exactWindow>): boolean {
  const start = Date.parse(window.periodStart);
  const end = Date.parse(window.periodEnd);
  // The exclusive end can be midnight of the next Shanghai day.
  return (
    start < end &&
    shanghaiBusinessDate(start) === businessDate &&
    shanghaiBusinessDate(end - 1) === businessDate
  );
}

const campaignMeasurement = observedFact(
  "CAMPAIGN_MEASUREMENT",
  campaignSubject,
  z
    .strictObject({
      externalCampaignId: ExternalIdSchema,
      businessDate: z.iso.date(),
      window: exactWindow,
      spendMinor: MinorAmountSchema.nullable(),
      attributedRevenueMinor: MinorAmountSchema.nullable(),
      eligibleCount: QuantitySchema.nullable(),
      measuredCount: QuantitySchema.nullable(),
      measurementVersion: SourceVersionSchema,
      attributionPolicyVersion: SourceVersionSchema,
      coverageBasisPoints: BasisPointsSchema,
      currency: CurrencySchema,
      reason: MetricIssueCodeSchema.extract(["ATTRIBUTION_MISSING", "PARTIAL_COVERAGE"]).nullable(),
    })
    .readonly(),
).refine(({ payload, subject, observedAt }) => {
  if (
    payload.externalCampaignId !== subject.externalCampaignId ||
    payload.window.periodEnd > observedAt
  )
    return false;
  if (!withinBusinessDate(payload.businessDate, payload.window)) return false;
  const { eligibleCount, measuredCount, spendMinor, attributedRevenueMinor } = payload;
  if (eligibleCount !== null && measuredCount !== null && measuredCount > eligibleCount)
    return false;
  if ([eligibleCount, measuredCount, spendMinor, attributedRevenueMinor].includes(null)) {
    return payload.reason === "ATTRIBUTION_MISSING";
  }
  return payload.reason === (payload.coverageBasisPoints < 10000 ? "PARTIAL_COVERAGE" : null);
}, "Campaign window, measurement counts and quality must match its observed campaign");

const listing = observedFact(
  "LISTING",
  skuSubject,
  z
    .strictObject({
      externalSkuId: ExternalIdSchema,
      listedAt: utcMs,
      effectiveAt: utcMs,
      fromStatus: z.enum(["UNLISTED", "LISTED", "DELISTED"]),
      toStatus: z.enum(["LISTED", "DELISTED"]),
    })
    .readonly(),
).refine(({ payload, subject, observedAt }) => {
  const { externalSkuId, listedAt, effectiveAt, fromStatus, toStatus } = payload;
  const firstListing = fromStatus === "UNLISTED" && toStatus === "LISTED";
  return (
    externalSkuId === subject.externalSkuId &&
    fromStatus !== toStatus &&
    listedAt <= effectiveAt &&
    effectiveAt <= observedAt &&
    (!firstListing || listedAt === effectiveAt)
  );
}, "Listing transitions must match the SKU and its observed listing time");

const price = observedFact(
  "PRICE",
  skuSubject,
  z
    .strictObject({
      externalSkuId: ExternalIdSchema,
      effectiveAt: utcMs,
      priorPriceMinor: MinorAmountSchema.nullable(),
      priceMinor: MinorAmountSchema,
      priceVersion: SourceVersionSchema,
      currency: CurrencySchema,
    })
    .readonly(),
).refine(
  ({ payload, subject, observedAt }) =>
    payload.externalSkuId === subject.externalSkuId && payload.effectiveAt <= observedAt,
  "Price must be effective for the subject SKU at observation",
);

const inventoryLot = observedFact(
  "INVENTORY_LOT",
  skuSubject,
  z
    .strictObject({
      ...locationIds,
      externalLotId: ExternalIdSchema,
      externalReceiptId: ExternalIdSchema,
      receivedAt: utcMs,
      movementAt: utcMs,
      reason: z.enum(["RECEIPT", "SALE", "RETURN", "WRITE_OFF", "TRANSFER_IN", "TRANSFER_OUT"]),
      deltaQuantity: SignedMinorSchema,
      beforeQuantity: QuantitySchema,
      afterQuantity: QuantitySchema,
    })
    .readonly(),
).refine(({ payload, subject, observedAt }) => {
  const { deltaQuantity, beforeQuantity, afterQuantity, receivedAt, movementAt, reason } = payload;
  if (
    payload.externalSkuId !== subject.externalSkuId ||
    receivedAt > movementAt ||
    movementAt > observedAt
  ) {
    return false;
  }
  if (![deltaQuantity, beforeQuantity, afterQuantity].every(Number.isSafeInteger)) return false;
  const inflow = reason === "RECEIPT" || reason === "RETURN" || reason === "TRANSFER_IN";
  return (
    (inflow ? deltaQuantity > 0 : deltaQuantity < 0) &&
    BigInt(beforeQuantity) + BigInt(deltaQuantity) === BigInt(afterQuantity)
  );
}, "An observed inventory movement must conserve units and match its direction");

const supplyQuality = MetricIssueCodeSchema.extract(["INVENTORY_UNKNOWN", "LEAD_TIME_MISSING"]);
function matchesSupplyQuality(
  reason: z.infer<typeof supplyQuality> | null,
  missingInventory: boolean,
  missingLeadTime: boolean,
): boolean {
  if (reason === "INVENTORY_UNKNOWN") return missingInventory;
  if (reason === "LEAD_TIME_MISSING") return missingLeadTime;
  return !missingInventory && !missingLeadTime;
}

const supplierNotice = observedFact(
  "SUPPLIER_NOTICE",
  skuSubject,
  z
    .strictObject({
      ...locationIds,
      noticeId: ExternalIdSchema,
      purchaseOrderId: ExternalIdSchema,
      announcedAt: utcMs,
      priorEta: utcMs.nullable(),
      newEta: utcMs.nullable(),
      inboundQuantity: QuantitySchema.nullable(),
      promisedLeadHours: hours.nullable(),
      reason: supplyQuality.nullable(),
    })
    .readonly(),
).refine(
  ({ payload, subject, observedAt }) =>
    payload.externalSkuId === subject.externalSkuId &&
    payload.announcedAt <= observedAt &&
    matchesSupplyQuality(
      payload.reason,
      payload.inboundQuantity === null,
      payload.newEta === null || payload.promisedLeadHours === null,
    ),
  "Supplier reason must match a gap in the announced measurements",
);

const inventoryPosition = observedFact(
  "INVENTORY_POSITION",
  skuSubject,
  z
    .strictObject({
      ...locationIds,
      asOf: utcMs,
      quarantine: QuantitySchema.nullable(),
      inbound: QuantitySchema.nullable(),
      safetyBufferHours: hours.nullable(),
      reason: supplyQuality.nullable(),
    })
    .readonly(),
).refine(
  ({ payload, subject, observedAt }) =>
    payload.externalSkuId === subject.externalSkuId &&
    payload.asOf <= observedAt &&
    matchesSupplyQuality(
      payload.reason,
      payload.quarantine === null || payload.inbound === null,
      payload.safetyBufferHours === null,
    ),
  "Inventory reason must match a gap in its observed position",
);

const syncTransition = observedFact(
  "SYNC_TRANSITION",
  connectionSubject,
  z
    .strictObject({
      jobId: ExternalIdSchema,
      fence: QuantitySchema,
      stream: z.enum(["PRODUCTS", "ORDERS", "REFUNDS", "INVENTORY", "MARKETING"]),
      status: z.enum(["FAILED", "SUCCEEDED"]),
      errorCode: ConnectorFailureCodeSchema.nullable(),
      successfulThrough: utcMs.nullable(),
      watermark: utcMs.nullable(),
      businessObservedAt: utcMs,
      transitionSequence: sequence,
    })
    .readonly(),
).refine(
  ({ payload, subject, binding, observedAt }) =>
    subject.connectionId === binding.connectionId &&
    payload.businessObservedAt === observedAt &&
    (payload.status === "FAILED" ? payload.errorCode !== null : payload.errorCode === null) &&
    [payload.successfulThrough, payload.watermark].every(
      (time) => time === null || time <= observedAt,
    ),
  "Sync transition must match the connection and its visible status",
);

export const ObservedFactV1Schema = z
  .discriminatedUnion("domain", [
    frozenCost,
    refundAllocation,
    returnReceipt,
    fee,
    traffic,
    campaignMeasurement,
    listing,
    price,
    inventoryLot,
    supplierNotice,
    inventoryPosition,
    syncTransition,
  ])
  .readonly();
export type ObservedFactV1 = z.infer<typeof ObservedFactV1Schema>;

const observedScenarioPlan = MockScenarioPlanSchema.transform((plan) =>
  Object.freeze({
    ...plan,
    mutations: Object.freeze(plan.mutations.map((mutation) => Object.freeze(mutation))),
    delivery: Object.freeze(plan.delivery),
  }),
).nullable();

const latestBusinessInstant = Date.parse("9999-12-31T23:59:59.999Z");
const observedConfig = z
  .strictObject({
    modelVersion,
    binding: ConnectorBindingSchema,
    seed: QuantitySchema.max(4294967295),
    profile: z.enum(["growing", "problematic", "mature", "new"]),
    historyStart: utcMs.refine((time) => time.endsWith("T16:00:00.000Z")),
    days: QuantitySchema.min(1).max(365),
    productCount: QuantitySchema.min(1).max(100),
    variantsPerProduct: QuantitySchema.min(1).max(3),
    dailyOrders: QuantitySchema.min(1).max(300),
    growthBps: BasisPointsSchema,
    refundBps: BasisPointsSchema.max(5000),
    adSpendMinor: MinorAmountSchema.max(100000000),
    scenarioPlan: observedScenarioPlan,
  })
  .refine(
    (config) =>
      config.days * Math.ceil(config.dailyOrders * 1.35) <= 150000 &&
      Date.parse(config.historyStart) + (config.days + 5) * dayMs <= latestBusinessInstant,
    "Generator run exceeds the supported horizon",
  )
  .refine(
    ({ scenarioPlan, productCount, variantsPerProduct, binding, days }) =>
      scenarioPlan === null ||
      (scenarioPlan.externalStoreId === binding.externalStoreId &&
        scenarioPlan.endDay <= days &&
        scenarioPlan.mutations.every(
          ({ skuIndex }) => skuIndex < productCount * variantsPerProduct,
        )),
    "Scenario must belong to the configured store, history and SKU range",
  )
  .readonly();

/**
 * The hash preimage is UTF-8 JSON.stringify of the decoded inner config, including a null
 * scenarioPlan. Schema declaration order fixes the object keys and preserves mutation array order.
 * Generation and configHash live in the envelope. The publisher verifies the hash at runtime.
 */
export const MockObservedGenerationConfigV3Schema = z
  .strictObject({
    generatorVersion: z.literal("mock-source-v3"),
    generation,
    configHash: sha256,
    config: observedConfig,
  })
  .readonly();
export type MockObservedGenerationConfigV3 = z.infer<typeof MockObservedGenerationConfigV3Schema>;

const maxPageRecords = 200;
const maxPages = 4096;
const partitionFields = {
  ...scope,
  domain: ObservedDomainSchema,
  subject: ObservedSubjectSchema,
  window: exactWindow,
};
type Partition = z.infer<z.ZodObject<typeof partitionFields>>;
type Binding = Partition["binding"];
type Window = Partition["window"];

const subjectKinds: Readonly<Record<ObservedDomain, readonly ObservedSubject["kind"][]>> = {
  FROZEN_COST: ["SKU"],
  REFUND_ALLOCATION: ["SKU"],
  RETURN_RECEIPT: ["SKU"],
  FEE: ["STORE"],
  TRAFFIC: ["STORE", "SKU"],
  CAMPAIGN_MEASUREMENT: ["CAMPAIGN"],
  LISTING: ["SKU"],
  PRICE: ["SKU"],
  INVENTORY_LOT: ["SKU"],
  SUPPLIER_NOTICE: ["SKU"],
  INVENTORY_POSITION: ["SKU"],
  SYNC_TRANSITION: ["CONNECTION"],
};

function validPartition({ binding, domain, subject }: Partition): boolean {
  return (
    subjectKinds[domain].includes(subject.kind) &&
    (subject.kind !== "CONNECTION" || subject.connectionId === binding.connectionId)
  );
}

function sameBinding(left: Binding, right: Binding): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.workspaceId === right.workspaceId &&
    left.storeId === right.storeId &&
    left.connectionId === right.connectionId &&
    left.externalStoreId === right.externalStoreId
  );
}

function subjectKey(subject: ObservedSubject): string {
  switch (subject.kind) {
    case "STORE":
      return "STORE";
    case "SKU":
      return "SKU:" + subject.externalSkuId;
    case "CAMPAIGN":
      return "CAMPAIGN:" + subject.externalCampaignId;
    case "CONNECTION":
      return "CONNECTION:" + subject.connectionId;
  }
}

function sameScope(left: Pick<Partition, "binding" | "generation">, right: typeof left): boolean {
  return left.generation === right.generation && sameBinding(left.binding, right.binding);
}

function containsWindow(outer: Window, inner: Window): boolean {
  return (
    inner.periodStart >= outer.periodStart &&
    inner.periodEnd <= outer.periodEnd &&
    inner.timezone === outer.timezone &&
    inner.currency === outer.currency
  );
}

function inPartition(
  fact: ObservedFactV1,
  partition: Partition & { readonly through: string },
): boolean {
  return (
    sameScope(fact, partition) &&
    fact.domain === partition.domain &&
    subjectKey(fact.subject) === subjectKey(partition.subject) &&
    fact.observedAt <= partition.through &&
    (!("window" in fact.payload) || containsWindow(partition.window, fact.payload.window))
  );
}

function boundedArray<T extends z.ZodType>(item: T, limit: number) {
  return z
    .custom<z.input<T>[]>(
      (value) => Array.isArray(value) && value.length <= limit,
      "INVALID_ARRAY_LENGTH",
    )
    .pipe(z.array(item))
    .readonly();
}

const publicationRefFields = { publicationId: ExternalIdSchema, publicationHash: sha256 };
const publicationPins = { modelVersion, configHash: sha256 };
const pageIndex = QuantitySchema.max(maxPages - 1);
const pageRecordCount = QuantitySchema.max(maxPageRecords);
const pageFields = {
  pageId: ExternalIdSchema,
  pageIndex,
  pageHash: sha256,
  priorPageHash: sha256.nullable(),
  expectedCursor: CursorSchema.nullable(),
  nextCursor: CursorSchema.nullable(),
  terminalCoverage: z
    .strictObject({ coverageBasisPoints: BasisPointsSchema })
    .readonly()
    .nullable(),
};

function validPageLinks(page: z.infer<z.ZodObject<typeof pageFields>>): boolean {
  const first = page.pageIndex === 0;
  return (
    (page.priorPageHash === null) === first &&
    (page.expectedCursor === null) === first &&
    (page.nextCursor === null) === (page.terminalCoverage !== null)
  );
}

function validPartitionCutoff(value: Partition & { readonly through: string }): boolean {
  return validPartition(value) && value.window.periodEnd <= value.through;
}

export const ObservedPublicationRequestV1Schema = z
  .strictObject({
    ...partitionFields,
    grantId: ExternalIdSchema,
    ...publicationPins,
    through: utcMs,
    expectedSequence: sequence,
  })
  .refine(validPartitionCutoff, "INVALID_PUBLICATION_PARTITION")
  .readonly();
export type ObservedPublicationRequestV1 = z.infer<typeof ObservedPublicationRequestV1Schema>;

export const ObservedPublicationV1Schema = z
  .strictObject({
    ...partitionFields,
    ...publicationRefFields,
    ...publicationPins,
    producerVersion: SourceVersionSchema,
    through: utcMs,
    clockRevision: QuantitySchema,
    publicationSequence: sequence,
    pageCount: QuantitySchema.min(1).max(maxPages),
    recordCount: QuantitySchema.max(maxPages * maxPageRecords),
    chainHash: sha256,
    availableAt: utcMs,
    recordedAt: utcMs,
  })
  .refine(validPartitionCutoff, "INVALID_PUBLICATION_PARTITION")
  .refine(
    ({ through, availableAt, pageCount, recordCount }) =>
      through <= availableAt &&
      recordCount <= pageCount * maxPageRecords &&
      (recordCount !== 0 || pageCount === 1),
    "INVALID_PUBLICATION_CERTIFICATE",
  )
  .readonly();
export type ObservedPublicationV1 = z.infer<typeof ObservedPublicationV1Schema>;

export const ObservedPublicationReadV1Schema = z
  .strictObject({
    ...partitionFields,
    ...publicationRefFields,
    grantId: ExternalIdSchema,
    pageIndex,
  })
  .refine(validPartition, "INVALID_PUBLICATION_PARTITION")
  .readonly();
export type ObservedPublicationReadV1 = z.infer<typeof ObservedPublicationReadV1Schema>;

function validPageRecords(
  records: readonly ObservedFactV1[],
  partition: Partition & { readonly through: string },
): boolean {
  let lastSequence = 0;
  const ids = new Set<string>();
  for (const record of records) {
    if (
      !inPartition(record, partition) ||
      record.sequence <= lastSequence ||
      ids.has(record.factId)
    )
      return false;
    ids.add(record.factId);
    lastSequence = record.sequence;
  }
  return true;
}

const pageRecords = boundedArray(ObservedFactV1Schema, maxPageRecords);
export const ObservedPublishedPageV1Schema = z
  .strictObject({ publication: ObservedPublicationV1Schema, ...pageFields, records: pageRecords })
  .refine(validPageLinks, "INVALID_PAGE_LINK")
  .refine(
    ({ publication, pageIndex, terminalCoverage, records }) =>
      pageIndex < publication.pageCount &&
      (terminalCoverage !== null) === (pageIndex === publication.pageCount - 1) &&
      records.length <= publication.recordCount &&
      (publication.pageCount !== 1 || records.length === publication.recordCount) &&
      validPageRecords(records, publication) &&
      records.every(
        ({ producerVersion, modelVersion }) =>
          producerVersion === publication.producerVersion &&
          modelVersion === publication.modelVersion,
      ),
    "INVALID_PUBLISHED_PAGE",
  )
  .readonly();
export type ObservedPublishedPageV1 = z.infer<typeof ObservedPublishedPageV1Schema>;

export const AppendObservedPageV1Schema = z
  .strictObject({
    ...partitionFields,
    ...publicationRefFields,
    ...pageFields,
    grantId: ExternalIdSchema,
    fence: QuantitySchema,
    through: utcMs,
    records: pageRecords,
  })
  .refine(validPartitionCutoff, "INVALID_PUBLICATION_PARTITION")
  .refine(validPageLinks, "INVALID_PAGE_LINK")
  .refine((page) => validPageRecords(page.records, page), "INVALID_PAGE_RECORDS")
  .readonly();
export type AppendObservedPageV1 = z.infer<typeof AppendObservedPageV1Schema>;

const memberRefSchema = z
  .strictObject({
    factId: ExternalIdSchema,
    sourceVersion: observedVersion,
    payloadHash: sha256,
    originReceiptId: ExternalIdSchema,
  })
  .readonly();

function validMembership(value: {
  readonly generation: number;
  readonly recordCount: number;
  readonly factRefs: readonly z.infer<typeof memberRefSchema>[];
}): boolean {
  if (value.recordCount !== value.factRefs.length) return false;
  const prefix = "observed-v1:g:" + value.generation + ":e:";
  let lastSequence = 0;
  for (const ref of value.factRefs) {
    if (!ref.sourceVersion.startsWith(prefix)) return false;
    const sequence = Number(ref.sourceVersion.slice(prefix.length));
    if (sequence <= lastSequence) return false;
    lastSequence = sequence;
  }
  return true;
}

export const ObservedReceiptV1Schema = z
  .strictObject({
    ...partitionFields,
    ...publicationRefFields,
    ...publicationPins,
    ...pageFields,
    through: utcMs,
    receiptId: ExternalIdSchema,
    recordedAt: utcMs,
    recordCount: pageRecordCount,
    factRefs: boundedArray(memberRefSchema, maxPageRecords),
  })
  .refine(validPartitionCutoff, "INVALID_PUBLICATION_PARTITION")
  .refine(validPageLinks, "INVALID_PAGE_LINK")
  .refine(validMembership, "INVALID_RECEIPT_MEMBERSHIP")
  .readonly();
export type ObservedReceiptV1 = z.infer<typeof ObservedReceiptV1Schema>;

// The provenance belongs to the original immutable insertion, even across later page membership.
export const StoredObservedFactV1Schema = z
  .strictObject({ fact: ObservedFactV1Schema, receiptId: ExternalIdSchema, recordedAt: utcMs })
  .readonly();
export type StoredObservedFactV1 = z.infer<typeof StoredObservedFactV1Schema>;

const maxCaptureFacts = 50000;
const maxComparisons = 4;
const joinedRevision = z.string().regex(/^p2-observed-v1:[a-f0-9]{64}$/u);
const normalizedRevision = z.string().regex(/^p2-normalized-v1:[a-f0-9]{64}$/u);
const observedDefinition = z.literal("metrics-g4-observed-v2");
const domainList = boundedArray(ObservedDomainSchema, ObservedDomainSchema.options.length)
  .refine(
    (domains) => domains.length > 0 && new Set(domains).size === domains.length,
    "INVALID_DOMAINS",
  )
  .readonly();
const receiptIds = boundedArray(ExternalIdSchema, maxPages)
  .refine((ids) => new Set(ids).size === ids.length, "DUPLICATE_RECEIPT")
  .readonly();
const captureIdentityFields = {
  ...scope,
  window: exactWindow,
  visibleAt: utcMs,
  domains: domainList,
};
const windowCutoffFields = { window: exactWindow, visibleAt: utcMs };
type WindowCutoff = Readonly<{ window: Window; visibleAt: string }>;

function sameWindow(left: Window, right: Window): boolean {
  return (
    left.periodStart === right.periodStart &&
    left.periodEnd === right.periodEnd &&
    left.timezone === right.timezone &&
    left.currency === right.currency
  );
}

function windowKey({ periodStart, periodEnd, timezone, currency }: Window): string {
  return JSON.stringify([periodStart, periodEnd, timezone, currency]);
}

function validComparisons(visibleAt: string, comparisons: readonly WindowCutoff[]): boolean {
  const windows = new Set<string>();
  for (const entry of comparisons) {
    const key = windowKey(entry.window);
    if (entry.window.periodEnd > entry.visibleAt || entry.visibleAt > visibleAt || windows.has(key))
      return false;
    windows.add(key);
  }
  return true;
}

function rawObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function withinArrayBounds(value: unknown, limits: Readonly<Record<string, number>>): boolean {
  const fields = rawObject(value);
  return (
    fields === undefined ||
    Object.entries(limits).every(([key, limit]) => {
      const field = fields[key];
      return !Array.isArray(field) || field.length <= limit;
    })
  );
}

function preflight<T extends z.ZodType>(schema: T, withinBounds: (value: unknown) => boolean) {
  return z.unknown().refine(withinBounds, "OVERFLOW").pipe(schema);
}

const captureRequestFields = {
  ...captureIdentityFields,
  actor: preflight(TenantContextSchema, (actor) => withinArrayBounds(actor, { permissions: 10 }))
    .transform((actor) => ({ ...actor, permissions: Object.freeze(actor.permissions) }))
    .readonly(),
  comparisonWindows: boundedArray(z.strictObject(windowCutoffFields).readonly(), maxComparisons),
};

function validCaptureRequest(value: z.infer<z.ZodObject<typeof captureRequestFields>>): boolean {
  return (
    value.actor.organizationId === value.binding.organizationId &&
    value.actor.workspaceId === value.binding.workspaceId &&
    value.window.periodEnd <= value.visibleAt &&
    validComparisons(value.visibleAt, value.comparisonWindows)
  );
}

function boundedCaptureRequest(value: unknown): boolean {
  return withinArrayBounds(value, {
    domains: ObservedDomainSchema.options.length,
    comparisonWindows: maxComparisons,
  });
}

export const ObservedCaptureRequestV1Schema = preflight(
  z
    .strictObject(captureRequestFields)
    .refine(validCaptureRequest, "INVALID_CAPTURE_REQUEST")
    .readonly(),
  boundedCaptureRequest,
);
export type ObservedCaptureRequestV1 = z.infer<typeof ObservedCaptureRequestV1Schema>;

const readRequestFields = { ...captureRequestFields, inputRevision: joinedRevision };
export const ObservedReadRequestV1Schema = preflight(
  z
    .strictObject(readRequestFields)
    .refine(validCaptureRequest, "INVALID_CAPTURE_REQUEST")
    .readonly(),
  boundedCaptureRequest,
);
export type ObservedReadRequestV1 = z.infer<typeof ObservedReadRequestV1Schema>;

const baseStream = z.enum(["ORDERS", "REFUNDS", "INVENTORY", "MARKETING"]);
const basePageRef = z
  .strictObject({
    stream: baseStream,
    pageId: ExternalIdSchema,
    pageHash: sha256,
  })
  .readonly();

function validBaseReceipts(receipts: readonly z.infer<typeof basePageRef>[]): boolean {
  const streams = new Set<string>();
  const pages = new Set<string>();
  for (const { stream, pageId } of receipts) {
    const key = stream + ":" + pageId;
    if (pages.has(key)) return false;
    pages.add(key);
    streams.add(stream);
  }
  return streams.size === baseStream.options.length;
}

const baseRef = z
  .strictObject({
    ...scope,
    ...windowCutoffFields,
    inputRevision: normalizedRevision,
    receipts: boundedArray(basePageRef, maxPages)
      .refine(validBaseReceipts, "INVALID_BASE_RECEIPTS")
      .readonly(),
  })
  .readonly();
const comparisonRefSchema = z
  .strictObject({
    ...scope,
    ...windowCutoffFields,
    inputRevision: joinedRevision,
    definitionVersion: observedDefinition,
  })
  .readonly();

const coverageSchema = z
  .strictObject({
    ...partitionFields,
    status: z.enum(["COMPLETE", "PARTIAL", "UNAVAILABLE"]),
    coverageBasisPoints: BasisPointsSchema,
    receiptIds,
    reason: MetricIssueCodeSchema.nullable(),
  })
  .refine(validPartition, "INVALID_COVERAGE_PARTITION")
  .refine(({ status, coverageBasisPoints, reason, receiptIds }) => {
    switch (status) {
      case "COMPLETE":
        return coverageBasisPoints === 10000 && reason === null && receiptIds.length > 0;
      case "PARTIAL":
        return coverageBasisPoints < 10000 && reason === "PARTIAL_COVERAGE";
      case "UNAVAILABLE":
        return coverageBasisPoints === 0 && reason !== null;
    }
  }, "INVALID_COVERAGE_STATUS")
  .readonly();

const captureObject = z.strictObject({
  ...captureIdentityFields,
  inputRevision: joinedRevision,
  ledgerVersion: z.literal("observed-facts-v1"),
  mappingVersion: z.literal("p2-observed-v1"),
  definitionVersion: observedDefinition,
  definitionSelectorVersion: SourceVersionSchema,
  ...publicationPins,
  clockRevision: QuantitySchema,
  capturedAt: utcMs,
  base: baseRef.nullable(),
  comparisons: boundedArray(comparisonRefSchema, maxComparisons),
  publications: boundedArray(ObservedPublicationV1Schema, maxPages),
  receipts: boundedArray(ObservedReceiptV1Schema, maxPages),
  facts: boundedArray(StoredObservedFactV1Schema, maxCaptureFacts),
  coverage: boundedArray(coverageSchema, maxPages),
});
type Capture = z.infer<typeof captureObject>;
type Coverage = z.infer<typeof coverageSchema>;
type Member = z.infer<typeof memberRefSchema>;

function boundedCapture(value: unknown): boolean {
  return (
    withinArrayBounds(value, {
      domains: ObservedDomainSchema.options.length,
      comparisons: maxComparisons,
      publications: maxPages,
      receipts: maxPages,
      facts: maxCaptureFacts,
      coverage: maxPages,
    }) && withinArrayBounds(rawObject(value)?.base, { receipts: maxPages })
  );
}

function validCaptureIdentity(capture: Capture): boolean {
  const { window, visibleAt, domains, base, comparisons, inputRevision } = capture;
  if (window.periodEnd > visibleAt || !validComparisons(visibleAt, comparisons)) return false;
  if (base === null) {
    if (domains.some((domain) => domain !== "SYNC_TRANSITION")) return false;
  } else if (
    !sameScope(capture, base) ||
    !sameWindow(window, base.window) ||
    visibleAt !== base.visibleAt
  ) {
    return false;
  }
  const revisions = new Set([inputRevision]);
  for (const comparison of comparisons) {
    if (!sameScope(capture, comparison) || revisions.has(comparison.inputRevision)) return false;
    revisions.add(comparison.inputRevision);
  }
  return true;
}

function samePartition(left: Partition, right: Partition): boolean {
  return (
    sameScope(left, right) &&
    left.domain === right.domain &&
    subjectKey(left.subject) === subjectKey(right.subject) &&
    sameWindow(left.window, right.window)
  );
}

function partitionKey(value: Pick<Partition, "domain" | "subject">): string {
  return value.domain + ":" + subjectKey(value.subject);
}

function currentPublications(capture: Capture): Map<string, ObservedPublicationV1> | undefined {
  const publications = new Map<string, ObservedPublicationV1>();
  const domains = new Set(capture.domains);
  for (const publication of capture.publications) {
    if (
      publications.has(publication.publicationId) ||
      !sameScope(publication, capture) ||
      !domains.has(publication.domain) ||
      publication.modelVersion !== capture.modelVersion ||
      publication.configHash !== capture.configHash ||
      publication.availableAt > capture.visibleAt ||
      publication.through > capture.visibleAt
    )
      return undefined;
    publications.set(publication.publicationId, publication);
  }
  return publications;
}

function matchesPublication(
  receipt: ObservedReceiptV1,
  publication: ObservedPublicationV1,
): boolean {
  return (
    samePartition(receipt, publication) &&
    receipt.publicationHash === publication.publicationHash &&
    receipt.modelVersion === publication.modelVersion &&
    receipt.configHash === publication.configHash &&
    receipt.through === publication.through &&
    receipt.pageIndex < publication.pageCount &&
    (receipt.terminalCoverage !== null) === (receipt.pageIndex === publication.pageCount - 1) &&
    receipt.recordCount <= publication.recordCount &&
    (publication.pageCount !== 1 || receipt.recordCount === publication.recordCount)
  );
}

type CertifiedReceipt = Readonly<{
  receipt: ObservedReceiptV1;
  publication: ObservedPublicationV1;
  members: ReadonlyMap<string, Member>;
}>;

function certifiedReceipts(
  receipts: readonly ObservedReceiptV1[],
  publications: ReadonlyMap<string, ObservedPublicationV1>,
): Map<string, CertifiedReceipt> | undefined {
  const result = new Map<string, CertifiedReceipt>();
  const pageIndices = new Set<string>();
  const pageIds = new Set<string>();
  for (const receipt of receipts) {
    const publication = publications.get(receipt.publicationId);
    const pageIndex = JSON.stringify([receipt.publicationId, receipt.pageIndex]);
    const pageId = JSON.stringify([receipt.publicationId, receipt.pageId]);
    if (
      !publication ||
      !matchesPublication(receipt, publication) ||
      result.has(receipt.receiptId) ||
      pageIndices.has(pageIndex) ||
      pageIds.has(pageId)
    )
      return undefined;
    pageIndices.add(pageIndex);
    pageIds.add(pageId);
    result.set(receipt.receiptId, {
      publication,
      receipt,
      members: new Map(receipt.factRefs.map((member) => [member.sourceVersion, member])),
    });
  }
  return result;
}

function chainContinues(next: ObservedReceiptV1, previous: ObservedReceiptV1): boolean {
  return (
    next.publicationId === previous.publicationId &&
    next.pageIndex === previous.pageIndex + 1 &&
    next.priorPageHash === previous.pageHash &&
    next.expectedCursor === previous.nextCursor
  );
}

function completeChain(chain: readonly CertifiedReceipt[]): boolean {
  const first = chain[0];
  const last = chain.at(-1);
  if (
    !first ||
    !last ||
    first.receipt.pageIndex !== 0 ||
    last.receipt.terminalCoverage?.coverageBasisPoints !== 10000 ||
    chain.length !== first.publication.pageCount
  )
    return false;
  const ids = new Set<string>();
  let previous: ObservedReceiptV1 | undefined;
  let lastSequence = 0;
  let records = 0;
  for (const { receipt } of chain) {
    if (previous && !chainContinues(receipt, previous)) return false;
    for (const { factId, sourceVersion } of receipt.factRefs) {
      const sequence = Number(sourceVersion.slice(sourceVersion.lastIndexOf(":") + 1));
      if (ids.has(factId) || sequence <= lastSequence) return false;
      ids.add(factId);
      lastSequence = sequence;
    }
    records += receipt.recordCount;
    previous = receipt;
  }
  return records === first.publication.recordCount;
}

function selectedVersionKey(domain: ObservedDomain, sourceVersion: string): string {
  return domain + ":" + sourceVersion;
}

function selectedVersions(capture: Capture): Map<string, StoredObservedFactV1> | undefined {
  const selected = new Map<string, StoredObservedFactV1>();
  const identities = new Set<string>();
  for (const stored of capture.facts) {
    const { fact } = stored;
    const version = selectedVersionKey(fact.domain, fact.sourceVersion);
    const identity = fact.domain + ":" + fact.factId;
    if (
      !sameScope(fact, capture) ||
      fact.observedAt > capture.visibleAt ||
      selected.has(version) ||
      identities.has(identity)
    )
      return undefined;
    identities.add(identity);
    selected.set(version, stored);
  }
  return selected;
}

function matchesMember(fact: ObservedFactV1, ref: Member, claim: CertifiedReceipt): boolean {
  return (
    fact.factId === ref.factId &&
    fact.sourceVersion === ref.sourceVersion &&
    fact.payloadHash === ref.payloadHash &&
    inPartition(fact, claim.publication) &&
    fact.modelVersion === claim.publication.modelVersion &&
    fact.producerVersion === claim.publication.producerVersion
  );
}

function consistentReceiptClaims(
  receipts: ReadonlyMap<string, CertifiedReceipt>,
  selected: ReadonlyMap<string, StoredObservedFactV1>,
): boolean {
  // Receipt and certificate scopes already match the capture; source positions span windows.
  const claims = new Map<string, CertifiedReceipt>();
  for (const claim of receipts.values()) {
    const { receipt, publication } = claim;
    for (const member of receipt.factRefs) {
      const key = selectedVersionKey(receipt.domain, member.sourceVersion);
      const prior = claims.get(key);
      const priorMember = prior?.members.get(member.sourceVersion);
      if (
        prior &&
        (priorMember?.factId !== member.factId ||
          priorMember.payloadHash !== member.payloadHash ||
          priorMember.originReceiptId !== member.originReceiptId ||
          subjectKey(prior.receipt.subject) !== subjectKey(receipt.subject) ||
          prior.publication.producerVersion !== publication.producerVersion)
      )
        return false;
      const stored = selected.get(key);
      if (
        stored &&
        (stored.receiptId !== member.originReceiptId || !matchesMember(stored.fact, member, claim))
      )
        return false;
      if (!prior) claims.set(key, claim);
    }
  }
  return true;
}

type CaptureGraph = Readonly<{
  receipts: ReadonlyMap<string, CertifiedReceipt>;
  selected: ReadonlyMap<string, StoredObservedFactV1>;
  usedReceipts: Set<string>;
  matchedVersions: Set<string>;
}>;

function validateMembers(
  claim: CertifiedReceipt,
  coverage: Coverage,
  graph: CaptureGraph,
): boolean {
  for (const member of claim.receipt.factRefs) {
    const key = selectedVersionKey(coverage.domain, member.sourceVersion);
    const stored = graph.selected.get(key);
    if (!stored) {
      if (coverage.status === "COMPLETE") return false;
      continue;
    }
    if (stored.receiptId !== member.originReceiptId || !matchesMember(stored.fact, member, claim))
      return false;
    const origin = graph.receipts.get(stored.receiptId);
    const originMember = origin?.members.get(stored.fact.sourceVersion);
    if (
      !origin ||
      !originMember ||
      originMember.originReceiptId !== stored.receiptId ||
      !matchesMember(stored.fact, originMember, origin)
    )
      return false;
    graph.usedReceipts.add(stored.receiptId);
    graph.matchedVersions.add(key);
  }
  return true;
}

function validCaptureCoverage(capture: Capture, graph: CaptureGraph): boolean {
  const partitions = new Set<string>();
  const missingDomains = new Set(capture.domains);
  const domains = new Set(capture.domains);
  for (const coverage of capture.coverage) {
    const key = partitionKey(coverage);
    if (
      partitions.has(key) ||
      !domains.has(coverage.domain) ||
      !sameScope(coverage, capture) ||
      !sameWindow(coverage.window, capture.window)
    )
      return false;
    partitions.add(key);
    missingDomains.delete(coverage.domain);
    const chain = [];
    for (const id of coverage.receiptIds) {
      const claim = graph.receipts.get(id);
      if (
        !claim ||
        !samePartition(coverage, claim.receipt) ||
        !validateMembers(claim, coverage, graph)
      )
        return false;
      graph.usedReceipts.add(id);
      chain.push(claim);
    }
    if (coverage.status === "COMPLETE" && !completeChain(chain)) return false;
  }
  return missingDomains.size === 0;
}

function validCaptureGraph(capture: Capture): boolean {
  const publications = currentPublications(capture);
  if (!publications) return false;
  const receipts = certifiedReceipts(capture.receipts, publications);
  const selected = selectedVersions(capture);
  if (!receipts || !selected) return false;
  const graph = {
    receipts,
    selected,
    usedReceipts: new Set<string>(),
    matchedVersions: new Set<string>(),
  };
  return (
    validCaptureCoverage(capture, graph) &&
    graph.matchedVersions.size === selected.size &&
    graph.usedReceipts.size === receipts.size &&
    new Set(capture.receipts.map(({ publicationId }) => publicationId)).size ===
      publications.size &&
    consistentReceiptClaims(receipts, selected)
  );
}

export const ObservedCaptureV1Schema = preflight(
  captureObject
    .refine(validCaptureIdentity, "INVALID_CAPTURE_IDENTITY")
    .refine(validCaptureGraph, "INVALID_CAPTURE_GRAPH")
    .readonly(),
  boundedCapture,
);
export type ObservedCaptureV1 = z.infer<typeof ObservedCaptureV1Schema>;

const metricKind = MetricCoverageV1Schema.unwrap().shape.kind;
export const ObservedSelectionRequestV1Schema = preflight(
  z
    .strictObject({ ...readRequestFields, subject: MetricSubjectSchema, kind: metricKind })
    .refine(validCaptureRequest, "INVALID_CAPTURE_REQUEST")
    .readonly(),
  boundedCaptureRequest,
);
export type ObservedSelectionRequestV1 = z.infer<typeof ObservedSelectionRequestV1Schema>;

const metricCollections = MetricCollectionSchema.options;
type MetricCollection = (typeof metricCollections)[number];

function arrayValues(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function boundedMetricFact(value: unknown): boolean {
  const row = rawObject(value);
  const data = rawObject(row?.data);
  return (
    withinArrayBounds(row, { evidenceIds: maxPages }) &&
    withinArrayBounds(row?.measuredCoverage, { evidenceIds: maxPages }) &&
    withinArrayBounds(data, { items: 500 }) &&
    withinArrayBounds(rawObject(data?.source)?.quality, { issues: 9 })
  );
}

function boundedMetricInput(value: unknown): boolean {
  if (!withinArrayBounds(value, { evidenceIds: maxPages, metricCoverage: maxPages })) return false;
  const input = rawObject(value);
  const groups = metricCollections.map((key) => arrayValues(input?.[key]));
  const count = groups.reduce((total, group) => total + group.length, 0);
  return (
    count <= maxCaptureFacts &&
    arrayValues(input?.metricCoverage).every((coverage) =>
      withinArrayBounds(coverage, { evidenceIds: maxPages, collections: metricCollections.length }),
    ) &&
    groups.every((group) => group.every(boundedMetricFact))
  );
}

function boundedScopedInput(value: unknown): boolean {
  return (
    withinArrayBounds(value, { selectionReceiptIds: maxPages }) &&
    boundedMetricInput(rawObject(value)?.input)
  );
}

const paymentCollections = ["paymentFacts"] as const;
const settledCollections = ["paymentFacts", "refundFacts"] as const;
const costCollections = [
  ...settledCollections,
  "frozenCosts",
  "refundAllocations",
  "returnReceipts",
] as const;
const contributionCollections = [...costCollections, "fees"] as const;

// The new projection must provide the source collections required by the existing metric leaves.
const neededCollections: Readonly<Record<z.infer<typeof metricKind>, readonly MetricCollection[]>> =
  {
    GMV: paymentCollections,
    PAID_REVENUE: paymentCollections,
    AOV: paymentCollections,
    PAID_ORDERS: paymentCollections,
    PAID_UNITS: paymentCollections,
    REFUND_SETTLED_AMOUNT: ["refundFacts"],
    NET_REVENUE_SETTLEMENT: settledCollections,
    REFUNDED_COHORT_ORDERS: settledCollections,
    REFUND_COHORT_ORDER_RATE: settledCollections,
    REFUND_COHORT_AMOUNT_RATE: settledCollections,
    NET_MERCHANDISE_REVENUE: [...settledCollections, "refundAllocations"],
    COGS: costCollections,
    GROSS_PROFIT: costCollections,
    CONTRIBUTION: contributionCollections,
    ESTIMATED_NET_PROFIT: contributionCollections,
    PROFIT_DELTA: contributionCollections,
    INVENTORY_AVAILABLE: ["inventoryFacts"],
    INVENTORY_HOURS_REMAINING: ["inventoryFacts", "paymentFacts", "inventoryExtensions"],
    LEAD_TIME_HOURS: ["inventoryExtensions"],
    CONVERSION_RATE: ["traffic"],
    CART_RATE: ["traffic"],
    CHECKOUT_RATE: ["traffic"],
    ROAS: ["campaignFacts"],
  };

const scopedMetricObject = z.strictObject({
  subject: MetricSubjectSchema,
  input: MetricInputV1Schema,
  selectionReceiptIds: receiptIds
    .refine((ids) => ids.length > 0, "MISSING_SELECTION_RECEIPT")
    .readonly(),
});
type ScopedInput = z.infer<typeof scopedMetricObject>;

function verifiedScopedSources(input: MetricInputV1, coverage: number): boolean {
  return (
    coverage === 10000 &&
    input.sourceWatermark !== null &&
    Date.parse(input.sourceWatermark) >= Date.parse(input.periodEnd) &&
    metricCollections.every((key) => (input[key] ?? []).every(({ data }) => data !== null)) &&
    (input.traffic ?? []).every(({ data }) => data !== null && fullTraffic(data)) &&
    (input.campaignFacts ?? []).every(
      ({ data, measuredCoverage }) =>
        measuredCoverage?.coverageBasisPoints === 10000 &&
        data.spendMinor !== null &&
        data.attributedRevenueMinor !== null,
    )
  );
}

function validScopedInput({ subject, input }: ScopedInput): boolean {
  if (
    !joinedRevision.safeParse(input.inputRevision).success ||
    input.definitionVersion !== observedDefinition.value
  )
    return false;
  const [coverage] = input.metricCoverage;
  if (!coverage) return input.status === "UNAVAILABLE";
  if (input.metricCoverage.length !== 1 || subjectKey(coverage.subject) !== subjectKey(subject))
    return false;
  if (input.status === "VERIFIED" && !verifiedScopedSources(input, coverage.coverageBasisPoints))
    return false;
  const collections = new Set(coverage.collections);
  return (
    neededCollections[coverage.kind].every((key) => collections.has(key)) &&
    metricCollections.every((key) => collections.has(key) === (input[key] !== null))
  );
}

export const ScopedMetricInputV1Schema = preflight(
  scopedMetricObject.refine(validScopedInput, "INVALID_METRIC_PROJECTION").readonly(),
  boundedScopedInput,
);
export type ScopedMetricInputV1 = z.infer<typeof ScopedMetricInputV1Schema>;

const selectionProofObject = z.strictObject({
  request: ObservedSelectionRequestV1Schema,
  capture: ObservedCaptureV1Schema,
  selection: ScopedMetricInputV1Schema,
});
type SelectionProof = z.infer<typeof selectionProofObject>;

function boundedSelectionProof(value: unknown): boolean {
  const proof = rawObject(value);
  return (
    boundedCaptureRequest(proof?.request) &&
    boundedCapture(proof?.capture) &&
    boundedScopedInput(proof?.selection)
  );
}

function matchingRequest({ request, capture, selection }: SelectionProof): boolean {
  const { input, subject } = selection;
  const [coverage] = input.metricCoverage;
  const domains = new Set(capture.domains);
  const comparisons = new Map(
    capture.comparisons.map((ref) => [windowKey(ref.window), ref.visibleAt]),
  );
  return (
    coverage !== undefined &&
    coverage.kind === request.kind &&
    subjectKey(subject) === subjectKey(request.subject) &&
    sameScope(request, capture) &&
    sameBinding(request.binding, input.binding) &&
    sameWindow(request.window, capture.window) &&
    sameWindow(request.window, input) &&
    request.visibleAt === capture.visibleAt &&
    request.visibleAt === input.visibleAt &&
    request.inputRevision === capture.inputRevision &&
    request.inputRevision === input.inputRevision &&
    input.definitionVersion === capture.definitionVersion &&
    request.domains.length === domains.size &&
    request.domains.every((domain) => domains.has(domain)) &&
    request.comparisonWindows.length === comparisons.size &&
    request.comparisonWindows.every(
      (ref) => comparisons.get(windowKey(ref.window)) === ref.visibleAt,
    )
  );
}

type BaseStream = z.infer<typeof baseStream>;
type MetricRow = Readonly<{
  sourceVersion: string;
  observedAt: string;
  evidenceIds: readonly string[];
}>;
type SelectedSource = Readonly<{ fact: ObservedFactV1; receiptIds: Set<string> }>;
type SelectionGraph = Readonly<{
  proof: SelectionProof;
  complete: boolean;
  verified: boolean;
  ids: ReadonlySet<string>;
  used: Set<string>;
  receiptById: ReadonlyMap<string, ObservedReceiptV1>;
  versions: ReadonlyMap<string, StoredObservedFactV1>;
  baseStreams: ReadonlyMap<BaseStream, ReadonlySet<string>>;
  orderLines: ReadonlySet<string>;
  orderSkus: ReadonlySet<string>;
  refundOrders: ReadonlyMap<string, MetricRefundFact["data"]>;
}>;

function lineKey(orderId: string, lineId: string, skuId: string): string {
  return JSON.stringify([orderId, lineId, skuId]);
}

function baseStreamsFor(proof: SelectionProof, ids: ReadonlySet<string>) {
  const observedIds = new Set(proof.capture.receipts.map(({ receiptId }) => receiptId));
  const indexed = new Map<BaseStream, Set<string>>();
  const assigned = new Set<string>();
  for (const { stream, pageId } of proof.capture.base?.receipts ?? []) {
    if (ids.has(pageId) && (observedIds.has(pageId) || assigned.has(pageId))) return undefined;
    const pages = indexed.get(stream) ?? new Set<string>();
    pages.add(pageId);
    indexed.set(stream, pages);
    assigned.add(pageId);
  }
  return indexed;
}

function indexOrderLines(input: MetricInputV1) {
  const orderLines = new Set<string>();
  const orderSkus = new Set<string>();
  for (const { data } of input.paymentFacts ?? []) {
    for (const line of data.items) {
      orderSkus.add(line.externalSkuId);
      orderLines.add(lineKey(data.externalOrderId, line.externalLineId, line.externalSkuId));
    }
  }
  return { orderLines, orderSkus };
}

function createSelectionGraph(proof: SelectionProof): SelectionGraph | undefined {
  const { capture, selection } = proof;
  const { input } = selection;
  const [coverage] = input.metricCoverage;
  const ids = new Set(selection.selectionReceiptIds);
  const baseStreams = baseStreamsFor(proof, ids);
  const versions = selectedVersions(capture);
  if (
    !coverage ||
    !baseStreams ||
    !versions ||
    coverage.evidenceIds.length !== ids.size ||
    !coverage.evidenceIds.every((id) => ids.has(id)) ||
    !input.evidenceIds.every((id) => ids.has(id))
  )
    return undefined;
  return {
    proof,
    ids,
    baseStreams,
    versions,
    ...indexOrderLines(input),
    complete: coverage.coverageBasisPoints === 10000,
    verified: input.status === "VERIFIED",
    used: new Set(),
    receiptById: new Map(capture.receipts.map((entry) => [entry.receiptId, entry])),
    refundOrders: new Map(
      (input.refundFacts ?? []).map(({ data }) => [data.externalRefundId, data]),
    ),
  };
}

function witnessIds(
  graph: SelectionGraph,
  allowed: Iterable<string>,
  all: boolean,
): Set<string> | undefined {
  const used = new Set<string>();
  for (const id of allowed) {
    if (graph.ids.has(id)) used.add(id);
    else if (all) return undefined;
  }
  for (const id of used) graph.used.add(id);
  return used.size > 0 ? used : undefined;
}

function baseWitness(graph: SelectionGraph, stream: BaseStream, all = graph.complete) {
  return witnessIds(graph, graph.baseStreams.get(stream) ?? [], all);
}

function evidenceMatches(
  ids: readonly string[],
  primary: ReadonlySet<string>,
  additional?: ReadonlySet<string>,
): boolean {
  return (
    ids.some((id) => primary.has(id)) &&
    ids.every((id) => primary.has(id) || (additional?.has(id) ?? false))
  );
}

function matchesProvenance(
  row: MetricRow,
  source: SelectedSource,
  additional?: ReadonlySet<string>,
): boolean {
  return (
    row.sourceVersion === source.fact.sourceVersion &&
    row.observedAt === source.fact.observedAt &&
    evidenceMatches(row.evidenceIds, source.receiptIds, additional)
  );
}

type ProjectedSources = ReadonlyMap<string, SelectedSource>;

function addObservedMembers(
  graph: SelectionGraph,
  entry: Coverage,
  allowed: ReadonlySet<string>,
  sources: Map<string, SelectedSource>,
): void {
  for (const id of allowed) {
    const receipt = graph.receiptById.get(id);
    for (const member of receipt?.factRefs ?? []) {
      const key = selectedVersionKey(entry.domain, member.sourceVersion);
      const stored = graph.versions.get(key);
      if (
        !stored ||
        stored.fact.factId !== member.factId ||
        stored.fact.payloadHash !== member.payloadHash ||
        subjectKey(stored.fact.subject) !== subjectKey(entry.subject)
      )
        continue;
      const existing = sources.get(key);
      if (existing) existing.receiptIds.add(id);
      else sources.set(key, { fact: stored.fact, receiptIds: new Set([id]) });
    }
  }
}

function observedSources(
  graph: SelectionGraph,
  eligible: readonly Coverage[],
): ProjectedSources | undefined {
  if (eligible.length === 0) return undefined;
  const [metricCoverage] = graph.proof.selection.input.metricCoverage;
  const sources = new Map<string, SelectedSource>();
  for (const entry of eligible) {
    if (
      !metricCoverage ||
      entry.status === "UNAVAILABLE" ||
      entry.coverageBasisPoints < metricCoverage.coverageBasisPoints
    )
      return undefined;
    const ids = witnessIds(graph, entry.receiptIds, entry.status === "COMPLETE");
    if (!ids) return undefined;
    addObservedMembers(graph, entry, ids, sources);
  }
  return sources;
}

function coverageFor(graph: SelectionGraph, domain: ObservedDomain): Coverage[] {
  const { request, capture } = graph.proof;
  const { subject, kind } = request;
  return capture.coverage.filter((entry) => {
    if (entry.domain !== domain) return false;
    if (subjectKey(entry.subject) === subjectKey(subject)) return true;
    if (subject.kind !== "STORE") return false;
    if (domain === "CAMPAIGN_MEASUREMENT" && kind === "ROAS")
      return entry.subject.kind === "CAMPAIGN";
    return (
      (domain === "FROZEN_COST" || domain === "REFUND_ALLOCATION" || domain === "RETURN_RECEIPT") &&
      entry.subject.kind === "SKU" &&
      graph.orderSkus.has(entry.subject.externalSkuId)
    );
  });
}

function sourceFor(sources: ProjectedSources, domain: ObservedDomain, row: MetricRow) {
  return sources.get(selectedVersionKey(domain, row.sourceVersion));
}

type TrafficData = NonNullable<MetricTraffic["data"]>;
function fullTraffic(
  data: Pick<TrafficData, "visitors" | "cart" | "checkout" | "paidOrders" | "coverageBasisPoints">,
): boolean {
  return (
    data.coverageBasisPoints === 10000 &&
    [data.visitors, data.cart, data.checkout, data.paidOrders].every((value) => value !== null)
  );
}

function trafficMatches(
  row: MetricTraffic,
  source: SelectedSource,
  graph: SelectionGraph,
): boolean {
  const { fact } = source;
  const { data } = row;
  if (
    fact.domain !== "TRAFFIC" ||
    !data ||
    !matchesProvenance(row, source) ||
    !sameWindow(data, graph.proof.request.window) ||
    !sameWindow(data, fact.payload.window)
  )
    return false;
  const { visitors, cart, checkout, paidOrders, coverageBasisPoints } = fact.payload;
  return (
    (!graph.verified || (fact.payload.reason === null && fullTraffic(fact.payload))) &&
    data.visitors === visitors &&
    data.cart === cart &&
    data.checkout === checkout &&
    data.paidOrders === paidOrders &&
    data.coverageBasisPoints === coverageBasisPoints
  );
}

function validTrafficProjection(graph: SelectionGraph): boolean {
  const rows = graph.proof.selection.input.traffic ?? [];
  const sources = observedSources(graph, coverageFor(graph, "TRAFFIC"));
  if (!sources || rows.length !== sources.size || rows.length > 1) return false;
  const [row] = rows;
  if (!row) return graph.complete;
  const source = sourceFor(sources, "TRAFFIC", row);
  return source !== undefined && trafficMatches(row, source, graph);
}

function shanghaiDayIntersection(date: string, measured: Window, window: Window): boolean {
  const start = Date.parse(measured.periodStart);
  const end = Date.parse(measured.periodEnd);
  const windowStart = Date.parse(window.periodStart);
  const windowEnd = Date.parse(window.periodEnd);
  return (
    withinBusinessDate(date, measured) &&
    (start === windowStart || shanghaiBusinessDate(start - 1) !== date) &&
    (end === windowEnd || shanghaiBusinessDate(end) !== date)
  );
}

type CampaignPayload = Extract<ObservedFactV1, { domain: "CAMPAIGN_MEASUREMENT" }>["payload"];
function knownCampaign(payload: CampaignPayload): boolean {
  return (
    payload.reason === null &&
    payload.coverageBasisPoints === 10000 &&
    [
      payload.spendMinor,
      payload.attributedRevenueMinor,
      payload.eligibleCount,
      payload.measuredCount,
    ].every((value) => value !== null)
  );
}

function campaignMatches(
  row: MetricCampaignFact,
  source: SelectedSource,
  marketing: ReadonlySet<string>,
  graph: SelectionGraph,
): boolean {
  const { fact } = source;
  const { data, measuredCoverage } = row;
  if (
    fact.domain !== "CAMPAIGN_MEASUREMENT" ||
    !matchesProvenance(row, source, marketing) ||
    !row.evidenceIds.some((id) => marketing.has(id))
  )
    return false;
  const { payload } = fact;
  if (
    data.externalCampaignId !== payload.externalCampaignId ||
    data.date !== payload.businessDate ||
    data.spendMinor !== payload.spendMinor ||
    data.attributedRevenueMinor !== payload.attributedRevenueMinor ||
    data.currency !== payload.currency
  )
    return false;
  if (
    !measuredCoverage ||
    !matchesProvenance(measuredCoverage, source, marketing) ||
    !sameWindow(measuredCoverage, payload.window) ||
    measuredCoverage.coverageBasisPoints !== payload.coverageBasisPoints
  )
    return false;
  return (
    !graph.complete ||
    (knownCampaign(payload) &&
      shanghaiDayIntersection(data.date, measuredCoverage, graph.proof.request.window))
  );
}

function validCampaignProjection(graph: SelectionGraph): boolean {
  const { request, selection } = graph.proof;
  const rows = selection.input.campaignFacts ?? [];
  const storeRoaS = request.subject.kind === "STORE" && request.kind === "ROAS";
  if (request.subject.kind !== "CAMPAIGN" && !storeRoaS) return false;
  const eligible = coverageFor(graph, "CAMPAIGN_MEASUREMENT");
  const sources = observedSources(graph, eligible);
  const marketing = baseWitness(graph, "MARKETING", storeRoaS && graph.complete);
  if (!sources || !marketing || rows.length === 0 || rows.length !== sources.size) return false;
  const campaignDays = new Set<string>();
  for (const row of rows) {
    const key = JSON.stringify([row.data.externalCampaignId, row.data.date]);
    const source = sourceFor(sources, "CAMPAIGN_MEASUREMENT", row);
    if (campaignDays.has(key) || !source || !campaignMatches(row, source, marketing, graph))
      return false;
    campaignDays.add(key);
  }
  return true;
}

function baseFacts<T extends MetricRow>(
  graph: SelectionGraph,
  stream: BaseStream,
  rows: readonly T[],
  identity: (row: T) => string,
  eligible: (row: T) => boolean,
): boolean {
  const witness = baseWitness(graph, stream);
  if (!witness || (!graph.complete && rows.length === 0)) return false;
  const seen = new Set<string>();
  for (const row of rows) {
    const key = identity(row);
    if (seen.has(key) || !evidenceMatches(row.evidenceIds, witness) || !eligible(row)) return false;
    seen.add(key);
  }
  return true;
}

function hasProviderIssue(issues: readonly string[], missing: string): boolean {
  return (
    issues.includes(missing) ||
    issues.includes("SOURCE_INCONSISTENT") ||
    issues.includes("SOURCE_TIME_MISSING")
  );
}

function validPayments(graph: SelectionGraph): boolean {
  const { subject, input } = graph.proof.selection;
  if (subject.kind === "CAMPAIGN") return false;
  return baseFacts(
    graph,
    "ORDERS",
    input.paymentFacts ?? [],
    ({ data }) => data.externalOrderId,
    ({ data }) => {
      if (
        subject.kind === "SKU" &&
        !data.items.some((line) => line.externalSkuId === subject.externalSkuId)
      )
        return false;
      return (
        !graph.verified ||
        (!hasProviderIssue(data.source.quality.issues, "PAYMENT_UNKNOWN") &&
          data.paidMinor !== null &&
          (data.paidAt !== null ||
            (data.paidMinor === 0 && !["PAID", "FULFILLED", "COMPLETED"].includes(data.status))))
      );
    },
  );
}

function skuRefunds(graph: SelectionGraph, skuId: string): ReadonlySet<string> {
  const eligible = new Set<string>();
  for (const { data } of graph.proof.selection.input.refundAllocations ?? []) {
    if (
      data?.externalSkuId === skuId &&
      graph.orderLines.has(lineKey(data.externalOrderId, data.externalLineId, skuId))
    ) {
      eligible.add(JSON.stringify([data.externalOrderId, data.externalRefundId]));
    }
  }
  return eligible;
}

function validRefunds(graph: SelectionGraph): boolean {
  const { subject, input } = graph.proof.selection;
  if (subject.kind === "CAMPAIGN") return false;
  const eligible =
    subject.kind === "SKU" ? skuRefunds(graph, subject.externalSkuId) : new Set<string>();
  return baseFacts(
    graph,
    "REFUNDS",
    input.refundFacts ?? [],
    ({ data }) => data.externalRefundId,
    ({ data }) => {
      if (
        subject.kind === "SKU" &&
        data.externalSkuId !== subject.externalSkuId &&
        (data.externalSkuId !== null ||
          !eligible.has(JSON.stringify([data.externalOrderId, data.externalRefundId])))
      )
        return false;
      return (
        !graph.verified ||
        (!hasProviderIssue(data.source.quality.issues, "REFUND_UNKNOWN") &&
          (data.status !== "SUCCEEDED" ||
            (data.succeededAt !== null && data.succeededMinor !== null)))
      );
    },
  );
}

function validInventory(graph: SelectionGraph): boolean {
  const { subject, input } = graph.proof.selection;
  if (subject.kind === "CAMPAIGN") return false;
  return baseFacts(
    graph,
    "INVENTORY",
    input.inventoryFacts ?? [],
    ({ data }) => JSON.stringify([data.externalSkuId, data.externalLocationId]),
    ({ data }) =>
      (subject.kind !== "SKU" || data.externalSkuId === subject.externalSkuId) &&
      (!graph.verified ||
        (!hasProviderIssue(data.source.quality.issues, "INVENTORY_UNKNOWN") &&
          !data.source.quality.issues.includes("INVENTORY_STALE") &&
          [data.available, data.reserved, data.onHand].every((quantity) => quantity !== null))),
  );
}

type FinancialDomain = "FROZEN_COST" | "REFUND_ALLOCATION" | "RETURN_RECEIPT";
type FinancialFact = Extract<ObservedFactV1, { domain: FinancialDomain }>;

function sameData(actual: object | null, expected: object): boolean {
  const fields = rawObject(actual);
  return (
    fields !== undefined &&
    Object.keys(fields).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => fields[key] === value)
  );
}

function matchesFinancialLine(fact: FinancialFact, graph: SelectionGraph): boolean {
  const { externalOrderId, externalLineId, externalSkuId } = fact.payload;
  if (!graph.orderLines.has(lineKey(externalOrderId, externalLineId, externalSkuId))) return false;
  if (fact.domain === "FROZEN_COST") return true;
  const refund = graph.refundOrders.get(fact.payload.externalRefundId);
  return (
    refund !== undefined &&
    refund.externalOrderId === externalOrderId &&
    (refund.externalSkuId === null || refund.externalSkuId === externalSkuId)
  );
}

const financialLineFields = ["externalOrderId", "externalLineId", "externalSkuId"] as const;

function matchesFields<T extends object>(
  data: object | null,
  payload: T,
  keys: readonly (keyof T & string)[],
): boolean {
  const fields = rawObject(data);
  return (
    fields !== undefined &&
    Object.keys(fields).length === keys.length &&
    keys.every((key) => fields[key] === payload[key])
  );
}

function financialDataMatches(
  fact: FinancialFact,
  data: object | null,
  verified: boolean,
): boolean {
  if (verified && fact.payload.reason !== null) return false;
  switch (fact.domain) {
    case "FROZEN_COST":
      return matchesFields(data, fact.payload, [
        ...financialLineFields,
        "quantity",
        "frozenAt",
        "skuCostVersion",
        "unitCostMinor",
        "basis",
        "currency",
      ]);
    case "REFUND_ALLOCATION":
      return matchesFields(data, fact.payload, [
        ...financialLineFields,
        "externalRefundId",
        "merchandiseMinor",
        "buyerShippingMinor",
        "currency",
      ]);
    case "RETURN_RECEIPT":
      return matchesFields(data, fact.payload, [
        ...financialLineFields,
        "externalRefundId",
        "externalReceiptId",
        "acceptedAt",
        "resellableQuantity",
      ]);
  }
}

function observedRows(
  graph: SelectionGraph,
  sources: ProjectedSources,
  domain: ObservedDomain,
  rows: readonly (MetricRow & { readonly data: object | null })[],
  matches: (fact: ObservedFactV1, data: object | null) => boolean,
): boolean {
  if (rows.length !== sources.size || (rows.length === 0 && !graph.complete)) return false;
  const seen = new Set<string>();
  for (const row of rows) {
    const source = sourceFor(sources, domain, row);
    if (
      !source ||
      seen.has(row.sourceVersion) ||
      !matchesProvenance(row, source) ||
      !matches(source.fact, row.data)
    )
      return false;
    seen.add(row.sourceVersion);
  }
  return true;
}

const financialCollections = {
  FROZEN_COST: "frozenCosts",
  REFUND_ALLOCATION: "refundAllocations",
  RETURN_RECEIPT: "returnReceipts",
} as const;

function validFinancialProjection(graph: SelectionGraph, domain: FinancialDomain): boolean {
  const eligible = coverageFor(graph, domain);
  const { input, subject } = graph.proof.selection;
  if (subject.kind === "STORE" && eligible.length !== graph.orderSkus.size) return false;
  const sources = observedSources(graph, eligible);
  if (!sources) return false;
  const matched = new Map(
    [...sources].filter(
      ([, { fact }]) => fact.domain === domain && matchesFinancialLine(fact, graph),
    ),
  );
  return observedRows(
    graph,
    matched,
    domain,
    input[financialCollections[domain]] ?? [],
    (fact, data) => fact.domain === domain && financialDataMatches(fact, data, graph.verified),
  );
}

function validFeeProjection(graph: SelectionGraph): boolean {
  const sources = observedSources(graph, coverageFor(graph, "FEE"));
  if (!sources) return false;
  return observedRows(
    graph,
    sources,
    "FEE",
    graph.proof.selection.input.fees ?? [],
    (fact, data) => {
      if (fact.domain !== "FEE" || (graph.verified && fact.payload.reason !== null)) return false;
      const { window, kind, externalOrderId, amountMinor, coverageBasisPoints, basis } =
        fact.payload;
      return sameData(data, {
        ...window,
        kind,
        externalOrderId,
        amountMinor,
        coverageBasisPoints,
        basis,
      });
    },
  );
}

type NoticeIndex = ReadonlyMap<string, ReadonlySet<string>>;
type PositionData = NonNullable<MetricInventoryExtension["data"]>;
function noticeKey(
  sku: string,
  location: string,
  eta: string | null,
  hours: number | null,
): string {
  return JSON.stringify([sku, location, eta, hours]);
}

function noticeIndex(graph: SelectionGraph): NoticeIndex | undefined {
  const rows = coverageFor(graph, "SUPPLIER_NOTICE");
  const required = graph.proof.request.kind === "LEAD_TIME_HOURS" && graph.verified;
  const supported = rows.some((entry) => entry.receiptIds.some((id) => graph.ids.has(id)));
  if (!supported && !required) return new Map();
  const notices = observedSources(graph, rows);
  if (!notices) return undefined;
  const result = new Map<string, Set<string>>();
  for (const { fact, receiptIds } of notices.values()) {
    if (fact.domain !== "SUPPLIER_NOTICE") return undefined;
    const { externalSkuId, externalLocationId, newEta, promisedLeadHours } = fact.payload;
    const key = noticeKey(externalSkuId, externalLocationId, newEta, promisedLeadHours);
    const ids = result.get(key) ?? new Set<string>();
    for (const id of receiptIds) ids.add(id);
    result.set(key, ids);
  }
  return result;
}

function positionMatches(fact: ObservedFactV1, data: PositionData, graph: SelectionGraph): boolean {
  if (fact.domain !== "INVENTORY_POSITION") return false;
  const { payload } = fact;
  if (
    graph.verified &&
    graph.proof.request.kind === "INVENTORY_HOURS_REMAINING" &&
    (payload.quarantine === null || payload.inbound === null)
  )
    return false;
  if (
    graph.verified &&
    graph.proof.request.kind === "LEAD_TIME_HOURS" &&
    data.leadTimeHours === null
  )
    return false;
  return (
    data.externalSkuId === payload.externalSkuId &&
    data.externalLocationId === payload.externalLocationId &&
    data.asOf === payload.asOf &&
    data.quarantine === payload.quarantine &&
    data.inbound === payload.inbound &&
    data.safetyBufferHours === payload.safetyBufferHours
  );
}

function matchesExtension(
  row: MetricInventoryExtension,
  source: SelectedSource,
  notices: NoticeIndex,
  graph: SelectionGraph,
): boolean {
  const { data } = row;
  if (!data || !positionMatches(source.fact, data, graph)) return false;
  const key = noticeKey(data.externalSkuId, data.externalLocationId, data.eta, data.leadTimeHours);
  const notice = notices.get(key);
  // The position owns row provenance; a separately witnessed notice can supply ETA and lead time.
  return (
    matchesProvenance(row, source, notice) &&
    ((data.eta === null && data.leadTimeHours === null) ||
      (notice !== undefined && row.evidenceIds.some((id) => notice.has(id))))
  );
}

function validInventoryExtensions(graph: SelectionGraph): boolean {
  const rows = graph.proof.selection.input.inventoryExtensions ?? [];
  const positions = observedSources(graph, coverageFor(graph, "INVENTORY_POSITION"));
  const notices = noticeIndex(graph);
  if (!positions || !notices || rows.length === 0 || rows.length !== positions.size) return false;
  const seen = new Set<string>();
  for (const row of rows) {
    const source = sourceFor(positions, "INVENTORY_POSITION", row);
    if (!source || seen.has(row.sourceVersion) || !matchesExtension(row, source, notices, graph))
      return false;
    seen.add(row.sourceVersion);
  }
  return true;
}

const projectionChecks: Readonly<Record<MetricCollection, (graph: SelectionGraph) => boolean>> = {
  paymentFacts: validPayments,
  refundFacts: validRefunds,
  inventoryFacts: validInventory,
  campaignFacts: validCampaignProjection,
  frozenCosts: (graph) => validFinancialProjection(graph, "FROZEN_COST"),
  refundAllocations: (graph) => validFinancialProjection(graph, "REFUND_ALLOCATION"),
  returnReceipts: (graph) => validFinancialProjection(graph, "RETURN_RECEIPT"),
  fees: validFeeProjection,
  traffic: validTrafficProjection,
  inventoryExtensions: validInventoryExtensions,
};

function validProjection(proof: SelectionProof): boolean {
  const graph = createSelectionGraph(proof);
  const [coverage] = proof.selection.input.metricCoverage;
  return (
    graph !== undefined &&
    coverage !== undefined &&
    coverage.collections.every((key) => projectionChecks[key](graph)) &&
    graph.used.size === graph.ids.size
  );
}

/** Bind the three-key leaf projection to the reader's supplied sealed graph. */
export const ObservedSelectionProofV1Schema = preflight(
  selectionProofObject
    .refine(matchingRequest, { message: "INVALID_SELECTION_IDENTITY", abort: true })
    .refine(validProjection, "INVALID_SELECTION_EVIDENCE")
    .readonly(),
  boundedSelectionProof,
);
export type ObservedSelectionProofV1 = z.infer<typeof ObservedSelectionProofV1Schema>;

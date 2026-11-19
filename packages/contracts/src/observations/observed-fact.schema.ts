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
  MetricFeeKindSchema,
  MetricIssueCodeSchema,
  MetricWindowSchema,
  SignedMinorSchema,
} from "../metrics/metric.schema.js";

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

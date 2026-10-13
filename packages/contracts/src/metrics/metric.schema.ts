import { z } from "zod";
import {
  ConnectorBindingSchema,
  CurrencySchema,
  ExternalIdSchema,
  MinorAmountSchema,
  QuantitySchema,
  SourceVersionSchema,
} from "../commerce/connector-common.schema.js";
import {
  ConnectorOrderSchema,
  ConnectorRefundSchema,
  ConnectorInventorySchema,
  ConnectorCampaignMetricSchema,
} from "../commerce/connector-data.schema.js";
import type { ConnectorBinding } from "../commerce/connector-common.schema.js";

export const MetricTimestampSchema = z.iso.datetime();
export const MetricEvidenceIdsSchema = z
  .array(ExternalIdSchema)
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, "Evidence IDs must be unique")
  .readonly();
export const MetricStatusSchema = z.enum([
  "VERIFIED",
  "ESTIMATED",
  "INSUFFICIENT",
  "STALE",
  "UNAVAILABLE",
]);
export const SignedMinorSchema = z
  .number()
  .int()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
export const BasisPointsSchema = QuantitySchema.max(10000);
const hours = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const windowFields = {
  periodStart: MetricTimestampSchema,
  periodEnd: MetricTimestampSchema,
  timezone: z.literal("Asia/Shanghai"),
  currency: CurrencySchema,
};
type WindowFields = { readonly periodStart: string; readonly periodEnd: string };
function validWindow(value: WindowFields): boolean {
  return Date.parse(value.periodStart) < Date.parse(value.periodEnd);
}
/** All metric windows are half-open [periodStart, periodEnd), expressed in UTC. */
export const MetricWindowSchema = z
  .strictObject(windowFields)
  .refine(validWindow, "Metric window start must precede end")
  .readonly();
const provenanceFields = {
  binding: ConnectorBindingSchema,
  observedAt: MetricTimestampSchema,
  sourceVersion: SourceVersionSchema,
  evidenceIds: MetricEvidenceIdsSchema,
};
export const MetricProvenanceSchema = z.strictObject(provenanceFields).readonly();
function factSchema<T extends z.ZodType>(data: T) {
  return z.strictObject({ ...provenanceFields, data }).readonly();
}
type SourceRecord = {
  readonly externalStoreId: string;
  readonly source: { readonly updatedAt: string | null };
};
function visibleFact(
  fact: MetricProvenance & { readonly data: SourceRecord },
  times: readonly (string | null)[],
): boolean {
  return (
    fact.binding.externalStoreId === fact.data.externalStoreId &&
    [fact.data.source.updatedAt, ...times].every(
      (time) => time === null || Date.parse(time) <= Date.parse(fact.observedAt),
    )
  );
}
const factVisibilityError = "Fact must belong to its external store and be visible when observed";
export const MetricPaymentFactSchema = factSchema(ConnectorOrderSchema).refine(
  (fact) => visibleFact(fact, [fact.data.orderedAt, fact.data.paidAt]),
  factVisibilityError,
);
export const MetricRefundFactSchema = factSchema(ConnectorRefundSchema).refine(
  (fact) => visibleFact(fact, [fact.data.requestedAt, fact.data.succeededAt]),
  factVisibilityError,
);
export const MetricInventoryFactSchema = factSchema(ConnectorInventorySchema).refine(
  (fact) => visibleFact(fact, []),
  factVisibilityError,
);
export const MetricCampaignFactSchema = factSchema(ConnectorCampaignMetricSchema).refine(
  (fact) => visibleFact(fact, [`${fact.data.date}T00:00:00+08:00`]),
  factVisibilityError,
);
// Nullable extension facts are independent sources; existing Connector DTOs do not provide them.
export const MetricFrozenCostSchema = factSchema(
  z
    .strictObject({
      externalOrderId: ExternalIdSchema,
      externalLineId: ExternalIdSchema,
      externalSkuId: ExternalIdSchema,
      quantity: QuantitySchema.min(1),
      frozenAt: MetricTimestampSchema,
      skuCostVersion: SourceVersionSchema.nullable(),
      unitCostMinor: MinorAmountSchema.nullable(),
      basis: z.enum(["CONFIRMED", "ESTIMATED", "UNAVAILABLE"]),
      currency: CurrencySchema,
    })
    .refine(
      (cost) =>
        cost.basis === "UNAVAILABLE"
          ? cost.unitCostMinor === null
          : cost.unitCostMinor !== null && cost.skuCostVersion !== null,
      "Known frozen cost requires its historical version; unavailable cost stays null",
    )
    .readonly()
    .nullable(),
).refine(
  (fact) => fact.data === null || Date.parse(fact.data.frozenAt) <= Date.parse(fact.observedAt),
  "Frozen cost is not yet visible",
);
export const MetricRefundAllocationSchema = factSchema(
  z
    .strictObject({
      externalRefundId: ExternalIdSchema,
      externalOrderId: ExternalIdSchema,
      externalLineId: ExternalIdSchema,
      externalSkuId: ExternalIdSchema,
      merchandiseMinor: MinorAmountSchema.nullable(),
      buyerShippingMinor: MinorAmountSchema.nullable(),
      currency: CurrencySchema,
    })
    .readonly()
    .nullable(),
);
export const MetricReturnReceiptSchema = factSchema(
  z
    .strictObject({
      externalReceiptId: ExternalIdSchema,
      externalRefundId: ExternalIdSchema,
      externalOrderId: ExternalIdSchema,
      externalLineId: ExternalIdSchema,
      externalSkuId: ExternalIdSchema,
      acceptedAt: MetricTimestampSchema.nullable(),
      resellableQuantity: QuantitySchema.nullable(),
    })
    .readonly()
    .nullable(),
).refine(
  (fact) =>
    fact.data?.acceptedAt == null ||
    Date.parse(fact.data.acceptedAt) <= Date.parse(fact.observedAt),
  "Return acceptance is not yet visible",
);
export const MetricFeeKindSchema = z.enum([
  "FULFILLMENT",
  "PLATFORM",
  "PAYMENT",
  "ADVERTISING_PROMOTION",
  "OTHER_OPERATING",
]);
export const MetricFeeSchema = factSchema(
  z
    .strictObject({
      ...windowFields,
      kind: MetricFeeKindSchema,
      externalOrderId: ExternalIdSchema.nullable(),
      amountMinor: MinorAmountSchema.nullable(),
      coverageBasisPoints: BasisPointsSchema,
      basis: z.enum(["CONFIRMED", "ESTIMATED", "UNAVAILABLE"]),
    })
    .refine(validWindow, "Invalid fee window")
    .refine(
      (fee) => (fee.basis === "UNAVAILABLE" ? fee.amountMinor === null : fee.amountMinor !== null),
      "Fee availability must preserve null",
    )
    .readonly()
    .nullable(),
).refine(
  (fact) => fact.data === null || Date.parse(fact.data.periodEnd) <= Date.parse(fact.observedAt),
  "Fee window is not yet visible",
);
export const MetricTrafficSchema = factSchema(
  z
    .strictObject({
      ...windowFields,
      visitors: QuantitySchema.nullable(),
      cart: QuantitySchema.nullable(),
      checkout: QuantitySchema.nullable(),
      paidOrders: QuantitySchema.nullable(),
      coverageBasisPoints: BasisPointsSchema,
    })
    .refine(validWindow, "Invalid traffic window")
    .readonly()
    .nullable(),
).refine(
  (fact) => fact.data === null || Date.parse(fact.data.periodEnd) <= Date.parse(fact.observedAt),
  "Traffic window is not yet visible",
);
export const MetricInventoryExtensionSchema = factSchema(
  z
    .strictObject({
      externalSkuId: ExternalIdSchema,
      externalLocationId: ExternalIdSchema,
      asOf: MetricTimestampSchema,
      quarantine: QuantitySchema.nullable(),
      inbound: QuantitySchema.nullable(),
      leadTimeHours: hours.nullable(),
      safetyBufferHours: hours.nullable(),
      eta: MetricTimestampSchema.nullable(),
    })
    .readonly()
    .nullable(),
).refine(
  (fact) => fact.data === null || Date.parse(fact.data.asOf) <= Date.parse(fact.observedAt),
  "Inventory asOf is not yet visible",
);
function factList<T extends z.ZodType>(schema: T) {
  return z.array(schema).readonly().nullable();
}
const collectionFields = {
  paymentFacts: factList(MetricPaymentFactSchema),
  refundFacts: factList(MetricRefundFactSchema),
  inventoryFacts: factList(MetricInventoryFactSchema),
  campaignFacts: factList(MetricCampaignFactSchema),
  frozenCosts: factList(MetricFrozenCostSchema),
  refundAllocations: factList(MetricRefundAllocationSchema),
  returnReceipts: factList(MetricReturnReceiptSchema),
  fees: factList(MetricFeeSchema),
  traffic: factList(MetricTrafficSchema),
  inventoryExtensions: factList(MetricInventoryExtensionSchema),
};
const versionFields = {
  schemaVersion: z.literal(1),
  definitionVersion: SourceVersionSchema,
  inputRevision: SourceVersionSchema,
  binding: ConnectorBindingSchema,
  ...windowFields,
  visibleAt: MetricTimestampSchema,
  sourceWatermark: MetricTimestampSchema.nullable(),
  evidenceIds: MetricEvidenceIdsSchema,
};
function sameBinding(left: ConnectorBinding, right: ConnectorBinding): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.workspaceId === right.workspaceId &&
    left.storeId === right.storeId &&
    left.connectionId === right.connectionId &&
    left.externalStoreId === right.externalStoreId
  );
}
type VisibilityFields = WindowFields & {
  readonly visibleAt: string;
  readonly sourceWatermark: string | null;
};
function validVisibility(value: VisibilityFields): boolean {
  return (
    validWindow(value) &&
    Date.parse(value.periodEnd) <= Date.parse(value.visibleAt) &&
    (value.sourceWatermark === null ||
      Date.parse(value.sourceWatermark) <= Date.parse(value.visibleAt))
  );
}
function metricValue<
  const K extends readonly [string, ...string[]],
  const U extends string,
  T extends z.ZodType,
>(kind: K, unit: U, value: T) {
  return z
    .strictObject({ kind: z.enum(kind), unit: z.literal(unit), value: value.nullable() })
    .readonly();
}
/** ROAS 3x is 30000 basis points; probability rates remain in [0, 10000]. */
export const MetricValueSchema = z.discriminatedUnion("kind", [
  metricValue(
    ["GMV", "PAID_REVENUE", "AOV", "REFUND_SETTLED_AMOUNT", "COGS"],
    "minorCNY",
    MinorAmountSchema,
  ),
  metricValue(
    [
      "NET_REVENUE_SETTLEMENT",
      "NET_MERCHANDISE_REVENUE",
      "GROSS_PROFIT",
      "CONTRIBUTION",
      "ESTIMATED_NET_PROFIT",
      "PROFIT_DELTA",
    ],
    "minorCNY",
    SignedMinorSchema,
  ),
  metricValue(
    ["PAID_ORDERS", "PAID_UNITS", "REFUNDED_COHORT_ORDERS", "INVENTORY_AVAILABLE"],
    "units",
    QuantitySchema,
  ),
  metricValue(
    [
      "REFUND_COHORT_ORDER_RATE",
      "REFUND_COHORT_AMOUNT_RATE",
      "CONVERSION_RATE",
      "CART_RATE",
      "CHECKOUT_RATE",
    ],
    "basisPoints",
    BasisPointsSchema,
  ),
  metricValue(["ROAS"], "basisPoints", QuantitySchema),
  metricValue(["INVENTORY_HOURS_REMAINING", "LEAD_TIME_HOURS"], "hours", hours),
]);
export const MetricSubjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("STORE") }).readonly(),
  z.strictObject({ kind: z.literal("SKU"), externalSkuId: ExternalIdSchema }).readonly(),
  z.strictObject({ kind: z.literal("CAMPAIGN"), externalCampaignId: ExternalIdSchema }).readonly(),
]);
export const MetricCollectionSchema = z.enum([
  "paymentFacts",
  "refundFacts",
  "inventoryFacts",
  "campaignFacts",
  "frozenCosts",
  "refundAllocations",
  "returnReceipts",
  "fees",
  "traffic",
  "inventoryExtensions",
]);
/** Source-reader completeness evidence, never a calculator's assertion about its output. */
export const MetricCoverageV1Schema = z
  .strictObject({
    ...versionFields,
    observedAt: MetricTimestampSchema,
    sourceVersion: SourceVersionSchema,
    kind: z.union(MetricValueSchema.options.map((option) => option.unwrap().shape.kind)),
    subject: MetricSubjectSchema,
    collections: z
      .array(MetricCollectionSchema)
      .min(1)
      .refine((values) => new Set(values).size === values.length, "Duplicate source collection")
      .readonly(),
    coverageBasisPoints: BasisPointsSchema,
  })
  .refine(validVisibility, "Invalid coverage visibility")
  .readonly();
export type MetricCoverageV1 = z.infer<typeof MetricCoverageV1Schema>;
const InputObjectSchema = z.strictObject({
  ...versionFields,
  status: MetricStatusSchema,
  ...collectionFields,
  metricCoverage: z.array(MetricCoverageV1Schema).readonly(),
});
type InputObject = z.infer<typeof InputObjectSchema>;
function factCollections(input: InputObject) {
  return [
    input.paymentFacts,
    input.refundFacts,
    input.inventoryFacts,
    input.campaignFacts,
    input.frozenCosts,
    input.refundAllocations,
    input.returnReceipts,
    input.fees,
    input.traffic,
    input.inventoryExtensions,
  ];
}
function validInputFacts(input: InputObject): boolean {
  return factCollections(input).every(
    (facts) =>
      facts === null ||
      facts.every(
        (fact) =>
          sameBinding(input.binding, fact.binding) &&
          Date.parse(fact.observedAt) <= Date.parse(input.visibleAt),
      ),
  );
}
function validInputAvailability(input: InputObject): boolean {
  if (input.sourceWatermark !== null)
    return (
      input.status !== "UNAVAILABLE" &&
      (input.status !== "VERIFIED" || factCollections(input).some((facts) => facts !== null))
    );
  return input.status === "UNAVAILABLE" && factCollections(input).every((facts) => facts === null);
}
const contextKeys = [
  "definitionVersion",
  "inputRevision",
  "periodStart",
  "periodEnd",
  "timezone",
  "currency",
  "visibleAt",
  "sourceWatermark",
] as const;
function inputEvidence(input: InputObject): ReadonlySet<string> {
  const evidence = new Set(input.evidenceIds);
  for (const facts of factCollections(input)) {
    for (const fact of facts ?? []) fact.evidenceIds.forEach((id) => evidence.add(id));
  }
  return evidence;
}
function validCoverage(input: InputObject): boolean {
  const evidence = inputEvidence(input);
  return input.metricCoverage.every(
    (coverage) =>
      sameBinding(input.binding, coverage.binding) &&
      contextKeys.every((key) => input[key] === coverage[key]) &&
      Date.parse(coverage.observedAt) <= Date.parse(input.visibleAt) &&
      Date.parse(coverage.periodEnd) <= Date.parse(coverage.observedAt) &&
      coverage.evidenceIds.every((id) => evidence.has(id)) &&
      coverage.collections.every((key) => input[key] !== null),
  );
}
export const MetricInputV1Schema = InputObjectSchema.refine(
  validVisibility,
  "Invalid metric window or future source watermark",
)
  .refine(validInputFacts, "Every fact must match metric scope and visibility cutoff")
  .refine(validCoverage, "Coverage must retain source scope, revision, window, cutoff and evidence")
  .refine(validInputAvailability, "Unsynchronized input must preserve null facts and UNAVAILABLE")
  .readonly();

export const MetricIssueCodeSchema = z.enum([
  "NOT_SYNCHRONIZED",
  "SOURCE_INCONSISTENT",
  "SOURCE_TIME_MISSING",
  "PAYMENT_UNKNOWN",
  "REFUND_UNKNOWN",
  "COST_MISSING",
  "COST_ESTIMATED",
  "RETURN_UNKNOWN",
  "FEE_MISSING",
  "FEE_ESTIMATED",
  "TRAFFIC_MISSING",
  "ATTRIBUTION_MISSING",
  "INVENTORY_UNKNOWN",
  "LEAD_TIME_MISSING",
  "STALE_SOURCE",
  "LOW_SAMPLE",
  "ZERO_DENOMINATOR",
  "IMMATURE_COHORT",
  "PARTIAL_COVERAGE",
  "WINDOW_MISMATCH",
  "VERSION_MISMATCH",
]);
export const DataQualityIssueV1Schema = z
  .strictObject({
    code: MetricIssueCodeSchema,
    field: ExternalIdSchema,
    evidenceIds: MetricEvidenceIdsSchema,
  })
  .readonly();
const SnapshotObjectSchema = z.strictObject({
  ...versionFields,
  computedAt: MetricTimestampSchema,
  sampleSize: QuantitySchema,
  coverageBasisPoints: BasisPointsSchema,
  status: MetricStatusSchema,
  issues: z.array(DataQualityIssueV1Schema).readonly(),
  subject: MetricSubjectSchema,
  metric: MetricValueSchema,
});
type SnapshotObject = z.infer<typeof SnapshotObjectSchema>;
function validSnapshotQuality(snapshot: SnapshotObject): boolean {
  if (snapshot.sourceWatermark === null && snapshot.status !== "UNAVAILABLE") return false;
  if (snapshot.status === "UNAVAILABLE")
    return snapshot.metric.value === null && snapshot.issues.length > 0;
  if (snapshot.status === "VERIFIED")
    return (
      snapshot.metric.value !== null &&
      snapshot.coverageBasisPoints === 10000 &&
      snapshot.issues.length === 0 &&
      snapshot.sourceWatermark !== null &&
      Date.parse(snapshot.sourceWatermark) >= Date.parse(snapshot.periodEnd)
    );
  return snapshot.issues.length > 0;
}
export const MetricSnapshotV1Schema = SnapshotObjectSchema.refine(
  validVisibility,
  "Invalid snapshot window or future watermark",
)
  .refine(
    (snapshot) => Date.parse(snapshot.computedAt) >= Date.parse(snapshot.visibleAt),
    "Snapshot computed before visibility cutoff",
  )
  .refine(validSnapshotQuality, "Snapshot status, value, coverage and quality evidence disagree")
  .refine(
    (snapshot) =>
      snapshot.issues.every((issue) =>
        issue.evidenceIds.every((id) => snapshot.evidenceIds.includes(id)),
      ),
    "Quality issue evidence must belong to snapshot",
  )
  .readonly();

export type MetricWindow = z.infer<typeof MetricWindowSchema>;
export type MetricProvenance = z.infer<typeof MetricProvenanceSchema>;
export type MetricInputV1 = z.infer<typeof MetricInputV1Schema>;
export type MetricSnapshotV1 = z.infer<typeof MetricSnapshotV1Schema>;
export type MetricValue = z.infer<typeof MetricValueSchema>;
export type MetricKind = MetricValue["kind"];
export type MetricStatus = z.infer<typeof MetricStatusSchema>;
export type MetricSubject = z.infer<typeof MetricSubjectSchema>;
export type DataQualityIssueV1 = z.infer<typeof DataQualityIssueV1Schema>;
export type MetricFeeKind = z.infer<typeof MetricFeeKindSchema>;
export type MetricPaymentFact = z.infer<typeof MetricPaymentFactSchema>;
export type MetricRefundFact = z.infer<typeof MetricRefundFactSchema>;
export type MetricInventoryFact = z.infer<typeof MetricInventoryFactSchema>;
export type MetricCampaignFact = z.infer<typeof MetricCampaignFactSchema>;
export type MetricFrozenCost = z.infer<typeof MetricFrozenCostSchema>;
export type MetricRefundAllocation = z.infer<typeof MetricRefundAllocationSchema>;
export type MetricReturnReceipt = z.infer<typeof MetricReturnReceiptSchema>;
export type MetricFee = z.infer<typeof MetricFeeSchema>;
export type MetricTraffic = z.infer<typeof MetricTrafficSchema>;
export type MetricInventoryExtension = z.infer<typeof MetricInventoryExtensionSchema>;

function matchesInput(input: MetricInputV1, snapshot: MetricSnapshotV1): boolean {
  const evidence = inputEvidence(input);
  return (
    sameBinding(input.binding, snapshot.binding) &&
    contextKeys.every((key) => input[key] === snapshot[key]) &&
    snapshot.evidenceIds.every((id) => evidence.has(id)) &&
    (input.status !== "UNAVAILABLE" || snapshot.status === "UNAVAILABLE")
  );
}
type Collection = z.infer<typeof MetricCollectionSchema>;
const payment = ["paymentFacts"] as const;
const refund = ["paymentFacts", "refundFacts"] as const;
const cost = [...refund, "frozenCosts", "refundAllocations", "returnReceipts"] as const;
const contribution = [...cost, "fees"] as const;
/** Minimum source domains are part of the contract; no values or quality states are calculated here. */
const requiredCollections: Readonly<Record<MetricKind, readonly Collection[]>> = {
  GMV: payment,
  PAID_REVENUE: payment,
  AOV: payment,
  PAID_ORDERS: payment,
  PAID_UNITS: payment,
  REFUND_SETTLED_AMOUNT: ["refundFacts"],
  NET_REVENUE_SETTLEMENT: refund,
  REFUNDED_COHORT_ORDERS: refund,
  REFUND_COHORT_ORDER_RATE: refund,
  REFUND_COHORT_AMOUNT_RATE: refund,
  NET_MERCHANDISE_REVENUE: [...refund, "refundAllocations"],
  COGS: cost,
  GROSS_PROFIT: cost,
  CONTRIBUTION: contribution,
  ESTIMATED_NET_PROFIT: contribution,
  PROFIT_DELTA: contribution,
  INVENTORY_AVAILABLE: ["inventoryFacts"],
  INVENTORY_HOURS_REMAINING: ["inventoryFacts", "paymentFacts", "inventoryExtensions"],
  LEAD_TIME_HOURS: ["inventoryExtensions"],
  CONVERSION_RATE: ["traffic"],
  CART_RATE: ["traffic"],
  CHECKOUT_RATE: ["traffic"],
  ROAS: ["campaignFacts"],
};
function sameSubject(left: MetricSubject, right: MetricSubject): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "SKU" && right.kind === "SKU")
    return left.externalSkuId === right.externalSkuId;
  if (left.kind === "CAMPAIGN" && right.kind === "CAMPAIGN")
    return left.externalCampaignId === right.externalCampaignId;
  return true;
}
function knownPayments(input: MetricInputV1, kind: MetricKind): boolean {
  if (kind === "GMV" || !requiredCollections[kind].includes("paymentFacts")) return true;
  return (input.paymentFacts ?? []).every(
    ({ data }) =>
      data.paidMinor !== null &&
      (data.paidAt !== null ||
        (data.paidMinor === 0 && !["PAID", "FULFILLED", "COMPLETED"].includes(data.status))),
  );
}
function verifiedSources(input: MetricInputV1, snapshot: MetricSnapshotV1): boolean {
  if (snapshot.status !== "VERIFIED") return true;
  if (!knownPayments(input, snapshot.metric.kind)) return false;
  const required = requiredCollections[snapshot.metric.kind];
  return input.metricCoverage.some(
    (coverage) =>
      coverage.kind === snapshot.metric.kind &&
      sameSubject(coverage.subject, snapshot.subject) &&
      coverage.coverageBasisPoints === 10000 &&
      coverage.evidenceIds.every((id) => snapshot.evidenceIds.includes(id)) &&
      required.every(
        (key) =>
          coverage.collections.includes(key) &&
          input[key] !== null &&
          input[key].every((fact) => fact.data !== null),
      ),
  );
}
/** Validate at calculation/append boundaries so unavailable inputs cannot become verified zero. */
export const MetricComputationV1Schema = z
  .strictObject({
    input: MetricInputV1Schema,
    snapshot: MetricSnapshotV1Schema,
  })
  .refine(
    ({ input, snapshot }) => matchesInput(input, snapshot),
    "Snapshot must retain source scope, revision, cutoff and evidence",
  )
  .refine(
    ({ input, snapshot }) => verifiedSources(input, snapshot),
    "Verified metrics require observed relevant collections and source completeness evidence",
  )
  .readonly();
export type MetricComputationV1 = z.infer<typeof MetricComputationV1Schema>;

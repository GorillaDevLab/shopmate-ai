import type { ConnectorBinding } from "../commerce/connector-common.schema.js";
import type { TenantContext } from "../tenant/tenant.schema.js";
import type {
  DataQualityIssueV1,
  MetricComputationV1,
  MetricFeeKind,
  MetricInputV1,
  MetricKind,
  MetricSnapshotV1,
  MetricStatus,
  MetricSubject,
  MetricValue,
  MetricWindow,
} from "./metric.schema.js";

export type MetricErrorCode =
  | "INVALID_INPUT"
  | "OVERFLOW"
  | "SCOPE_MISMATCH"
  | "VERSION_MISMATCH"
  | "WINDOW_MISMATCH"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "SOURCE_UNAVAILABLE";
export interface MetricError {
  readonly code: MetricErrorCode;
  readonly evidenceIds: readonly string[];
}
export type MetricResult<T> = Readonly<{ ok: true; value: T } | { ok: false; error: MetricError }>;
export interface MetricCoverageRequest {
  readonly kind: MetricKind;
  readonly subject: MetricSubject;
}
export interface MetricSourceQuery {
  /** Bound the metric/subject completeness evidence requested from normalized sources. */
  readonly coverageRequests: readonly MetricCoverageRequest[];
  readonly binding: ConnectorBinding;
  readonly window: MetricWindow;
  readonly visibleAt: string;
  readonly definitionVersion: string;
  /** A requested revision replays that immutable normalized input, never current source state. */
  readonly inputRevision: string | null;
}
/** Reads only normalized facts already visible at the cutoff. No provider fetch or scenario oracle. */
export interface MetricSourceReader {
  readonly read: (query: MetricSourceQuery) => Promise<MetricResult<MetricInputV1>>;
}
export interface MetricCalculationRequest {
  readonly input: MetricInputV1;
  readonly kind: MetricKind;
  readonly subject: MetricSubject;
  readonly computedAt: string;
}
/** Pure: clock, normalized input and definition version are supplied explicitly. */
export interface MetricCalculator {
  readonly calculate: (request: MetricCalculationRequest) => MetricResult<MetricComputationV1>;
}
export interface MetricSnapshotQuery {
  readonly binding: ConnectorBinding;
  readonly window: MetricWindow;
  readonly kinds: readonly MetricKind[];
  readonly subject: MetricSubject;
  readonly definitionVersion: string;
  readonly inputRevision: string | null;
  readonly visibleAt: string;
}
/** Append validates MetricComputationV1; a duplicate immutable revision is idempotent or CONFLICT. */
export interface MetricSnapshotRepository {
  readonly append: (computation: MetricComputationV1) => Promise<MetricResult<MetricSnapshotV1>>;
  readonly read: (query: MetricSnapshotQuery) => Promise<MetricResult<readonly MetricSnapshotV1[]>>;
}
export interface AuthorizedMetricRead {
  /** Supplied by authenticated server context; implementations enforce tenant AND store ownership. */
  readonly actor: TenantContext;
  readonly query: MetricSnapshotQuery;
}
/** Authorization is mandatory; reads never trigger calculation, synchronization or writes. */
export interface MetricReadPort {
  readonly read: (
    request: AuthorizedMetricRead,
  ) => Promise<MetricResult<readonly MetricSnapshotV1[]>>;
}

export type MinorRounding = "HALF_AWAY_FROM_ZERO" | "TOWARD_ZERO";
export type BasisPointRatio = Readonly<
  { value: number; reason: null } | { value: null; reason: "ZERO_DENOMINATOR" }
>;
export interface MinorAllocationWeight {
  readonly key: string;
  readonly weight: number;
}
export interface MinorAllocation {
  readonly key: string;
  readonly amountMinor: number;
}
/** Safe integers only; implementations use checked exact intermediates and explicit overflow results. */
export interface ExactMinorMath {
  readonly add: (values: readonly number[]) => MetricResult<number>;
  readonly subtract: (leftMinor: number, rightMinor: number) => MetricResult<number>;
  readonly multiply: (amountMinor: number, quantity: number) => MetricResult<number>;
  readonly ratio: (
    numerator: number,
    denominator: number,
    rounding: MinorRounding,
  ) => MetricResult<BasisPointRatio>;
  readonly allocate: (
    amountMinor: number,
    weights: readonly MinorAllocationWeight[],
    rounding: MinorRounding,
  ) => MetricResult<readonly MinorAllocation[]>;
}
/** Structurally compatible with the existing API business clock; never used for authorization expiry. */
export interface MetricBusinessClock {
  readonly snapshot: () => Readonly<{ now: string; revision: number }>;
}
export interface MetricWindowRequest {
  readonly businessDate: string;
  readonly timezone: "Asia/Shanghai";
  readonly visibleAt: string;
}
export interface AlignedComparisonWindow {
  readonly current: MetricWindow;
  readonly baseline: MetricWindow;
  readonly elapsedHours: number;
  readonly aligned: boolean;
  readonly reason: "WEEKDAY_MISMATCH" | "CUTOFF_MISMATCH" | null;
}
export interface MetricWindowResolver {
  readonly businessDay: (request: MetricWindowRequest) => MetricResult<MetricWindow>;
  readonly elapsed: (request: MetricWindowRequest) => MetricResult<MetricWindow>;
  readonly align: (
    current: MetricWindow,
    candidateBusinessDate: string,
    visibleAt: string,
  ) => MetricResult<AlignedComparisonWindow>;
}
export interface MetricQuality {
  readonly status: MetricStatus;
  readonly sampleSize: number;
  readonly coverageBasisPoints: number;
  readonly evidenceIds: readonly string[];
  readonly issues: readonly DataQualityIssueV1[];
}
export interface MetricMeasure<K extends MetricKind> {
  readonly metric: MetricValue & Readonly<{ kind: K }>;
  readonly quality: MetricQuality;
}
export interface PaymentMetrics {
  readonly gmv: MetricMeasure<"GMV">;
  readonly paidRevenue: MetricMeasure<"PAID_REVENUE">;
  readonly paidOrders: MetricMeasure<"PAID_ORDERS">;
  readonly paidUnits: MetricMeasure<"PAID_UNITS">;
  readonly aov: MetricMeasure<"AOV">;
}
export interface PaymentMetricCalculator {
  readonly calculate: (input: MetricInputV1) => MetricResult<PaymentMetrics>;
}
export interface CohortMaturity {
  readonly paymentWindow: MetricWindow;
  readonly observedThrough: string;
  readonly requiredAgeHours: number;
  readonly elapsedAgeHours: number;
  readonly mature: boolean;
  readonly sampleSize: number;
}
export interface RefundMetricRequest {
  readonly input: MetricInputV1;
  readonly paymentCohort: MetricWindow;
  readonly maturityHours: number;
}
export interface RefundMetrics {
  readonly settledRefund: MetricMeasure<"REFUND_SETTLED_AMOUNT">;
  readonly netRevenueSettlement: MetricMeasure<"NET_REVENUE_SETTLEMENT">;
  readonly refundedCohortOrders: MetricMeasure<"REFUNDED_COHORT_ORDERS">;
  readonly cohortOrderRate: MetricMeasure<"REFUND_COHORT_ORDER_RATE">;
  readonly cohortAmountRate: MetricMeasure<"REFUND_COHORT_AMOUNT_RATE">;
  readonly cohort: CohortMaturity;
}
export interface RefundMetricCalculator {
  readonly calculate: (request: RefundMetricRequest) => MetricResult<RefundMetrics>;
}
export interface ReturnCostPolicyV1 {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly reversalBasis: "ACCEPTED_RESELLABLE_RETURN";
  readonly costBasis: "FROZEN_TRANSACTION_COST";
}
export interface CostReversalEvidence {
  readonly externalOrderId: string;
  readonly externalLineId: string;
  readonly externalReceiptId: string;
  readonly skuCostVersion: string;
  readonly reversedQuantity: number;
  readonly reversedMinor: number;
  readonly evidenceIds: readonly string[];
}
export interface FrozenCostMetrics {
  readonly netMerchandiseRevenue: MetricMeasure<"NET_MERCHANDISE_REVENUE">;
  readonly cogs: MetricMeasure<"COGS">;
  readonly grossProfit: MetricMeasure<"GROSS_PROFIT">;
  readonly policyVersion: string;
  readonly reversals: readonly CostReversalEvidence[];
}
export interface FrozenCostCalculator {
  readonly calculate: (
    input: MetricInputV1,
    policy: ReturnCostPolicyV1,
  ) => MetricResult<FrozenCostMetrics>;
}
export interface ContributionRequest {
  readonly input: MetricInputV1;
  readonly frozenCosts: FrozenCostMetrics;
  /** Buyer shipping less its explicit refund allocation, never merchandise discounts. */
  readonly netBuyerShipping: Readonly<{ amountMinor: number | null; quality: MetricQuality }>;
}
export interface EstimatedNetProfit {
  readonly contribution: MetricMeasure<"CONTRIBUTION">;
  readonly estimatedNetProfit: MetricMeasure<"ESTIMATED_NET_PROFIT">;
  readonly excludedFeeKinds: readonly MetricFeeKind[];
  readonly feeCoverage: readonly Readonly<{ kind: MetricFeeKind; coverageBasisPoints: number }>[];
}
export interface ContributionCalculator {
  readonly calculate: (request: ContributionRequest) => MetricResult<EstimatedNetProfit>;
}
export interface InventoryCoverageRequest {
  readonly input: MetricInputV1;
  readonly externalSkuId: string;
  readonly externalLocationId: string;
  readonly salesWindow: MetricWindow;
  readonly soldUnits: MetricMeasure<"PAID_UNITS">;
  readonly policy: QualityPolicy;
}
export interface InventoryCoverageMetrics {
  readonly available: MetricMeasure<"INVENTORY_AVAILABLE">;
  readonly soldUnits: number | null;
  readonly salesWindowHours: number;
  readonly salesUnitsPerHour: number | null;
  readonly hoursRemaining: MetricMeasure<"INVENTORY_HOURS_REMAINING">;
  readonly daysRemaining: number | null;
  readonly leadTimeHours: MetricMeasure<"LEAD_TIME_HOURS">;
  readonly safetyBufferHours: number | null;
  readonly eta: string | null;
  readonly belowLeadTimeWithBuffer: boolean | null;
}
export interface InventoryCoverageCalculator {
  readonly calculate: (request: InventoryCoverageRequest) => MetricResult<InventoryCoverageMetrics>;
}
export interface RatioEvidence<K extends MetricKind> {
  readonly measure: MetricMeasure<K>;
  readonly numerator: number | null;
  readonly denominator: number | null;
  readonly window: MetricWindow;
  readonly coverageBasisPoints: number;
}
export interface FunnelMarketingMetrics {
  readonly conversion: RatioEvidence<"CONVERSION_RATE">;
  readonly cart: RatioEvidence<"CART_RATE">;
  readonly checkout: RatioEvidence<"CHECKOUT_RATE">;
  readonly roas: RatioEvidence<"ROAS">;
}
export interface FunnelMarketingCalculator {
  readonly calculate: (
    input: MetricInputV1,
    subject: MetricSubject,
  ) => MetricResult<FunnelMarketingMetrics>;
}
export interface ProfitSkuAggregate {
  readonly externalSkuId: string;
  readonly units: number | null;
  readonly grossMinor: number | null;
  readonly discountMinor: number | null;
  readonly netRevenueMinor: number | null;
  readonly cogsMinor: number | null;
  readonly advertisingMinor: number | null;
  readonly frozenCostVersions: readonly string[];
  readonly evidenceIds: readonly string[];
}
export interface ProfitPeriodAggregate {
  readonly binding: ConnectorBinding;
  readonly window: MetricWindow;
  readonly definitionVersion: string;
  readonly costPolicyVersion: string;
  readonly inputRevision: string;
  readonly visibleAt: string;
  readonly skus: readonly ProfitSkuAggregate[];
  readonly profitMinor: number | null;
  readonly quality: MetricQuality;
}
export type ProfitDeltaComponent = "VOLUME" | "PRICE_DISCOUNT" | "SKU_MIX" | "COGS" | "ADVERTISING";
export interface ProfitDeltaMethodV1 {
  readonly schemaVersion: 1;
  readonly version: string;
  /** Versioned by the implementation card; this contract does not invent an attribution formula. */
  readonly order: readonly ProfitDeltaComponent[];
  readonly rounding: MinorRounding;
  readonly residualPolicy: "EXPLICIT_RESIDUAL";
}
export interface ProfitDeltaRequest {
  readonly current: ProfitPeriodAggregate;
  readonly baseline: ProfitPeriodAggregate;
  readonly comparison: AlignedComparisonWindow;
  readonly method: ProfitDeltaMethodV1;
}
export interface ProfitDeltaMetrics {
  readonly methodVersion: string;
  readonly delta: MetricMeasure<"PROFIT_DELTA">;
  readonly components: readonly Readonly<{
    kind: ProfitDeltaComponent;
    amountMinor: number | null;
    quality: MetricQuality;
  }>[];
  readonly residualMinor: number | null;
}
export interface ProfitDeltaAttributionV1 {
  readonly calculate: (request: ProfitDeltaRequest) => MetricResult<ProfitDeltaMetrics>;
}
export interface QualityPolicy {
  readonly version: string;
  readonly precedence: readonly ["UNAVAILABLE", "STALE", "INSUFFICIENT", "ESTIMATED", "VERIFIED"];
  readonly rules: readonly Readonly<{
    kind: MetricKind;
    requiredFields: readonly string[];
    minimumSampleSize: number;
    maximumAgeHours: number;
    minimumCoverageBasisPoints: number;
    allowVerifiedEmptyWindow: boolean;
  }>[];
}
export interface MetricQualityDependency {
  readonly field: string;
  readonly status: MetricStatus;
  readonly sourceWatermark: string | null;
  readonly observedAt: string | null;
  readonly sampleSize: number;
  readonly knownCount: number;
  readonly expectedCount: number;
  readonly coverageBasisPoints: number;
  readonly evidenceIds: readonly string[];
  readonly issues: readonly DataQualityIssueV1[];
}
export interface MetricQualityRequest {
  readonly kind: MetricKind;
  readonly window: MetricWindow;
  readonly visibleAt: string;
  readonly dependencies: readonly MetricQualityDependency[];
  readonly policy: QualityPolicy;
}
/** Quality is assessed per dependency, so missing cost never erases confirmed paid revenue. */
export interface MetricQualityReducer {
  readonly reduce: (request: MetricQualityRequest) => MetricQuality;
}
export interface MetricLeafPorts {
  readonly math: ExactMinorMath;
  readonly clock: MetricBusinessClock;
  readonly windows: MetricWindowResolver;
  readonly payments: PaymentMetricCalculator;
  readonly refunds: RefundMetricCalculator;
  readonly frozenCosts: FrozenCostCalculator;
  readonly contribution: ContributionCalculator;
  readonly inventory: InventoryCoverageCalculator;
  readonly funnelMarketing: FunnelMarketingCalculator;
  readonly profitDelta: ProfitDeltaAttributionV1;
  readonly quality: MetricQualityReducer;
}

# P03-019 observed fact contracts implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze the inputs, immutable evidence and authorized selection interfaces required to publish observed business facts and read them at a sealed cutoff.

**Architecture:** Put closed wire schemas in the contracts package beside the existing metric contracts. Use distinct request and result types for causal production, publication, append, capture and selection. Database-backed implementations will supply clock, identity, integrity and coverage authority through these ports.

**Tech Stack:** TypeScript ESM, Zod 4.4.3 and Vitest in `@shopmate/contracts`. Use the existing pnpm workspace.

## Global Constraints

- Preserve existing version semantics and history; additive changes only, migrations use actual fresh creation timestamps.
- Strict typed inputs, safe integer arithmetic, parameterized SQL, no PII/oracle fields or secrets; functions/test callbacks/SQL bodies <40 lines, TS no any without approved rationale.
- Critical paths have focused meaningful tests; source facts use authentic restricted writes with scoped service grants, publication/page receipts and authorized reads, never metric answer injection.
- DB proof only isolatedPostgres runner-issued credentials, explicit target registration under locks, nonzero assertion counts and zero skipped/todo/pending.
- One commit per independently verified change and one card PR. Independent review, latest-head CI and actual main merge precede Done. Existing authorized automatic deployment continues after reviewed green merges. Exclude manual production operations, credentials/grants changes, manual online migrations, real platform/LLM calls and external P07/P08 work.
- Use DB SECURITY_UTC clock_timestamp() for grants, expiry, leases and deadlines; business time selects source visibility only. Under READ COMMITTED, lock generation, grant and membership in fixed order, repeat authority/expiry checks at the final write or capture, then commit. Revocation/reset obtains conflicting locks. Test both orderings and expiry during lock wait on two connections.
- “Freeze `p2-normalized-v1`, `metrics-g4-v1`, existing mock-source-v1/v2 and event-policy-v1 meanings.” Preserve `robust-baseline-v1` as well. Use exactly `observed-facts-v1`, `p2-observed-v1:<sha256>`, `metrics-g4-observed-v2`, `mock-business-observed-v1`, `mock-source-v3` and `observed-v1:g:<generation>:e:<sequence>`.
- Choice A and the 30 prerequisite cards were approved on 2026-11-11. Work from the approved design / manifest under `docs/superpowers/specs/2026-11-11-observed-fact-prerequisites-design.md` and `docs/superpowers/specs/2026-11-11-observed-fact-prerequisite-cards.json`. #548 depends on merged P2-GATE and P03-018. Base `8f4dc016b05cabd4a00d8e67586c1f7d80da948b`, branch `feat/p03-019-observed-contracts`.
- Four-hour cap includes focused proof, review and PR preparation. Estimated 210 minutes comprising fact/config TDD 70, receipt/capture TDD 60, producer/selection ports and proof 45, complete verification/review/PR preparation 35. Treat the following as one contract card with three independently verified increments.
- Validate all external input at a strict, bounded decoding boundary. Use readonly DTOs, functions and test callbacks under 40 physical lines, no `any` or type/lint suppressions. Secrets are environment-only. Fixtures use synthetic business IDs. Keep grants/configuration away from observed facts and metric/provider payloads.
- Runtime grant/clock/SQL verification and isolated DB tests belong to the cards implementing those capabilities. 019 proves wire acceptance, rejection and type/public export compatibility. Introducing an observed namespace requires explicit provisioning. Disabling new selection preserves immutable historical records.

---

## Files and dependencies

| File | Change |
|---|---|
| `packages/contracts/src/observations/observed-fact.schema.ts` | New. Export strict DTO schemas and inferred types. Group constants/scalars, tagged fact variants, v3 config, publication/receipt, capture and scoped selection. |
| `packages/contracts/src/observations/observed-ports.ts` | New. Type-only interfaces returning bounded results. Include method-level authority, time, replay and failure obligations. |
| `packages/contracts/src/observations/observed-fact.schema.spec.ts` | New. Small table-driven domain, protocol and public-entry tests. |
| `packages/contracts/src/index.ts` | Held shared lock. Add `export * from "./observations/observed-fact.schema.js";` and `export type * from "./observations/observed-ports.js";`. |

Read `commerce/connector-common.schema.ts`, `commerce/mock-scenario.schema.ts`, `metrics/metric.schema.ts`, `metrics/metric-ports.ts`, `events/event-evidence.schema.ts` and `tenant/tenant.schema.ts` under `packages/contracts/src`. Existing database config/hash order in `packages/database/src/mock-platform/configuration.ts` and `scenario-configuration.ts` and the historical base bundle in `packages/database/src/metric-source-bundle.types.ts` are compatibility references. All imports in contracts resolve to Zod or sibling contracts. A successful 019 build must not extend the database package’s v1/v2 admission.

### Task 1. Freeze the strict business facts and opt-in generation configuration

**Interfaces.** `ObservedDomainSchema`, `ObservedFactV1Schema`, `ObservedSubjectSchema`, `MockObservedGenerationConfigV3Schema`. Use the matching names without `Schema` for inferred types. All exported protocol objects below follow the same schema/type naming convention. Closed tags are wire values.

- [ ] Write the valid-domain cases below and the failed refinements in the table. Initially import the new schemas into the spec by sibling ESM path. Run `pnpm --filter @shopmate/contracts test src/observations/observed-fact.schema.spec.ts`. Expect failure resolving the new module. Run this command after each tested increment.
- [ ] Define the scalar vocabulary. `ID` uses ExternalIdSchema, `V` uses SourceVersionSchema, `Q` uses QuantitySchema, `M` uses MinorAmountSchema, `BP` uses BasisPointsSchema, `H` is finite 0..Number.MAX_SAFE_INTEGER for hours. `T` is UTC milliseconds, `Hash` is lowercase SHA-256 hex, `G` is an integer in 0..2147483647, the existing SourceScope and EventRuntimeAuthority bound. Apply G to every scope, config, request, stored/receipt/reference/result tuple and version component. `W` is a MetricWindowSchema with both endpoints also passing T. Reuse EventEntitySchema for STORE/SKU/CAMPAIGN/CONNECTION shape with its exact ID keys. Same binding means equality on **all five** ConnectorBindingSchema keys. Compare instants numerically or as canonical four-digit-year T values. Preserve valid IDs, reject malformed input without normalizing a different identity into the same one.

```ts
const utcMs = z.iso.datetime({ precision: 3 }).refine(
  (s) => !s.startsWith("0000") && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s,
);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const joinedRevision = z.string().regex(/^p2-observed-v1:[a-f0-9]{64}$/u);
const generation = QuantitySchema.max(2147483647);
const observedVersion = z.string().max(80).refine((value) => {
  const parts = /^observed-v1:g:(0|[1-9]\d*):e:([1-9]\d*)$/u.exec(value);
  return parts !== null && generation.safeParse(Number(parts[1])).success
    && Number.isSafeInteger(Number(parts[2]));
});
const scope = { binding: ConnectorBindingSchema, generation };
const exactWindow = MetricWindowSchema.refine(
  ({ periodStart, periodEnd }) => [periodStart, periodEnd].every((t) => utcMs.safeParse(t).success),
);
```

- [ ] Build a `z.discriminatedUnion("domain", …)` of strict objects. Each is exactly `{schemaVersion:1, ledgerVersion:"observed-facts-v1", binding, generation, domain, subject, factId:ID, sequence:Q>=1, priorVersion:observedVersion|null, sourceVersion:observedVersion, producerVersion:V, modelVersion:"mock-business-observed-v1", occurredAt:T, observedAt:T, payloadHash:Hash, payload}`. Require sourceVersion equal to `observed-v1:g:<generation>:e:<sequence>` instantiated from those numeric fields. Non-null priorVersion must be in the same generation with positive safe sequence strictly smaller than current (a stream sequence may skip between versions of one fact). Null means first version of that fact, also possible at sequence >1. Attaching prior to the actual same fact/domain/subject and checking no fork is the durable writer’s responsibility. Check `occurredAt <= observedAt`. Every observed event/measurement timestamp listed below is <= observedAt. A surrounding publication, page or capture checks observedAt <= its supplied business cutoff. No wall-clock dependency.

**Payload matrix.** All fields in each row required, every nested object strict. A question mark on a type means required but nullable. `reason` is a nullable **finite source-quality** code selected from the existing MetricIssueCodeSchema using the row’s named codes. A missing measurement field requires its row’s reason; fully known confirmed measurements have reason null. Partial/estimated quality retains a reason. Optional business associations, prior states and forecasts have their own rules as specified below. Avoid duplicating facts inside payloads where the subject already supplies the ID.

| Domain / subject | Payload fields | Invariants and quality |
|---|---|---|
| FROZEN_COST / SKU | externalOrderId, externalLineId, externalSkuId:ID; quantity:Q>=1, frozenAt:T, skuCostVersion:V?, unitCostMinor:M?, basis:CONFIRMED/ESTIMATED/UNAVAILABLE, currency:CNY, reason | Enforce historical version and amount for both known bases. UNAVAILABLE amount null/COST_MISSING. ESTIMATED → COST_ESTIMATED. Match SKU. |
| REFUND_ALLOCATION / SKU | externalRefundId, externalOrderId, externalLineId, externalSkuId:ID; quantity:Q?, merchandiseMinor:M?, buyerShippingMinor:M?, settledAt:T, currency:CNY, reason | Match SKU. Unknown allocation → REFUND_UNKNOWN. The settlement event supplies explicit allocation, including line quantity and buyer shipping. |
| RETURN_RECEIPT / SKU | externalReceiptId, externalRefundId, externalOrderId, externalLineId, externalSkuId:ID; acceptedAt:T?, resellableQuantity:Q?, reason | Non-null quantity requires actual acceptedAt incl. measured zero. Unknown → RETURN_UNKNOWN. Cross-fact quantity conservation uses original payment/refund in producer/commit. |
| FEE / STORE | chargeId:ID, kind:MetricFeeKindSchema, externalOrderId:ID?, externalCampaignId:ID?, window:W, amountMinor:M?, basis as cost, coverageBasisPoints:BP, reason | Use fee DTO basis/null mapping; periodEnd <= observedAt. FEE_MISSING, FEE_ESTIMATED or PARTIAL_COVERAGE. Order can be null for period charges. Campaign-linked advertising carries a single charge identity. |
| TRAFFIC / STORE or SKU | window:W, visitors:Q?, cart:Q?, checkout:Q?, paidOrders:Q?, measurementVersion:V, coverageBasisPoints:BP, reason | Close window before observation. Each counter measures its own events during W. Checkout or payment may follow a cart from an earlier window. The causal producer owns its cohort-specific transition invariants. Null stage → TRAFFIC_MISSING, partial coverage → PARTIAL_COVERAGE. Distinct STORE and SKU measurements retain their own subject. |
| CAMPAIGN_MEASUREMENT / CAMPAIGN | externalCampaignId:ID, businessDate:ISO YYYY-MM-DD, window:W, spendMinor:M?, attributedRevenueMinor:M?, eligibleCount:Q?, measuredCount:Q?, measurementVersion:V, attributionPolicyVersion:V, coverageBasisPoints:BP, currency:CNY, reason | Matching campaign. Closed interval wholly within named Shanghai day. Partial intervals remain representable. Known measured <= eligible; nulls → ATTRIBUTION_MISSING; partial → PARTIAL_COVERAGE. |
| LISTING / SKU | externalSkuId:ID, listedAt:T, effectiveAt:T, fromStatus:UNLISTED/LISTED/DELISTED, toStatus:LISTED/DELISTED | Distinct actual states, listedAt <= effectiveAt <= observedAt. First UNLISTED→LISTED has listedAt=effectiveAt. |
| PRICE / SKU | externalSkuId:ID, effectiveAt:T, priorPriceMinor:M?, priceMinor:M, priceVersion:V, currency:CNY | Null prior for first observed price. Match SKU. |
| INVENTORY_LOT / SKU | externalSkuId, externalLocationId, externalLotId, externalReceiptId:ID; receivedAt:T, movementAt:T, reason:RECEIPT/SALE/RETURN/WRITE_OFF/TRANSFER_IN/TRANSFER_OUT, deltaQuantity:SignedMinorSchema, beforeQuantity:Q, afterQuantity:Q | receivedAt <= movementAt <= observedAt. Nonzero signed units (reuse safe signed number range); inflow positive, outflow negative. `BigInt(beforeQuantity) + BigInt(deltaQuantity) === BigInt(afterQuantity)`. Receipt identity and original receivedAt survive subsequent movements. Chain continuity and multi-lot conservation belong to 021/025. |
| SUPPLIER_NOTICE / SKU | externalSkuId, externalLocationId, noticeId, purchaseOrderId:ID; announcedAt:T, priorEta:T?, newEta:T?, inboundQuantity:Q?, promisedLeadHours:H?, reason | announcedAt <= observedAt. Prior ETA nullable for a first notice. New ETA and prior ETA may be in the future. Unknown current ETA/lead → LEAD_TIME_MISSING, unknown units → INVENTORY_UNKNOWN. |
| INVENTORY_POSITION / SKU | externalSkuId, externalLocationId:ID; asOf:T, quarantine:Q?, inbound:Q?, safetyBufferHours:H?, reason | asOf <= observedAt; INVENTORY_UNKNOWN or LEAD_TIME_MISSING for unknown fields. Preserve measured zero and observed asOf separately. |
| SYNC_TRANSITION / CONNECTION | jobId:ID, fence:Q, stream:PRODUCTS/ORDERS/REFUNDS/INVENTORY/MARKETING, status:FAILED/SUCCEEDED, errorCode:ConnectorFailureCodeSchema?, successfulThrough:T?, watermark:T?, businessObservedAt:T, transitionSequence:Q>=1 | connectionId matches binding. FAILED requires typed code, SUCCEEDED requires null. successfulThrough/watermark if known <= businessObservedAt = observedAt. Initial failure can have both null. A generic pipeline failure becomes TEMPORARY in 026. |

For nullable data rows use one finite reason per fact, choosing a relevant missing-field reason first, then estimated basis, then partial coverage. For a subset of unknown supplier or inventory fields, require a reason applicable to one of the actual gaps. Keep structural nullable associations (e.g. period fee’s orderId) outside this missing-measurement rule. A zero **charge/transaction quantity** can be a directly observed scalar; interpreting an empty measurement/window or zero traffic/campaign counters as completely measured requires certified receipts at capture/selection. Worker data alone cannot certify it.

- [ ] Freeze v3 as a strictly generation-scoped, opt-in envelope `{generatorVersion:"mock-source-v3", generation:G, configHash:Hash, config:{modelVersion:"mock-business-observed-v1", binding, seed, profile, historyStart, days, productCount, variantsPerProduct, dailyOrders, growthBps, refundBps, adSpendMinor, scenarioPlan}}`. Seed 0..4294967295, profile growing/problematic/mature/new, local-midnight historyStart (T at 16:00:00.000Z), days 1..365, products 1..100, variants 1..3, dailyOrders 1..300, growthBps 0..10000, refundBps 0..5000, adSpendMinor 0..100000000. Safe integer ranges. Require days × ceil(dailyOrders × 1.35) <=150000 and historyStart + (days+5) days fits year 9999. For v3 only, scenarioPlan is MockScenarioPlanSchema.nullable(); require matching externalStoreId, endDay <= days and each mutation.skuIndex < productCount × variantsPerProduct. Existing scenarioPlan bounds apply. P03-032 owns the separate test-driver policy for ten deliveries and actual interruption/replay controls. Keep config entirely outside observation, selection and provider records.
- [ ] Define v3 hashing preimage in the plan’s config field order above, UTF-8 JSON of the strict inner config, including explicit null scenarioPlan and modelVersion, without whitespace. Binding order organizationId/workspaceId/storeId/connectionId/externalStoreId, scenario and mutation keys in the existing MockScenarioPlanSchema/MockScenarioMutationSchema declaration order and delivery variant key order, array order significant. Generation and hash are envelope identity and attestation metadata. P03-031/035 compute and compare hash to the pinned generation. 019 validates the wire literal, format and matching references only. Read-only v1/v2 hashes stay under their current database owner.

**Concrete fixtures.** Use these constants in the spec; literal examples in the tables reference them directly.

```ts
const binding = {
  organizationId: "org-A", workspaceId: "ws-A", storeId: "store-A",
  connectionId: "conn-A", externalStoreId: "shop-A",
};
const start = "2026-11-01T16:00:00.000Z";
const end = "2026-11-02T16:00:00.000Z";
const later = "2026-11-04T16:00:00.000Z";
const window = { periodStart: start, periodEnd: end, timezone: "Asia/Shanghai", currency: "CNY" };
const sku = { kind: "SKU", externalSkuId: "sku-A" };
const hash = "a".repeat(64);
const common = {
  schemaVersion: 1, ledgerVersion: "observed-facts-v1", binding, generation: 0,
  factId: "f1", sequence: 1, sourceVersion: "observed-v1:g:0:e:1", priorVersion: null,
  producerVersion: "mock-finance-v1", modelVersion: "mock-business-observed-v1",
  occurredAt: end, observedAt: end, payloadHash: hash,
};
const cost = {
  ...common, domain: "FROZEN_COST", subject: sku,
  payload: { externalSkuId: "sku-A", externalOrderId: "o1", externalLineId: "l1",
    quantity: 2, frozenAt: end, skuCostVersion: "cost-7", unitCostMinor: 180,
    basis: "CONFIRMED", currency: "CNY", reason: null },
};
it("requires the original schedule for a priced line", () => {
  expect(ObservedFactV1Schema.safeParse(cost).success).toBe(true);
  const stale = { ...cost, payload: { ...cost.payload, skuCostVersion: null } };
  expect(ObservedFactV1Schema.safeParse(stale).success).toBe(false);
});
```

| Other table cases (fill the exact row fields above) | Success | Reject one mutation per case |
|---|---|---|
| Refund / return with SKU sku-A, order o1, line l1, refund r1, receipt rr1 | Refund qty 1, merchandise 180, shipping 5 at end. Accepted 1 at end. | Unsafe merchandise 9007199254740992; acceptedAt=later or null with quantity 1. |
| Fee charge ch1, FULFILLMENT, order o1, campaign null, CONFIRMED, W, 10000 BP, reason null | amount 0. UNAVAILABLE amount null/FEE_MISSING also parses. | UNAVAILABLE and amount 0. |
| Traffic for STORE and sku-A, W, measurement m1 | 10/4/2/1 and 10000 BP. Also accept visitors 10, cart 1, checkout 2, paidOrders 3 for the same complete W and 10000 BP. All null/0 BP/TRAFFIC_MISSING is unknown. | Closed W ends after observedAt; null visitors with null reason; subject CAMPAIGN. |
| Campaign c1, 2026-11-02, W, policy a1, measurement m1 | 100 spend/300 attributed, eligible 10/measured 8, 8000 BP/PARTIAL_COVERAGE. | measured 11, date 2026-11-03, mismatched campaign subject. |
| Listing and price for sku-A | UNLISTED→LISTED at end; price 199 prior null/price-v1 at end. | Equal status or SKU payload sku-B. |
| Lot lot1/location loc1/receipt in1, receivedAt=start, movementAt=end | SALE 5−2=3. | SALE +2; afterQuantity 4; unsafe delta. |
| Notice n1/po1 at end; position asOf=end, same SKU/location | old ETA end/new ETA later, inbound 8/lead 24; quarantine 0, inbound 8, safetyBufferHours 1.5. | announcedAt later; position.asOf later or negative safety buffer. |
| Connection conn-A, job j1, fence 0, ORDERS, seq 1 | FAILED/TEMPORARY/no success or watermark at end; SUCCEEDED/null at end also passes. | error raw text; SUCCEEDED with error; different connection; errorCode null on FAILED. |
| Every domain | Unique realistic IDs, occurrence <= observation, zod parse succeeds. | Extend top level or nested payload with customerId, sessionId, scenarioId, expected, forbidden, failureRules, rawError, forecastStockout, profit, credentials. Reject unknown tags, missing own required ID, unsafe integer, submillisecond/offset/noncanonical time, future occurrence, same/future/cross-generation prior, malformed hash, synthetic version that identifies a different sequence. Numeric boundaries also cover NaN, Infinity, wrong primitive types and fractions where an integer is required; safeParse must return failure rather than throwing a refinement exception. Fractional finite hours remain valid. |
| Generation boundary | For a fresh fact, generation 2147483647 with sourceVersion `observed-v1:g:2147483647:e:1` passes. | Reject generation 2147483648 with its matching `observed-v1:g:2147483648:e:1`. Also reject 2147483648 in config, scope/reference tuple or standalone observedVersion, and -1 for generation. |
| Explicit v3 envelope | generation 0, hash, model literal, binding, seed 0, growing, historyStart=start, days 120, 10 products, 2 variants, 30 orders, growth/refund 0, spend 100, scenarioPlan null. | v1/v2 as generator, missing/wrong model, wrong hash format, unbounded seed, wrong external store/invalid SKU index in scenario, expected-answer fields. |

- [ ] Run focused tests and contracts typecheck. Verify new exports from the root after adding only the fact-schema export to the held index. Commit the independently green fact/config increment with `git add -- packages/contracts/src/observations/observed-fact.schema.ts packages/contracts/src/observations/observed-fact.schema.spec.ts packages/contracts/src/index.ts` then `git commit -m "feat(contracts): freeze observed facts and causal generation configuration"`.

### Task 2. Bind sealed publications, receipts, captures and subject selection

**Interfaces.** Export the request/result schemas named in this section. Use checked data objects through Task 3’s type-only ports. Fields written as `…scope` are the explicit binding/generation pair above. `…partition` adds domain, subject, window to scope. Match domain/subject using Task 1’s matrix. Store joins must compare structured IDs (including connection/campaign/SKU) and all window fields. Use nested readonly objects/arrays; apply `.readonly()` after refinement. Only listed keys are admitted. ID lists use bounded length and uniqueness. Use maps keyed by unique IDs for joins, with fail-closed duplicate detection.

Observed STORE subjects carry `storeId`, while `MetricSubjectSchema` represents STORE with only its kind. Resolve that implicit metric store from the shared binding when comparing these two subject shapes; an observed STORE ID must always equal `binding.storeId`.

- [ ] Add a failed publication test and a success example for a certified zero-row traffic partition. Include mismatching binding, domain, generation, subject, hash and cutoff variants below. Run the focused test expecting missing schema exports.
- [ ] Define the following finite wire surfaces. Scope, business times and explicit version/hash pins travel across process boundaries; raw service credentials do not.

| Schema/type stem | Exact wire fields | Local checks |
|---|---|---|
| ObservedPublicationRequestV1 | `{grantId:ID, …partition, modelVersion:"mock-business-observed-v1", configHash:Hash, through:T, expectedSequence:Q>=1}` | window.periodEnd <= through. Grant ID resolves to a scoped service principal at runtime. No worker-supplied terminal, digest set or certificate. |
| ObservedPublicationV1 | `{…partition, publicationId:ID, publicationHash:Hash, modelVersion, configHash, producerVersion:V, through:T, clockRevision:Q, firstSequence:Q>=1, pageCount:Q>=1, recordCount:Q, chainHash:Hash, availableAt:T, recordedAt:T}` | availableAt is business publication availability, so through <= availableAt; recordedAt is DB security time. Keep these clock axes independent. Window closed by through; impose page/record limits below. An empty complete partition still has one terminal page. |
| ObservedPublicationReadV1 | `{grantId:ID, …partition, publicationId:ID, publicationHash:Hash, pageIndex:Q}` | Resolved against the sealed publication, scope and grant. |
| ObservedPublishedPageV1 | `{publication:ObservedPublicationV1, pageId:ID, pageIndex:Q, pageHash:Hash, priorPageHash:Hash?, expectedCursor:CursorSchema?, nextCursor:CursorSchema?, records:ObservedFactV1[], terminalCoverage:null\|{coverageBasisPoints:BP}}` | 0-based pageIndex < pageCount. First page has null prior hash/cursor; later pages have both. Nonterminal page needs nextCursor and null terminalCoverage; terminal page has null nextCursor and typed terminalCoverage, possibly partial. Every record matches partition binding/generation/domain/subject, model/producer version, observedAt<=through; no duplicate sourceVersion, strictly increasing stream sequence on page. Nonempty records >= firstSequence; first nonempty page at index 0 starts at firstSequence. Measurement records must fall within their certified measurement partition; transaction/supply records may precede periodStart where late observation or surviving lot history requires that evidence. |
| AppendObservedPageV1 | `{grantId:ID, fence:Q, …partition, publicationId:ID, publicationHash:Hash, through:T, expectedCursor:CursorSchema?, pageId:ID, pageIndex:Q, pageHash:Hash, priorPageHash:Hash?, nextCursor:CursorSchema?, records:ObservedFactV1[], terminalCoverage:null\|{coverageBasisPoints:BP}}` | Compare nested record scope and cutoff, check first-page/link and terminal/cursor shape. Reject recordedAt/receiptId on request and records. Consumer submits exact certified page bytes/coverage. Service resolves certificate, compares every field including through, authenticates live lease/fence and independently certifies completeness. |
| ObservedReceiptV1 | `{…partition, receiptId:ID, publicationId:ID, publicationHash:Hash, modelVersion, configHash, pageId:ID, pageIndex:Q, pageHash:Hash, priorPageHash:Hash?, expectedCursor:CursorSchema?, nextCursor:CursorSchema?, through:T, recordedAt:T, recordCount:Q, factRefs:[{factId:ID,sourceVersion:observedVersion,payloadHash:Hash}], terminalCoverage:null\|{coverageBasisPoints:BP}}` | Matching link/cursor/terminal fields, recordCount = factRefs.length, unique (factId,sourceVersion) and sourceVersion, all versions match generation. DB fills receiptId, recordedAt and links at atomic commit. |
| StoredObservedFactV1 | `{fact:ObservedFactV1, receiptId:ID, recordedAt:T}` | Returned persisted record. In a capture resolve receiptId to matching receipt scope and exact factId/sourceVersion/payloadHash. |
| ObservedCaptureRequestV1 | `{actor:TenantContextSchema, …scope, window:W, visibleAt:T, domains:ObservedDomain[], comparisonWindows:[{window:W,visibleAt:T}]}` | At least one unique known domain. Comparison windows unique and closed by own cutoff <= current visibleAt; window.periodEnd <= visibleAt. Actor organization/workspace match binding. Actor only in server read request; authority rechecked in DB. |
| ObservedReadRequestV1 | Same identity as capture request plus `inputRevision:p2-observed-v1:<sha256>` | Exact sealed identity including domain set and comparison requests. Never compute a new historic capture for a missing revision. |
| ObservedCaptureV1 | `{…scope, window:W, visibleAt:T, domains:ObservedDomain[], inputRevision:joinedRevision, ledgerVersion:"observed-facts-v1", mappingVersion:"p2-observed-v1", definitionVersion:"metrics-g4-observed-v2", definitionSelectorVersion:V, modelVersion, configHash:Hash, clockRevision:Q, capturedAt:T, base:BaseRef?, comparisons:ComparisonRef[], publications:ObservedPublicationV1[], receipts:ObservedReceiptV1[], facts:StoredObservedFactV1[], coverage:Coverage[]}` | Base required unless all domains SYNC_TRANSITION. capturedAt is DB time. Resolve source graph/coverage below. Seal hash over all identity fields, base receipts, comparison refs, observed receipts/selected fact hashes, model/config/mapping/selector/clock and coverage. The reader owns canonical hashing. |
| ObservedSelectionRequestV1 | `{…ObservedReadRequestV1, subject:MetricSubjectSchema, kind:MetricCoverageV1Schema.unwrap().shape.kind}` | Resolve subject at the requested joined revision and window, revalidate actor. A caller cannot supply metric answers, source facts or its own receipt list. |
| ScopedMetricInputV1 | Exactly `{subject:MetricSubjectSchema, input:MetricInputV1Schema, selectionReceiptIds:ID[]}` | Input revision matches joined format, definitionVersion exact, bounded metric/source evidence; nonempty unique receipt IDs on successful selection. Singleton matching subject/kind coverage for complete projection. For missing inputs use explicit unavailable status/null/reason in sealed coverage or return SOURCE_UNAVAILABLE. Never silently replace missing input with []. |
| ObservedSelectionProofV1 | Internal returned-graph verification envelope `{request:ObservedSelectionRequestV1, capture:ObservedCaptureV1, selection:ScopedMetricInputV1}` | Prove joins described below before exposing the three-key selection. Wire shape for downstream leaf stays exactly as approved. |

`modelVersion` throughout means literal `mock-business-observed-v1`. For arrays define page size <=200, publication pages <=4096, publication recordCount <=819200, capture receipts/publications/coverage <=4096 per collection, selected facts <=50000 and comparison windows/refs <=4. Cap selection receipt IDs and bounded nested evidence lists at 4096. Domain list capped at enum cardinality. Preflight raw envelopes and legacy MetricInputV1 arrays before expensive nested decoding (at most 50000 facts across the ten named collections and 4096 metricCoverage entries, 4096 IDs per evidence list). Include a bounded UTF-8 wire limit at the adapter/reader deserialization boundary before JSON decoding; port implementations should admit at most 16 MiB per request/result and return OVERFLOW on excess, without truncation. The 019 schema validates bounded supplied JS value shapes; JSON transport limits belong to its actual entry point. Use stable error codes only.

**Closed nested records.**

- BaseRef = `{…scope, window:W, visibleAt:T, inputRevision:"p2-normalized-v1:<sha256>", receipts:[{stream:ORDERS/REFUNDS/INVENTORY/MARKETING, pageId:ID, pageHash:Hash}]}`. Scope/window/cutoff equal parent, all four streams represented, (stream,pageId) unique. No four-stream receipt fabrication for failed initial sync.
- ComparisonRef = `{…scope, window:W, visibleAt:T, inputRevision:joinedRevision, definitionVersion:"metrics-g4-observed-v2"}`. Must match parent binding/generation, own periodEnd <= own visibleAt <= parent visibleAt, distinct windows/revisions, different revision from parent; request/proof verifies requested window/cutoff pairs exactly. Decisions such as historical median selection remain with P03-034.
- Coverage = `{…partition, status:COMPLETE/PARTIAL/UNAVAILABLE, coverageBasisPoints:BP, receiptIds:ID[], reason:MetricIssueCodeSchema?}`. COMPLETE = 10000/null with a nonempty ordered sealed receipt chain, including a terminal receipt for the exact subject/window. PARTIAL <10000 with PARTIAL_COVERAGE and any referenced known pages; UNAVAILABLE = 0/typed reason, no claim of complete measurement. Distinguish an entirely missing partition from a certified empty one. A capture includes evidence or an explicit unavailable entry per requested domain; a requested subject without an entry remains unavailable. A store-wide aggregate, a certificate from another SKU or a terminal receipt for another interval cannot count toward a SKU.
- For each receipt resolve exact certificate, compare all partition keys, model/config/hash/through and page bounds. Every selected fact must resolve into actual receipt.factRefs on the identical partition, with matching source version/hash/producer and visible observation. Permit receipts to reference additional superseded/unselected fact versions. Reject duplicate IDs and duplicate selected logical fact identities within scope/domain; selected records must have observedAt <= visibleAt. Require publication.availableAt <= visibleAt and publication.through <= visibleAt. Domain-specific cutoffs (acceptedAt/announcedAt/measurement end) were already checked by the individual schema. DB recordedAt/capturedAt are never compared to simulator visibleAt.
- For each COMPLETE coverage, resolve ordered receiptIds to one exact sealed publication for that partition. Start page index 0, null previous hash/cursor. Require each next page’s index=previous+1, priorPageHash=previous.pageHash and expectedCursor=previous.nextCursor. Require byte-identical publication hash/model/config, terminal at pageCount−1, non-null terminal coverage 10000, total receipt.recordCount=publication.recordCount. Explicitly represent zero facts with one zero-row terminal receipt (or a measured traffic fact whose zero counters are backed by the matching complete receipt). Partial or absent coverage cannot support a verified zero. The proposed v1 certificate partitions by domain/subject/window so multiple pages can be certified without worker-supplied cross-partition unions. Runtime additionally verifies the chain digest against the authoritative source; structural parsing cannot authenticate a certificate.
- For each measured flow with null/estimated/partial fields, keep source quality independently of publication completeness. In particular a complete list of unavailable frozen costs or partial campaign measurements cannot certify known cost or fully measured attribution. Enforce known/10000 traffic and campaign measurements in an output advertised VERIFIED for that collection. A certified empty measured partition requires the publisher to attest actual monitoring of its specific interval.
- Before returning ScopedMetricInputV1 verify request/capture/input share binding, window, visibleAt, revision and definition. Request generation equals capture generation. Match the selected coverage/receipt subject to request.subject and selection.subject, the requested metric kind to singleton metricCoverage, and every selected receipt to the exact capture’s coverage for its domain/subject/window. For traffic use source coverage for TRAFFIC: exact measurement interval/cutoff, complete selected receipt set, `input.traffic[].evidenceIds` tied to the selected receipt IDs and matching source facts for its measured counters. Preserve joined inputRevision and reachable evidence. An intentionally whole original multi-line order may be an immutable base fact for SKU attribution. Preserve its original identity, amounts and line items. Unsupported SKU fee/campaign allocations cannot be implied by a STORE receipt. A complete zero traffic projection with an empty input collection needs the certified zero-row receipt. Include binding/generation/subject/hash swaps with the same textual receiptId in tests.
- Compare selection evidence to the authorized capture before projection or when validating the proof. Every selectionReceiptId must be reachable; all required complete coverage IDs must be represented. Keep selected fact/payload hash reachable beneath the receipt. Treat coverage-only, unsupported or missing sources as typed unavailable; use a domain/collection mapping in selection proof for observed leaves (`traffic→TRAFFIC`, `campaignFacts→CAMPAIGN_MEASUREMENT`, `fees→FEE`, `frozenCosts→FROZEN_COST`, `refundAllocations→REFUND_ALLOCATION`, `returnReceipts→RETURN_RECEIPT`, `inventoryExtensions→INVENTORY_POSITION/SUPPLIER_NOTICE`). Base-only payment/refund/inventory source receipts can be resolved by (stream,pageId) in BaseRef; scope comes from the sealed base, and SKU quantities still come from actual order/refund lines. Mixed observed/base IDs must resolve unambiguously. For whole-store financial calculations over individual SKU costs, preserve per-line source refs and let the authorized adapter aggregate confirmed records for the requested store. Exact subject identity is mandatory for measured partitions and SKU selection; no proportional allocation.
- Keep `readObserved` returning raw stored facts under their original subject. The finite mapping, independent P03-027 mapper and P03-028 calculators own construction of inputs and metric values. 019 validates structural compatibility and the selected evidence graph available to it. It does not reimplement the metric calculators or infer financial facts from published totals.

- [ ] Add tests with a small certificate for STORE/TRAFFIC, `through=availableAt=end`, clockRevision=2, pageCount=1, recordCount=0, publicationId="pub1", publicationHash=hash, chainHash=hash, producerVersion="traffic-v1". Make a matching terminal receipt `receiptId="rc1", pageId="pg1", pageIndex=0, pageHash=hash, expectedCursor=null, priorPageHash=null, nextCursor=null, factRefs=[], recordCount=0, terminalCoverage={coverageBasisPoints:10000}, recordedAt=later`. The corresponding complete coverage row `receiptIds:["rc1"], coverageBasisPoints:10000, reason:null` passes as a witnessed empty window in the sealed capture. Set base revision and real synthetic refs for the four named streams for this fixture. Test proper nonempty two-page proof (page 0 nextCursor "c1", page 1 expectedCursor "c1", priorPageHash matching page 0), and exact incomplete coverage (remove last receipt and downgrade coverage to PARTIAL/8000/PARTIAL_COVERAGE). The latter keeps partial status and cannot validate a VERIFIED zero selection.
- [ ] Build a SKU traffic fixture using sku-A at every subject-bearing tier, one stored fact with 10/4/2/1 and `payloadHash=hash`, one matching receipt.factRef and selected IDs ["rc1"]. Use joined inputRevision `"p2-observed-v1:"+hash`, definition `metrics-g4-observed-v2`, observedAt/sourceWatermark=end, status VERIFIED, traffic singleton with its original evidence including rc1; metricCoverage singleton has kind CONVERSION_RATE, subject sku-A, collections ["traffic"], coverageBasisPoints 10000. Set other nine input collections null. Set all matching window/cutoff/versions/binding/evidence as required by MetricInputV1Schema. This sealed proof passes. The following single changes individually fail: inputRevision points elsewhere, relabel STORE as sku-A, reorder window start, swap binding’s externalStoreId or connectionId, mutate generation on nested receipt, change sourceVersion/hash in matched factRef, replace selectionReceiptIds with an unknown ID or append extra unmatched receipt, use a receipt for sku-B’s same ID, change observed facts’ paidOrders to 9 while metric input still reports 1, drop proof for measured zero, mark nulls VERIFIED, include a historical comparison from another store.
- [ ] Exercise standalone initial SYNC_TRANSITION, one real connection failure at end, `base:null`, zero commerce facts and real transition receipt. Capture passes; replacing domains with [TRAFFIC] and removing the base fails. Later records, publication after visibleAt, publication availableAt before its through cutoff, stale revisions, duplicate domains/IDs, unsafe counts, 201 page records and five comparison windows fail. Cross-cutoff: capture at end rejects an observation at later even when occurredAt=start, yet accepts the earlier notice with ETA=later. At least one case has recordedAt later than visibleAt and passes.
- [ ] Run focused contracts tests and typecheck. Once independently green, stage only schema/spec and commit `feat(contracts): bind observed receipts and sealed subject evidence`.

### Task 3. Freeze typed producer, publisher, consumer and authorized reader ports

**Interfaces.** Use these type-only contracts from `observed-ports.ts`. For method parameters/results in the signatures below, export the matching DTO or generic alias. All DTOs have a strict schema in the schema file. The deployment-specific DB connection/principal is injected in the implementing service and never included in a payload.

```ts
export type ObservedErrorCode = "INVALID_INPUT" | "OVERFLOW" | "CONFLICT" | "VERSION_MISMATCH"
  | "NOT_FOUND" | "FORBIDDEN" | "SOURCE_UNAVAILABLE";
export type ObservedResult<T> = Readonly<
  { ok: true; value: T } | { ok: false; error: Readonly<{ code: ObservedErrorCode }> }
>;
type ObservedCall<I, O> = (request: I) => Promise<ObservedResult<O>>;
export interface ObservedPublisherPort {
  readonly publishObserved: ObservedCall<ObservedPublicationRequestV1, ObservedPublicationV1>;
  readonly readPublishedPage: ObservedCall<ObservedPublicationReadV1, ObservedPublishedPageV1>;
}
export interface ObservedConsumerPort {
  readonly appendObservedPage: ObservedCall<AppendObservedPageV1, ObservedReceiptV1>;
}
export interface ObservedReaderPort {
  readonly captureObserved: ObservedCall<ObservedCaptureRequestV1, ObservedCaptureV1>;
  readonly readObserved: ObservedCall<ObservedReadRequestV1, ObservedCaptureV1>;
}
export interface AuthorizedObservedSelectionPort {
  readonly selectObserved: ObservedCall<ObservedSelectionRequestV1, ScopedMetricInputV1>;
}
```

- [ ] For observed result boundaries use a closed error `z.strictObject({code:z.enum([...])}).readonly()` over the seven listed literal values. Test error with extra message, query, stack, payload or secret rejected. Align result `ok/value` with MetricResult. Contract input malformed → INVALID_INPUT; exceeded size/arithmetic bounds → OVERFLOW; stale fence/gap/fork/divergent replay → CONFLICT; wrong model/revision namespace → VERSION_MISMATCH; inaccessible resource → opaque NOT_FOUND or FORBIDDEN per endpoint; actual source/required configuration unavailable → SOURCE_UNAVAILABLE. Failure code remains available without debug detail, grant data or raw provider text.
- [ ] Declare producer event input and output boundaries. Shape notation uses Task 1 scalars and the three matching closed input schemas below. A deterministic source cursor is an opaque CursorSchema value (nullable to begin or finish); adapters must not decode it into metric claims. Use a scoped model run `ObservedProducerRunV1 = {config:MockObservedGenerationConfigV3, window:W, through:T, cursor:CursorSchema?, limit:Q 1..200}`. Check window end <= through. Full generator configuration belongs only on the synthetic producer side.

| Type stem | Closed shape and constraints |
|---|---|
| ObservedFinanceEventV1 | Envelope `{…scope, eventId:ID, observedAt:T, event}`. Discriminate event on kind: PAYMENT `{kind,externalOrderId,externalLineId,externalSkuId,quantity:Q>=1,paidAt:T}`; FEE_CHARGE `{kind,chargeId,feeKind:MetricFeeKindSchema,externalOrderId:ID?,externalCampaignId:ID?,window:W,chargedAt:T}`; REFUND_SETTLEMENT `{kind,externalOrderId,externalLineId,externalSkuId,externalRefundId,quantity:Q,merchandiseMinor:M?,buyerShippingMinor:M?,settledAt:T,reason:REFUND_UNKNOWN?}`; RETURN_ACCEPTED `{kind,externalOrderId,externalLineId,externalSkuId,externalRefundId,externalReceiptId,acceptedAt:T,resellableQuantity:Q}`. All unannotated ID fields use ID. For explicit null allocation require REFUND_UNKNOWN. Event time/window <= observation. An event carries no current selling-price substitute for frozen cost. |
| ObservedFinanceProducerRequestV1 | `{run:ObservedProducerRunV1, event:ObservedFinanceEventV1}`. Scope and generation equal pinned run, event observedAt<=run.through. Service reads the immutable acquisition/fee schedules selected by the config; returns only FROZEN_COST/REFUND_ALLOCATION/RETURN_RECEIPT/FEE. |
| ObservedProducedPageV1 | `{records:ObservedFactV1[0..200], nextCursor:CursorSchema?}`. Each producer filters its output domain at its typed port, keeps run scope/cutoff and never returns a receipt or completeness authority. |
| ObservedDemandPageV1 | `{records:(TRAFFIC or CAMPAIGN_MEASUREMENT fact)[0..200], financeEvents:ObservedFinanceEventV1[0..200], orders:ConnectorOrderSchema[0..200], nextCursor:CursorSchema?}`. Original orders come from the causal checkout process. Actual settlement/acceptance events can also be delivered independently to the finance port. Scope/externalStoreId/generation/time agree with run across output wherever carried; ConnectorOrder carries the external store and payment times. |
| ObservedSupplyProducerPort output | Same produced-page shape narrowed to LISTING, PRICE, INVENTORY_LOT, SUPPLIER_NOTICE or INVENTORY_POSITION. Demand receives instantiated supply/finance ports at composition, observes prices/quantities announced by the current business cutoff and advances visitors through cart/checkout/payment. Schedule lookup, reducer state management, calibration, lot conservation across pages and distinct visitor counting belong to 023–025/036. |

```ts
type FactPage<D extends ObservedDomain> = Readonly<{
  records: readonly Extract<ObservedFactV1, { readonly domain: D }>[];
  nextCursor: string | null;
}>;
type FinanceDomain = "FROZEN_COST" | "REFUND_ALLOCATION" | "RETURN_RECEIPT" | "FEE";
type SupplyDomain = "LISTING" | "PRICE" | "INVENTORY_LOT" | "SUPPLIER_NOTICE" | "INVENTORY_POSITION";
export interface ObservedFinanceProducerPort {
  readonly reduceFinance: ObservedCall<ObservedFinanceProducerRequestV1, FactPage<FinanceDomain>>;
}
export interface ObservedSupplyProducerPort {
  readonly produceSupply: ObservedCall<ObservedProducerRunV1, FactPage<SupplyDomain>>;
}
export interface ObservedDemandProducerPort {
  readonly produceDemand: ObservedCall<ObservedProducerRunV1, ObservedDemandPageV1>;
}
export interface ObservedCausalDependencies {
  readonly supply: ObservedSupplyProducerPort;
  readonly finance: ObservedFinanceProducerPort;
}
```

A sync transition has separate SYNC_TRANSITION domain/CONNECTION identity. P03-026 appends its immutable FAILED/SUCCEEDED observation in the pipeline job transaction. The public fact/receipt/capture types can represent initial failure without any normal bundle. Keep scenario plan and delivery/failure controls outside every fact, metric projection and provider. Do not accept a third-party arbitrary JSON payload or a derived event (e.g. “stockout risk”, margin-drop, expected winner) at any observation port.

- [ ] Record runtime guarantees in short method JSDoc. P03-035 certifies immutable publication from a pinned server-verified generation/model/config and authoritative business clock, deriving contiguous content/hash/terminal coverage. P03-021 compares requested and certified bytes, prior links, lease/fence, domain and grant, atomically commits facts, page receipt and cursor. Exact retry returns original receipt; divergence conflicts. Corrections are append-only superseding versions. P03-022 first captures at authoritative current business cutoff, permits historic reads only by sealed identity/original receipts and revalidates actor membership/full binding/current generation and grant as appropriate. P03-027 reauthorizes before selecting a subject with the receipt graph. SECURITY_UTC/locking instructions are binding for those implementations. P03-020 owns immutable storage and DB roles, 031/032 own v3 admission/driver, 036 wires causal composition. These are downstream proof owners.
- [ ] Add typed `expectTypeOf<Parameters<ObservedConsumerPort["appendObservedPage"]>[0]>().toEqualTypeOf<AppendObservedPageV1>()` and `expectTypeOf<ReturnType<AuthorizedObservedSelectionPort["selectObserved"]>>().toEqualTypeOf<Promise<ObservedResult<ScopedMetricInputV1>>>()`. Assert public schemas via `import * as api from "../index.js";` and matching port types from the same root. Parse a synthetic PAYMENT (generation 0, paidAt=end, observedAt=end, SKU sku-A, quantity 1) and reject a later paidAt, cross-generation scope, scenario hint or raw failure-rule string. For each producer return subset test a valid source domain and a disallowed domain (e.g. SYNC_TRANSITION in demand). Type and schema should both reflect the domain restriction.
- [ ] Build errors and successful pages only from strict types. The FactPage branches can export separate `ObservedFinancePageV1Schema` and `ObservedSupplyPageV1Schema` with the exact two-field shape and narrowed union of Task 1’s branch schemas, allowing the runtime decoder and TS output to share the restriction. Check run/output relations at each producing adapter; check returned scoped-selection graph at each selecting adapter.
- [ ] Add the port type export to root; run the proof commands below. Stage only the four card paths changed in this increment and commit `feat(contracts): expose causal publication and authorized observation ports`. A separately verified review correction gets a separate commit.

### Verification and handoff

From the claimed worktree:

```powershell
pnpm --filter @shopmate/contracts test src/observations/observed-fact.schema.spec.ts
pnpm --filter @shopmate/contracts test
pnpm --filter @shopmate/contracts typecheck
pnpm --filter @shopmate/contracts lint
pnpm --filter @shopmate/contracts build
pnpm --filter @shopmate/contracts exec node --input-type=module -e "import * as c from '@shopmate/contracts'; for (const k of ['ObservedFactV1Schema','ObservedReceiptV1Schema','ObservedCaptureV1Schema','ScopedMetricInputV1Schema','MockObservedGenerationConfigV3Schema','MetricInputV1Schema']) if (!c[k]?.safeParse) throw Error(k)"
git diff --check 8f4dc016b05cabd4a00d8e67586c1f7d80da948b
git diff --name-only 8f4dc016b05cabd4a00d8e67586c1f7d80da948b
```

- [ ] Expect exit 0 from each proof, nonzero passing assertions for every new critical path and no skipped/todo/pending tests. Base recorded by the coordinator: contracts full 43 files / 1480 tests passed, build/typecheck exit 0. Record actual post-change counts and any limitations. Include old v1 public schema behavior in full contracts regression. Check the diff for only the planned document and four owned/shared source paths. If the repository enforces formatting, run the workspace-pinned prettier only on the touched files.
- [ ] Coordinator independently reviews source and PR, runs latest-head CI, merges through the normal authorized workflow and verifies native status before Done. Keep the four-hour estimate as a planning cap. Publish no claims of isolated DB, runtime hashing, real causal results, deployed state or production grants from 019 tests. The existing authorized automatic workflow continues on reviewed green merge.


# P03 finance golden cases v1

These are local synthetic regression examples for issue #212, implementing the operating definitions in [G4](../architecture/2026-10-03-production-mock-review.md#g4-财务定义). They are not accounting revenue recognition, tax calculations, or reconciliation with a merchant's actual settlement statement.

The test-only [fixture](../../apps/api/test/fixtures/metrics/finance-golden.fixture.ts) exports `FinanceGoldenFixtureV1`, `financeGoldenWindows`, eleven named fixtures, and `financeGoldenFixtures`. Inputs conform to the public [MetricInputV1 schema](../../packages/contracts/src/metrics/metric.schema.ts); context and expected measures follow the [metric ports](../../packages/contracts/src/metrics/metric-ports.ts). No source reader, calculator, production source, Scenario expected field, provider, clock, or catalog lookup produces these inputs. Expected numbers are independent literals.

## Fixed contract and source evidence

All money is integer **minor CNY (分)**: 12000 means ¥120.00. `schemaVersion = 1`, `fixtureVersion = finance-golden-v1`, `definitionVersion = g4-golden-v1`, and each case has its own immutable `inputRevision`. The definition version identifies this synthetic example, not a newly established production definition.

Objects, arrays, source DTOs, windows, contexts, and expectations are recursively frozen. All facts retain organization/workspace/store/connection/external-store binding, source version, observed time, and evidence IDs. All dates are fixed UTC values; business timezone is `Asia/Shanghai`. Inputs preserve independently observed collections: `[]` means observed empty, whereas `null` means unknown or outside this fixture's source domain. Unused inventory, campaign, traffic, and inventory extension collections are null.

The source-completeness records in `input.metricCoverage` describe the supplied observed collections for explicitly listed metric kinds, not calculated output quality. Their 10000 bps describes complete synthetic collection enumeration. A complete enumeration can include an explicitly unavailable cost or fee. Output coverage therefore remains 3333/8000 bps in the missing-value cases; no null is promoted to zero.

The immutable payment DTO was observed at payment time and carries `refundedMinor = 0`. Later refund facts carry their own observations and successful amounts. Consumers must use those facts for refund calculations rather than change historical paid revenue or treat the payment-time refund summary as a later total.

## G4 amount conservation

`g4-base` contains one paid order with these independently specified lines:

| Line           | Quantity | Unit price | Gross | Discount | Net merchandise | Frozen unit cost | Cost version          |
| -------------- | -------: | ---------: | ----: | -------: | --------------: | ---------------: | --------------------- |
| line-a / sku-a |        1 |       4000 |  4000 |     2000 |            2000 |             1000 | sku-a-cost-2026-09-v1 |
| line-b / sku-b |        2 |       4000 |  8000 |        0 |            8000 |             2500 | sku-b-cost-2026-09-v1 |
| Total          |        3 |          — | 12000 |     2000 |           10000 |  6000 total cost | —                     |

Refund `refund-a` succeeds for 2000, with an explicit allocation of 2000 merchandise to `order-a/line-a/sku-a` and 0 buyer shipping. No accepted return receipt exists in this base case.

| Measure                 | Hand calculation in minor CNY                                                         | Expected |
| ----------------------- | ------------------------------------------------------------------------------------- | -------: |
| GMV                     | 4000 + 8000                                                                           |    12000 |
| Paid revenue            | 12000 − 2000 + 500 buyer shipping                                                     |    10500 |
| Net revenue settlement  | 10500 − 2000 successful refund                                                        |     8500 |
| Net merchandise revenue | 12000 − 2000 discount − 2000 merchandise refund                                       |     8000 |
| COGS                    | 1 × 1000 + 2 × 2500                                                                   |     6000 |
| Gross profit            | 8000 − 6000                                                                           |     2000 |
| Contribution            | 2000 + 500 − 700 fulfillment − 300 platform − 100 payment − 800 advertising/promotion |      600 |
| Estimated net profit    | 600 − 200 configured other operating fee                                              |      400 |

Discount is already included in net merchandise revenue and is deducted **once**. It is not deducted again from profit. All listed base measures have VERIFIED quality, 10000 bps coverage, and sample size 1; paid orders = 1 and paid units = 3. VERIFIED describes the complete synthetic operating inputs. The metric named estimated net profit still does not represent actual accounting net profit.

## Cost, fee, return and cancellation cases

| Case ID / named export                                | Source difference                                                                    | Literal expectations and quality                                                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| g4-base / financeBaseGolden                           | Complete money example above                                                         | GMV 12000; paid 10500; orders 1; units 3; refund 2000; settlement net 8500; net merchandise 8000; COGS 6000; gross 2000; contribution 600; estimated net 400                              |
| missing-cogs / financeMissingCostGolden               | line-b cost record retained, with unit cost and cost version null, basis UNAVAILABLE | Paid 10500, settlement net 8500 and net merchandise 8000 remain VERIFIED/10000 bps. COGS, gross, contribution and estimated net are null, ESTIMATED/3333 bps, COST_MISSING tied to cost-b |
| unconfigured-other-fee / financeUnconfiguredFeeGolden | OTHER_OPERATING amount null, basis UNAVAILABLE, fee coverage 0                       | Paid 10500, gross 2000 and contribution 600 remain VERIFIED. Estimated net = 600, ESTIMATED/8000 bps, FEE_MISSING; OTHER_OPERATING explicitly excluded                                    |
| refund-only / financeRefundOnlyGolden                 | Successful merchandise refund with observed empty return receipts                    | COGS 6000 and gross 2000 remain VERIFIED; no reversal                                                                                                                                     |
| accepted-return / financeAcceptedReturnGolden         | receipt-a accepted 2026-10-02T10:00:00Z, resellable quantity 1 for line-a            | Net merchandise 8000; COGS 5000; gross 3000; contribution 1600; estimated net 1400, all VERIFIED                                                                                          |
| unpaid-cancelled / financeUnpaidCancelledGolden       | CANCELLED order with paidAt null and paidMinor 0, positive payable amount retained   | GMV, paid revenue, paid orders and units = 0, VERIFIED/10000 bps with sample size 0                                                                                                       |

Cost coverage is **known frozen cost units / paid sold units**. In `missing-cogs`, 1 of 3 units has known historical cost: 1/3 × 10000 rounds to 3333 bps. The known 1000 cost is not an exact total and the remaining two units are not free. This fixture chooses null aggregate profit values rather than an unlabeled known-cost-only profit. A future calculator's quality policy must deliberately adopt this fixture's stated policy if consuming it.

Fee-category coverage is **fully known applicable fee kinds / all five applicable fee kinds** for this example. The four contribution fee kinds have confirmed amounts and individual 10000 bps coverage. With unknown OTHER_OPERATING, 4/5 × 10000 = 8000 bps for the estimated net measure. Its 600 estimate excludes that unknown expense; it does not assert a zero expense. Fully configured cases report all five individual categories at 10000 bps. This category-count coverage is a fixture policy, not a money-weighted production rule.

The return policy version is `accepted-resellable-frozen-v1`, corresponding to the port's ACCEPTED_RESELLABLE_RETURN / FROZEN_TRANSACTION_COST basis. `receipt-a` matches the refund, order, line and SKU. It permits exactly 1 × 1000 historical cost reversal, with evidence `cost-a` and `receipt-a`. Thus 6000 − 1000 = 5000 COGS; 8000 − 5000 = 3000 gross; 3000 + 500 − 700 − 300 − 100 − 800 = 1600 contribution; 1600 − 200 = 1400 estimated net. Current catalog cost is not an input. A monetary refund alone cannot reverse cost. Pending, rejected, non-resellable, over-quantity, and late return receipt policies are outside these examples.

Unpaid cancellation contributes neither money nor units even though the order's merchandise and payable values remain visible. This case does not establish blanket exclusion of cancellation records that retain a confirmed payment.

## Paid, cohort and settlement windows

Every interval is half-open **[periodStart, periodEnd)**, with UTC timestamps and Shanghai business dates:

| Window  | UTC interval                                 | Shanghai interval           |
| ------- | -------------------------------------------- | --------------------------- |
| day1    | [2026-10-01T16:00:00Z, 2026-10-02T16:00:00Z) | October 2, 00:00–next 00:00 |
| day2    | [2026-10-02T16:00:00Z, 2026-10-03T16:00:00Z) | October 3, 00:00–next 00:00 |
| partial | [2026-10-01T16:00:00Z, 2026-10-02T06:00:00Z) | October 2, 00:00–14:00      |

Payment-window membership uses `paidAt`. Successful-refund settlement membership uses `succeededAt` in the current Connector DTO; it represents actual success/settlement occurrence, not request time, observation time, order creation time, or original payment date. Refund-cohort membership joins the refund's original order to payments in the separately supplied `context.paymentCohort`.

| Case ID / export                                         | Input settlement window and cutoff         | Paid within settlement window | Refund within settlement window |                             Settlement net | Original payment cohort                   |
| -------------------------------------------------------- | ------------------------------------------ | ----------------------------: | ------------------------------: | -----------------------------------------: | ----------------------------------------- |
| cross-day-payment / financeCrossDayPaymentGolden         | day1, visible through day1 end             |                         10500 |                               0 |                                      10500 | day1, one order paid 10500                |
| cross-day-settlement / financeCrossDaySettlementGolden   | day2, visible through 2026-10-04T16:00:00Z |                             0 |                            2000 |                                      −2000 | day1, the same immutable order paid 10500 |
| distinct-refund-rates / financeDistinctRefundRatesGolden | day2, visible through 2026-10-04T16:00:00Z |                             0 |                            3500 |                                      −3500 | day1, three orders paid 31500             |
| shanghai-partial-window / financePartialWindowGolden     | partial, visible through partial end       |                         10500 |         0 observed refund facts | No settlement net expectation in this case | partial, one included paid order          |
| zero-denominator / financeZeroDenominatorGolden          | day2, visible through 2026-10-04T16:00:00Z |           0 observed payments |         0 observed refund facts | No settlement net expectation in this case | day1, zero observed paid orders           |

The cross-day refund is requested at 2026-10-02T23:00:00Z and succeeds at 2026-10-03T00:00:00Z. It is absent at the day1 cutoff. Its next-day settlement reduces only day2 net; the original day1 paid fact stays 10500. Hand conservation across the two days is 10500 + (−2000) = 8500. Input period and visibility cutoff are separate: the later day2 cutoff provides 48 hours of mature observation after day1 end without expanding the settlement interval.

In `shanghai-partial-window`, one payment occurs exactly at the UTC start/Shanghai midnight and one exactly at the UTC end/Shanghai 14:00. Both source records are visible at the cutoff, but only the start payment belongs to the partial interval. Paid revenue is therefore 10500. A half-day window must not be treated as a full Shanghai day or compared to a full-day baseline without an explicit aligned-window policy.

## Distinct refund rates, rounding and maturity

All rate values are integer basis points: 10000 bps = 100%. Denominators are stored independently in `expected.refundRateDenominators`. Positive ratios use **HALF_AWAY_FROM_ZERO** rounding to the nearest basis point; no intermediate rounded percentage is reused.

| Case                  | Refunded distinct orders / original paid orders | Successful refunded amount / original paid-cohort amount | Expected order rate | Expected amount rate |
| --------------------- | ----------------------------------------------- | -------------------------------------------------------- | ------------------: | -------------------: |
| cross-day-settlement  | 1 / 1                                           | 2000 / 10500                                             |           10000 bps |             1905 bps |
| distinct-refund-rates | 2 / 3                                           | 3500 / 31500                                             |            6667 bps |             1111 bps |
| zero-denominator      | 0 / 0                                           | 0 / 0                                                    |                null |                 null |

In `distinct-refund-rates`, order-a has two partial successful refunds of 500 and 1000; order-b has one of 2000; order-c has none. Three refund events therefore represent **two refunded orders**, and refund amount is 500 + 1000 + 2000 = 3500. The amount denominator includes buyer shipping and equals three original paid amounts of 10500; it is not net merchandise, post-refund revenue, GMV, or day2 paid revenue. Refund event count is never the order-rate numerator.

VERIFIED rates in the mature cases require the full fixed cohort, complete synthetic payment/refund enumeration, explicit payment window, observedThrough = 2026-10-04T16:00:00Z, requiredAgeHours = 24, elapsedAgeHours = 48 from cohort end, mature = true, and sample size 1 or 3. These are fixture-specific maturity/sample policies, not a guarantee that refunds cannot happen later or a production statistical threshold.

The partial cohort has elapsedAgeHours = 0 at its end, mature = false, sample size 1, and requiredAgeHours = 24. Its order rate stays null, INSUFFICIENT/10000 bps with IMMATURE_COHORT. Complete source coverage does not establish maturity. The empty cohort is mature with sample size 0; both rates stay null, INSUFFICIENT/10000 bps with ZERO_DENOMINATOR. An observed empty denominator is distinct from an unknown payment collection, and no division by zero produces a verified zero rate.

## Downstream use and verification boundary

Import from this test-only module; no production package export or runtime index was changed:

```ts
import {
  financeBaseGolden,
  financeGoldenFixtures,
  type FinanceGoldenFixtureV1,
} from "./fixtures/metrics/finance-golden.fixture.js";

// A downstream calculator test can supply financeBaseGolden.input to its own
// implementation and assert the independently literal expected measures.
const cases: readonly FinanceGoldenFixtureV1[] = financeGoldenFixtures;
```

The relative path above is for a test directly under `apps/api/test`; adjust it for a nested test. Use `context.paymentCohort` and `context.cohort` for refund requests rather than silently using the settlement interval. Expected reversal and excluded-fee metadata are available beside the measures.

The [focused spec](../../apps/api/test/fixtures/metrics/finance-golden.e2e-spec.ts) validates all eleven inputs and 51 input/expected computation pairs through public schemas, literal base arithmetic, window membership, null/quality semantics, historical return evidence, distinct denominators, and recursive immutability. It is fixture/schema/hand-math validation; it does not test or implement an actual metric engine, persistence, authentication, provider integration, or refund ingestion.

```sh
pnpm --filter @shopmate/api exec vitest run test/fixtures/metrics/finance-golden.e2e-spec.ts
pnpm --filter @shopmate/api typecheck
```

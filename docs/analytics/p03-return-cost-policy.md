# Accepted resellable returns and frozen cost policy v1

The pure `createFrozenCostCalculator({ math, refunds, rounding })` factory implements the
existing `FrozenCostCalculator` port. Its supported policy is exactly:

```json
{
  "schemaVersion": 1,
  "version": "accepted-resellable-frozen-v1",
  "reversalBasis": "ACCEPTED_RESELLABLE_RETURN",
  "costBasis": "FROZEN_TRANSACTION_COST"
}
```

Unknown versions, extra policy fields, other bases and unsupported rounding modes return
`INVALID_INPUT`. `ACCEPTED_RESELLABLE_FROZEN_V1` exports the frozen supported policy.
The calculator requires explicit `HALF_AWAY_FROM_ZERO` or `TOWARD_ZERO` rounding.

## Recognition: paid cohort observed through a cutoff

The UTC half-open interval `[periodStart, periodEnd)` selects orders by their original
`paidAt` instant. Business timezone remains `Asia/Shanghai`, and currency is CNY.
Every supplied fact must already be observed through `visibleAt`. Refunds and physical
returns for those original orders can occur after `periodEnd`, provided they are visible
at the supplied cutoff. The public refund calculator checks the observed business-clock
window using this same payment cohort and `maturityHours: 0`.

Known paid classification uses actual reconciled `paidMinor` and `paidAt`, including paid
cancelled/closed orders and paid free orders. Known unpaid orders with `paidMinor: 0` and
`paidAt: null` are excluded. Unknown or inconsistent payment facts prevent exact dependent
results; payable amounts never substitute for actual payment.

For the selected original sold lines:

```text
net merchandise revenue = sum(original line gross - original line discount)
                          - successful merchandise refund allocations through visibleAt
original frozen COGS    = sum(original frozen unit cost × original sold quantity)
COGS                    = original frozen COGS - eligible physical-return cost reversals
gross profit            = net merchandise revenue - COGS
```

Buyer shipping is excluded from merchandise revenue, and its explicit refund allocation
is excluded from the merchandise deduction. Original discounts are applied once. Gross
profit is signed and can be negative. COGS cannot become negative for valid bounded units.

This is a **paid-cohort as-of-cutoff metric**. P03-006 `NET_REVENUE_SETTLEMENT` instead
subtracts refunds occurring in its settlement interval from payments in that interval.
The two measures have different recognition rules and must retain their own labels.

For example, a day-one order has merchandise net 10000, buyer shipping 500 and frozen
cost 6000. At the day-one cutoff, with no refund/receipt, its cohort result is net 10000,
COGS 6000 and gross profit 4000. On day two, a 2000 merchandise refund and an accepted
return of one historical 1000-cost unit become visible. A later revision of the original
day-one cohort yields net 8000, COGS 5000 and gross profit 3000. Day-two settlement income
with no day-two payments would be -2000. Original paid revenue remains 10500, and the
earlier revision remains unchanged.

## Frozen historical cost and identity

Each included order/line has one immutable frozen cost record. Its order ID, line ID and
SKU ID must match the sold line exactly; its quantity must equal the original sold
quantity; `frozenAt` must be the original payment instant. Connector timestamp offsets
are compared as actual instants. Matching a SKU alone cannot identify an order or line.

The only cost source is the supplied historical transaction record with its original
`skuCostVersion`. Confirmed zero cost is valid. `ESTIMATED` cost also requires a historical
version and produces numeric estimated results with `COST_ESTIMATED`. An unavailable
basis, absent record or ambiguous null record is missing cost. The calculator never
substitutes zero, a live catalog price or a later cost version.

Duplicate order/line frozen cost records conflict even when they are identical or name
different historical versions. There is no policy that silently replaces an earlier
record. Immutability and correct historical version provenance must also be enforced by
the normalized source reader: this pure port cannot discover an unsupplied catalog or
compare two independent revisions against an external history.

## Explicit refund allocation

Every successful positive refund for an included order needs explicit line allocations.
For each refund, the sum of `merchandiseMinor + buyerShippingMinor` must equal its known
`succeededMinor`. Both monetary fields must be known for an allocation to support a
reversal. Allocation IDs retain exact refund/order/line/SKU association, including the
refund's SKU when it supplies one. Multiple lines per refund are supported when those
identities agree. Each `(externalRefundId, externalLineId)` tuple is unique.

Across successful refunds, merchandise allocated to a sold line cannot exceed the
original line net amount; buyer shipping allocated to an order cannot exceed its original
shipping amount. Conservation or identity contradictions return `CONFLICT`. Missing
allocation rows or null fields produce `REFUND_UNKNOWN`, null merchandise revenue and
null dependent outputs. Known partial amounts still cannot exceed the original bounds.
Refund totals never imply how much was merchandise versus shipping.

Requested, failed and other non-success refunds and their planned allocations do not
reduce revenue. A known successful zero refund needs no allocation when none was supplied.
If supplied, its allocation must conserve zero. An explicit complete zero/zero line
allocation can support physical return reversal, including a paid free item's original
nonzero cost. Without that line allocation, an accepted physical return has no evidenced
reversal and discloses `RETURN_UNKNOWN`.

## Physical return eligibility

A cost reversal requires all of the following:

- A unique `externalReceiptId`, exact refund/order/line/SKU association and a known
  successful original refund.
- A visible `acceptedAt` at or after the original payment, a known positive
  `resellableQuantity` and a valid complete explicit allocation for that line.
- The matching historical frozen cost and its version.
- Cumulative accepted resellable units for the original order/line, across receipts and
  refund IDs, at most the original sold quantity.

Acceptance can precede refund success. It cannot precede original payment. Partial
returns, multiple receipts and cross-day acceptance through the cutoff are supported.
Duplicate receipt IDs and excess cumulative quantities return `CONFLICT`; quantities
are never clamped or reversed twice.

Known pending acceptance (`acceptedAt: null` with known resellable quantity), known
quantity zero and receipts attached to non-success refunds cause no reversal. A
monetary-only refund with `returnReceipts: []` retains original COGS. Null receipt data,
unknown resellable quantity or a missing required line allocation disclose `RETURN_UNKNOWN`;
dependent totals remain null. These states never imply a precisely known zero reversal.

Each emitted `CostReversalEvidence` retains the actual order, line and receipt IDs,
original `skuCostVersion`, reversed quantity and exact reversed minor amount. Supporting
evidence is deduplicated and includes frozen cost, receipt, payment, refund and allocation
evidence. Unavailable historical cost produces no fabricated reversal evidence.

## Coverage, quality and source completeness

Cost-unit coverage is the explicitly rounded basis-point ratio of included sold units
with known versioned confirmed or estimated cost to all included sold units. A proved
empty cohort has cost coverage 10000, sample size zero and zero amounts. Estimated unit
cost counts as known coverage while retaining its estimated reason.

One known unit out of three gives coverage 3333 under `HALF_AWAY_FROM_ZERO`. If any cost
line is missing, aggregate COGS and gross profit are null with `COST_MISSING` and
`ESTIMATED` quality (or `STALE` when stale precedence applies); a known cost subtotal is
never presented as complete COGS. Independently known merchandise revenue remains known.

For the literal G4 case, original merchandise net is 10000, a successful merchandise
refund is 2000, and frozen costs are `1 × 1000 + 2 × 2500 = 6000`. Results are net 8000,
COGS 6000 and gross profit 2000. Returning the one resellable 1000-cost unit produces
COGS 5000 and gross profit 3000. If the two 2500-cost units lack cost, net stays 8000
verified while COGS/profit are null estimated at coverage 3333.

`NET_MERCHANDISE_REVENUE` requires `paymentFacts`, `refundFacts` and `refundAllocations`.
`COGS` and `GROSS_PROFIT` additionally require `frozenCosts` and `returnReceipts`, matching
the unchanged public contract. A null required collection gives dependent measures
null/`UNAVAILABLE`/sample zero/coverage zero with `NOT_SYNCHRONIZED`. Known empty lists
are distinct from null collections.

Matching STORE `metricCoverage` proofs must cover every required collection and preserve
the complete public input context. Output coverage is the conservative minimum of
matching proofs and, for COGS/profit, cost-unit coverage. Missing or partial proof gives
`PARTIAL_COVERAGE` and labeled estimated known amounts. List length does not prove source
completeness. The source reader must enumerate relevant original cohort and subsequent
after-sales facts through the cutoff.

Freshness requires `sourceWatermark >= visibleAt` for this policy. A watermark that only
reaches the original sale-window end does not prove a later as-of observation fresh.
Missing source time prevents verified output. Applicable payment/refund uncertainty and
source-time reasons are retained; unrelated cost/fee source flags do not erase net
merchandise revenue. Status precedence is:

```text
UNAVAILABLE > STALE > INSUFFICIENT > ESTIMATED > VERIFIED
```

Unknown dependent amounts remain null even when stale status outranks insufficient status.

Explicit unrelated order IDs in extension rows are excluded from cohort amounts, even
if those orders' payments were not supplied. Included-order wrong line/SKU/refund links
conflict. Ambiguous null extension records retain their uncertainty because they cannot
be safely attributed outside the cohort. Duplicate extension identities conflict globally.
Public schemas still reject malformed scope, currency and future visibility on all rows.

## Boundary, evidence and operational limits

The boundary uses strict public input schemas and validates relevant timestamp precision;
nonzero submillisecond precision is rejected rather than truncated. All arithmetic uses
the injected checked integer math, including unit multiplication, accumulation, subtraction
and coverage ratios. Overflow and typed dependency failures retain their error codes and
evidence. Invalid runtime input returns `INVALID_INPUT`. Identity, duplicate and quantity
contradictions return `CONFLICT`. Window and business-clock dependency errors propagate.

Outputs include input context/source/proof/issue evidence, validate metric values, issues
and public context-wrapped snapshots, and are deeply frozen. Errors, arrays, measures and
reversal evidence are also frozen. Caller-owned input objects are neither frozen nor
mutated. A different cutoff or revision creates a new observation; no prior snapshot is
rewritten, and no catalog mutation can enter this interface.

This delivery is the pure calculation leaf, its focused tests and this policy. Runtime
host wiring, provider calls, database writes, migrations, deployment and snapshot storage
are outside this delivery. It performs no IO and uses no wall-clock fallback.

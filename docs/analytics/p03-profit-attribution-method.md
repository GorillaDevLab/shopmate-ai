# P03-011: reproducible profit delta attribution

`createProfitDeltaAttribution({ math })` implements the existing
`ProfitDeltaAttributionV1` port as a pure calculation over supplied period
aggregates. It performs no reads, writes, clock access, provider calls or UI work.
Amounts are signed integer CNY minor units (one fen).

## Fixed method manifest

```json
{
  "schemaVersion": 1,
  "version": "profit-delta-sequential-v1",
  "order": ["VOLUME", "PRICE_DISCOUNT", "SKU_MIX", "COGS", "ADVERTISING"],
  "rounding": "HALF_AWAY_FROM_ZERO",
  "residualPolicy": "EXPLICIT_RESIDUAL"
}
```

`PROFIT_DELTA_METHOD_VERSION` exports this exact version.
`TOWARD_ZERO` is the other supported explicit rounding policy. No version aliases,
alternate orders, duplicate steps or omitted steps are accepted. The returned
`methodVersion` is the supplied, validated version.

## Counterfactual equations

For each explicitly matched SKU `i`, subscripts `0` and `1` mean baseline and
current. Let `q` be units, `Q` total units, `G` gross merchandise revenue, `D`
merchandise discount, `R = G - D` discounted gross merchandise revenue, `C` total
COGS and `A` advertising spend. For positive observed units, `p_i = R_i / q_i`.
The baseline quantity share is `s0_i = q0_i / Q0`.

```text
VOLUME         = (Q1 - Q0) * sum(R0_i) / Q0
PRICE_DISCOUNT = Q1 * sum(s0_i * (p1_i - p0_i))
SKU_MIX        = sum(R1_i) - Q1 * sum(s0_i * p1_i)
COGS           = -(sum(C1_i) - sum(C0_i))
ADVERTISING    = -(sum(A1_i) - sum(A0_i))

delta          = current.profitMinor - baseline.profitMinor
residual       = delta - sum(the five rounded components)
```

The revenue state progression is baseline revenue → current total quantity at
baseline mix/prices → current prices at baseline mix → current mix. The first
three exact contributions telescope to `sum(R1) - sum(R0)`. Total cost and total
advertising changes then enter their own components. Consequently volume uses a
revenue convention; it does not absorb a per-unit cost or advertising change.

All intermediate quantities and fractions use exact BigInt arithmetic with
fraction reduction. Each complete component is rounded once, after summing SKU
fractions. There are no floating-point average prices, rounded basis-point
weights or per-SKU rounding allocations. Half ties round away from zero under
`HALF_AWAY_FROM_ZERO`; `TOWARD_ZERO` truncates signed fractions. The delta and
residual use exact signed integer arithmetic. Checked aggregate and final values
must fit JavaScript's safe integer range; an oversized exact product or fraction
is allowed when its final checked value fits. Typed injected-math failures retain
their original error code and evidence. Unexpected dependency exceptions escape.

The order matters: a different order allocates interaction terms differently.
Observed average prices combine price and discount co-movement. These descriptive
counterfactuals do not establish experimental causality.

## Handworked example: revenue rises while profit falls

All amounts below are minor CNY; `netRevenueMinor` can independently equal the
discounted revenue in this example.

| Period / SKU | Units | Gross | Discount |    R | COGS | Advertising |
| ------------ | ----: | ----: | -------: | ---: | ---: | ----------: |
| Baseline A   |    10 |  1100 |      100 | 1000 |  600 |          50 |
| Baseline B   |    10 |  2000 |        0 | 2000 | 1200 |          50 |
| Current A    |    20 |  2400 |      200 | 2200 | 1500 |         250 |
| Current B    |    10 |  1800 |        0 | 1800 | 1200 |         250 |

Baseline: `Q0 = 20`, `R0 = 3000`, `C0 = 1800`, `A0 = 100`, supplied profit
`1100`. Current: `Q1 = 30`, `R1 = 4000`, `C1 = 2700`, `A1 = 500`, supplied
profit `800`. Baseline shares are each `1/2`; baseline prices are `100` and
`200`, current prices `110` and `180`.

Revenue counterfactuals are `3000 → 4500 → 4350 → 4000`:

| Step                                           | Contribution | Profit bridge after step |
| ---------------------------------------------- | -----------: | -----------------------: |
| Baseline profit                                |            — |                     1100 |
| VOLUME: `(30 - 20) * 3000 / 20`                |        +1500 |                     2600 |
| PRICE_DISCOUNT: `30 * (1/2 * 10 + 1/2 * -20)`  |         -150 |                     2450 |
| SKU_MIX: `4000 - 30 * (1/2 * 110 + 1/2 * 180)` |         -350 |                     2100 |
| COGS: `-(2700 - 1800)`                         |         -900 |                     1200 |
| ADVERTISING: `-(500 - 100)`                    |         -400 |                      800 |
| Explicit residual                              |            0 |                      800 |

Thus revenue increases by `1000`, but profit decreases by `300`. Discounts have
already entered `R`; they are never subtracted a second time.

## Residual scope

`netRevenueMinor` is an independent supplied net-revenue measure and may differ
from `grossMinor - discountMinor` because of refunds or other adjustments. It
does not replace `R` or force a reconciliation equality. Buyer shipping, fees,
other effects outside this partial bridge and final component rounding can remain
in the residual. The calculator does not assign an unnamed causal explanation.

For example, if the supplied current profit in the table were `600`, the same
components still sum to `-300`, the delta would be `-500`, and residual would be
`-200`. This is an economic bridge discrepancy; it is not automatically a rounding
error. Positive and negative residuals remain visible. If any component or delta
is unknown, residual is `null`; known independent effects remain available.

## Missing data, zero units and evidence

Missing values never become zero. Volume needs baseline units/gross/discount and
current units. Price/discount additionally needs observed current prices for
positive baseline weights. Mix needs baseline units and current units/gross/
discount, without requiring baseline revenue. Missing COGS or advertising affects
that component; missing supplied profit affects delta. Any required null row field
prevents returning a partial known subtotal.

Both periods must explicitly enumerate the same SKU IDs for a complete revenue
decomposition. A missing row is not a known zero. Duplicate IDs return `CONFLICT`.
An explicit `q0=0, G0=D0=0` row has zero baseline weight and can enter current mix;
no baseline unit price is invented. A positive baseline weight with explicit
`q1=0, G1=D1=0` has no observed current price: volume can remain known while price
and mix carry `ZERO_DENOMINATOR`. `Q0=0`, including two empty observed periods,
leaves all three revenue effects unavailable. Independent cost/ad totals and
supplied profit delta can still be known. Zero units with positive gross or
discount produce `SOURCE_INCONSISTENT`, not a fabricated zero unit price.

Nonzero known COGS requires at least one supplied immutable frozen-cost source
reference. Without it the cost component is unavailable with `COST_MISSING`.
Source-reference revisions can differ between periods under the same cost policy;
they can represent observed cost changes. A changed `costPolicyVersion` instead
means noncomparable costing and returns `VERSION_MISMATCH`. Version strings are
not fabricated evidence IDs: output quality retains supplied evidence IDs, which
must establish the link to those source references outside this leaf.

Every upstream issue and its evidence is preserved. Quality precedence is
`UNAVAILABLE > STALE > INSUFFICIENT > ESTIMATED > VERIFIED`. Upstream
`UNAVAILABLE` is a hard null floor. Stale, insufficient and estimated source
quality remain explicit on known effects. Partial source coverage prevents a
complete revenue decomposition; known cost/ad totals retain the degraded source
quality. Every null output measure/component has an explicit issue and real
supplied evidence. Issue evidence must belong to its enclosing quality evidence.
Returned values are deeply frozen copies, without mutating or freezing input.

## Boundary and error policy

The request and all nested structures use strict runtime schemas. Unknown keys,
unsafe/noninteger numbers, invalid enums, empty versions/evidence, invalid UTC
timestamps and nonzero precision beyond milliseconds return `INVALID_INPUT`.
Quantities/gross/discount/advertising are nonnegative; net revenue, COGS and profit
can be signed, including losses and cost reversals. Evidence IDs are identifiers,
even when they resemble timestamps.

Complete connector bindings must match (`SCOPE_MISMATCH`); definition and cost
policy versions must match (`VERSION_MISMATCH`). Input revisions may differ.
A structurally valid unsupported method manifest returns `VERSION_MISMATCH`.
Unsupported rounding enum values or malformed manifest shapes return
`INVALID_INPUT`. Currency/timezone must be `CNY`/`Asia/Shanghai` as required by the
public schemas; malformed currency/timezone values return `INVALID_INPUT`.

Comparison windows must match period windows by actual instants. The leaf checks
positive equal durations, accurate elapsed hours, business midnight starts, same
business weekday and local cutoff, an earlier nonoverlapping baseline, a single
business day, and each period end at or before its own `visibleAt`. An asserted
`aligned=true, reason=null` cannot bypass these checks (`WINDOW_MISMATCH`). These
checks follow the existing window resolver semantics, including Shanghai calendar
parts; the leaf has no wall clock. Numeric aggregate/final overflow returns
`OVERFLOW`. No deployment or database migration is required by this leaf.

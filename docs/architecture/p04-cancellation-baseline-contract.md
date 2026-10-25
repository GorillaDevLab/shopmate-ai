# Cancellation baseline contract

Approved architecture: add event-only `CANCELLED_ORDER_RATE` / `basisPoints` and an optional bounded normalized cancellation observation array. Normalize metric snapshots and observations privately into the existing pure baseline algorithm; retain P3 metric definitions, exact statistics, latest-visible revision selection, and null/quality semantics.

Implementation sequence:

1. Add public contract tests, observe RED, implement strict provenance/quality/scope validation, and commit.
2. Add baseline behavior tests, observe RED, implement private source-neutral normalization/conflict checks, and commit.
3. Verify decision probability-domain compatibility and run focused/regression tests, typecheck, build, lint, formatting, function-length and secret checks.

No index, provider, runtime, database or detector changes. A future adapter must verify immutable aggregates and actual cancellation time/cohort/payment facts. Missing `cancelledAt` remains `SOURCE_TIME_MISSING`; no timestamp substitution is permitted. Card P04-008 remains blocked until this prerequisite is merged.

Validation: the repair preserves event baseline union variants and all P3 kinds. Contract and baseline regression suites exercise probability bounds, exact fractional median/MAD, semantic timestamps, exact source references, entity scope, cohort quality, immutable payload conflicts, revision ordering, lookback/age cutoffs, and omitted-field compatibility. API/contract build/typecheck, lint, formatting, source function length/type checks, and secret scan are required for handoff; actual commands/results are in the coordinator implementation report.

Approved companion scope (2026-10-26): add event-only `AD_SPEND` / `minorCNY` and a second concrete campaign observation to the optional array. Reuse actual nullable `MetricMeasuredCoverage` provenance and the private sample engine. Contract RED/GREEN, normalizer RED/GREEN and combined cancellation/spend/legacy checks are separate units. Refs #236 and #239; this prerequisite does not close the detector cards. Preserve all prior commits. Daily dates cannot certify historical same-hour spend coverage, and spend reliability must be established independently of attribution reliability. No attribution dependency is added to the spend observation.

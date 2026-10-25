# Cancellation baseline contract

Approved architecture: add event-only `CANCELLED_ORDER_RATE` / `basisPoints` and an optional bounded normalized cancellation observation array. Normalize metric snapshots and observations privately into the existing pure baseline algorithm; retain P3 metric definitions, exact statistics, latest-visible revision selection, and null/quality semantics.

Implementation sequence:
1. Add public contract tests, observe RED, implement strict provenance/quality/scope validation, and commit.
2. Add baseline behavior tests, observe RED, implement private source-neutral normalization/conflict checks, and commit.
3. Verify decision probability-domain compatibility and run focused/regression tests, typecheck, build, lint, formatting, function-length and secret checks.

No index, provider, runtime, database or detector changes. A future adapter must verify immutable aggregates and actual cancellation time/cohort/payment facts. Missing `cancelledAt` remains `SOURCE_TIME_MISSING`; no timestamp substitution is permitted. Card P04-008 remains blocked until this prerequisite is merged.

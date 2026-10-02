# Phase 2.1 Mock source implementation plan

> Execute inline with executing-plans and test-driven-development; review with requesting-code-review before publication.

Goal: deliver an offline, deterministic source simulator for the approved Phase 2 architecture. The next PR will adapt this source to CommerceConnector; this PR does not register API endpoints, change database tables or seed the deployed database.

Architecture: server-only `apps/api/src/integrations/mock/` contains business clocks, validated generation configuration, catalog generation, chronological commerce replay and immutable snapshots. Existing shared Connector schemas validate exported commerce DTOs. The caller supplies an already verified binding; accepting a binding is not authorization. Security expiry continues to use the existing real clock.

Alternatives considered: extend the old database seed (couples source and normalized DB), pre-generated JSON (large and difficult to replay), or a pure source simulator (chosen: reproducible, bounded and independently testable). Persistence, demo controls and connector pagination follow in separate phases.

Constraints: generator version `mock-source-v1`; CNY integer fen; Asia/Shanghai daily boundaries; seed uint32; 1–365 days; 1–100 products and 1–3 variants each; volume 1–300 daily baseline; hard limit 150,000 candidate orders. Default 60 products / 180 SKUs, 180 days, four profiles; new store opens only in the final 14 days. No personal data, external requests, wall-clock randomness or fixture oracle in exported data.

## Tasks

- [ ] Clock: `business-clock.ts` and spec. `SimulationClock.snapshot()` returns `{now, revision}`; `advance(ms)` rejects negative/fractional/overflowing durations without changing state. `RealBusinessClock` uses real time and never replaces auth clocks. Red/green command: `pnpm --filter @shopmate/api exec vitest run src/integrations/mock/business-clock.spec.ts`. Commit `feat(mock): add controllable business clock`.
- [ ] Configuration/catalog: `mock-config.ts`, `mock-catalog.ts`, `mock-random.ts` and specs. Strict configuration rejects unknown keys, invalid bindings, unsafe budgets and invalid Shanghai midnight. Domain-keyed SHA-256 randomness keeps catalog streams independent of order streams. Catalog contains synthetic titles, costs, launch times, variants and inventory parameters. New-store missing costs stay null with COST_MISSING. Red/green command: `pnpm --filter @shopmate/api exec vitest run src/integrations/mock/mock-catalog.spec.ts`. Commit `feat(mock): add seeded store profiles and catalog`.
- [ ] History/replay: `mock-history.ts`, `mock-replay.ts`, `mock-source.ts`, `mock-types.ts` and specs. Generate hourly demand using weekday/hour weights and profile trends, then replay reservation/payment/cancellation/fulfillment/refund/restock events in chronological order. Block purchases when available inventory is insufficient. Freeze price/cost at purchase; refunds never exceed paid; returns are separate stock events. `generateMockSource(unknownConfig, asOf)` exposes only facts observed by asOf, validates DTOs, computes deterministic dataset hash and freezes the snapshot. Tests reconstruct inventory, correlate order/refund/marketing totals, reject future leakage and prove deterministic replay. Commit `feat(mock): generate causal historical commerce snapshots`.
- [ ] Delivery: full API/contracts tests, typecheck, lint, format, secret scan and build; independent review; record actual counts and benchmark. Commit `docs(mock): document source validation and limits`, push feature branch and create/attach PR against main.

## Acceptance and remaining scope

Same config/asOf gives the same hash independent of process time. Snapshot contains no consumer identity or secrets. Every inventory entry has a unique event ID; all balances remain nonnegative and available equals onHand minus reserved. All snapshot source timestamps are at or before asOf. Profile A grows, B discounts/spends more, C repeats weekday behavior, D has short history and missing costs. These are source patterns, not hardcoded metrics or Agent answers.

No claim of completed MockCommerceConnector, persistent demo session, 15 scenario engine, failure injection, sync database, financial Metric Engine, auth policy, write execution or production deployment. The existing deployment migration failure remains a separate operational issue. Regeneration is offline fixture construction, never a way to overwrite adapter action state.

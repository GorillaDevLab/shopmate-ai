# P03-018 Normalized Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Each unit requires focused tests, independent review, and separate commits.

**Goal:** Read actual P2 normalized facts, capture immutable source evidence, compute versioned metrics, persist snapshots and expose authenticated persistence-only queries.

**Architecture:** P2 listings are mutable, so a P03-owned database capture operation atomically archives normalized facts and their sync proof. A read-only adapter maps that exact archive to MetricInputV1. A server-only runtime composes the existing calculators, registry, hasher, P16 orchestration and P15 repository; existing P17 GET/history routes never trigger capture or calculation.

**Tech Stack:** TypeScript, NestJS, PostgreSQL 16, pg, Vitest, Node test runner.

## Global Constraints

- All functions, test callbacks and SQL bodies <40 lines; TypeScript no any, no empty catches, no suppressed type errors.
- Full organization/workspace/store/connection/external-store scope; fresh current membership and current active source generation on every access.
- Parameterized SQL; environment-only secrets; no raw PII, provider/scenario expected outputs, current catalog cost inference or invented zero values.
- New immutable source archive with FORCE RLS, constrained capabilities, bounded payloads, exact source hashes/proof and UPDATE/DELETE/TRUNCATE denial.
- Same SQL statement snapshot for all captured facts and proof; READ COMMITTED, because existing metric_scope_access rejects repeatable-read.
- Source business timestamps and observedAt <= requested visibleAt <= actual persisted business clock; physical ingestion/capture timestamps remain separate audit metadata.
- Unknown extensions remain null. Current rows overwritten after an old cutoff cannot be reconstructed without an existing archive: return typed unavailable.
- Replay retains exact old source bytes, inputRevision, definitionVersion and mapping semantics; unknown revisions never fall back to current state.
- P2 gate mapping PR500 must pass six exact-head CI checks and merge before actual runtime wiring is published/declared ready. Fixture preparation and source archive unit can proceed independently against merged P2 contracts.
- Preserve seven other active task assignees/reservations. Original OneDrive checkout untouched. feat/ branch, separate verifiable commits, review and six latest-head product CI before merge.
- No deployment, online migration, real Jev/抖店/LLM, access grants, billing or workflow weakening. Deployment stays paused. Project App setup remains separate.

## Task 1: Immutable normalized source evidence boundary

**Files:** Create additive metric_source_bundles migration, packages/database/src/metric-source-bundle.repository.ts and small strict projection/type helpers, packages/database/test/integration/metric-source-bundle.test.mjs and scoped fixture helper. Modify database src/index.ts only to export the new port.

**Interfaces:** createMetricSourceBundleRepository({pool,actor}) produces resolve(storeId), capture({binding,window,visibleAt}) and read({binding,window,visibleAt,inputRevision}); all return MetricResult and fresh authorization. Export explicit NormalizedMetricSourceBundle and source request types for Task2. Capture payload is constructed by the database from actual normalized state, never supplied as caller DTO JSON. Definition version and requested kinds remain adapter context, not a mutable archive payload.

- [ ] Write real restricted-PostgreSQL failing tests for missing archive/capture functions; run only isolatedPostgres-created owned DB and stop it in finally.
- [ ] Implement additive constrained table, narrow authorized binding/proof/capture/read operations and strict SDK decoding. One INSERT...SELECT snapshot captures all normalized DTOs plus real receipt proof. Reject unsafe logins and unavailable/incomplete/future/quarantined source rather than returning a clean zero. Historical archive reads still require current membership/binding/generation.
- [ ] Cover duplicate capture idempotency; actual late page data => new revision; old bundle immutable; scope/revocation/disconnect/reset/future/changed cutoff denial; watermark null/insufficient prefix/partial newer pages; numeric bounds and source failure. Use actual P2 worker page commits in fixtures, not direct fabricated Job completion.
- [ ] Run database build/typecheck/lint, focused suite, format/diff and AST checks. Commit schema, SDK and necessary focused tests in independently verifiable units. Freeze the port shape so independent fixture-based adapter work can proceed; actual integration waits for Task1 review approval.

## Task 2: Read-only adapter and production calculator dispatch

**Files:** Create apps/api/src/metrics/normalized-metric-source.adapter.ts, metric-runtime-calculator.ts, supporting versioned policy helpers and focused *.spec.ts files as needed.

**Interfaces:** adapter implements MetricSourceReader and consumes exact Task1 archive reads. Runtime calculator implements existing MetricCalculator and produces strict MetricComputationV1 with actual leaf factories, versioned policy and reducer. Preserve existing public contracts and leaf implementations.

- [ ] Write failing adapter tests: null extensions, real provenance, deterministic revision/evidence, requested coverage only when backed by full prefix proof; no null revision fallback that fabricates history; strict timestamp/subject/source failures.
- [ ] Implement deterministic mapping from archived normalized data. Orders outside payment period remain available for next-day settlement refund linkage. Frozen cost/allocations/receipts/fees/traffic/extensions stay null; campaign measuredCoverage stays null absent real interval evidence.
- [ ] Write failing dispatch tests against literal G4 paid10500/refund2000/net8500 and unknown profit inputs. Route supported store/SKU/campaign metrics through existing payment/refund/cost/contribution/inventory/funnel leaves. Missing aligned baseline for PROFIT_DELTA yields explicit UNAVAILABLE with a reason; never invent a baseline. Reduce per-metric dependencies using versioned policy without upgrading leaf uncertainty.
- [ ] Run `pnpm --filter @shopmate/api test src/metrics` and typecheck/lint/build. Commit adapter and dispatcher as independently testable units. Freeze and task-review before Task3.

## Task 3: Runtime DI, authorized routes and mandatory database proof

**Files:** Create metrics.module.ts, metric-runtime.service.ts, metrics.environment.ts and ownership/port facades if needed, apps/api/test/metrics-database.e2e-spec.ts. Modify app.module.ts, vitest.tenant.config.ts, vitest.config.ts, scripts/test-tenant-database.mjs, isolated runtime fixture, and runner regression tests where necessary. Document runtime setup and replay limitations.

**Interfaces:** server-only runtime compute({actor,query,computedAt}) performs current binding authorization -> capture when revision is null / read exact archive otherwise -> existing P16 compute explicit revision -> P15 append. Registry and DB definitions use immutable exact version; definition provisioning is an explicit server operation separate from GET. Bind P17 query tokens to actor-bound persisted repositories and current server-side ownership resolver.

- [ ] Before runtime wiring, verify PR500 merged, Issue499 completed and live P2-GATE verifier true; claim228 and shared locks. Record additional database index/runner/helper locks and confirm no active/review conflict.
- [ ] Write failing module/HTTP tests. Lazy configuration must allow existing AppModule/health to boot when metric URL/secret is absent; metric operations fail closed with typed SOURCE_UNAVAILABLE/503 after normal auth. Stable cursor secret >=32 bytes from environment; no generated production fallback. Restricted pools initialize only on use and close on shutdown.
- [ ] Wire AppModule/MetricsModule, actual current binding/clock, registry/hasher, source archive, P16 compute and P15 repository. GET/history are persisted read only; no public compute route, worker/provider grants or automatic production definition writes.
- [ ] Register metrics database test in tenant include/default exclude/apiTargets; runner-generated isolated URLs only, inherited dev database URLs stripped. Every required target >0 passing assertions and zero skipped/pending/todo; no root glob assumptions.
- [ ] Real isolated P2 page commit -> archive -> adapter -> real dispatch/P16/P15 -> signed-cookie GET/history: paid and next-day refund, missing costs; before-advance future rejection; late correction creates new revision; old definition/input recomputes equal result after current state changes; current membership revocation denies reads; source failure gives no normal zero.
- [ ] Run focused metrics, typecheck/lint/build/format/secrets/AST; then `pnpm test:tenant` once code is frozen, from isolatedPostgres only. Independently review whole branch, fix findings with covering tests, then PR to main with actual evidence and migration/env/provisioning prerequisites. Latest exact-head six product CI must pass before merge. No deployment.

## Delivery evidence

Record commands/results, head SHAs, review verdicts, live gate verification and limits in .superpowers/sdd/p03-018-*-report.md. P2 supplies confirmed paid/settled facts; runtime must not claim fully configured frozen-cost/fee/traffic or baseline attribution capability. Describe historical replay as supported for captured revisions within the currently authorized generation, never as reconstruction of uncaptured history.

# PRODUCT Atomic Commit RPC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Commit one generic PRODUCT page, its complete SKU snapshots, source decisions, quarantine and staged receipt in one PostgreSQL transaction.

**Architecture:** A worker-only SECURITY DEFINER RPC derives its namespace from the current leased Job and writes the typed commerce listings introduced by PR #450. Internal receipt sidecars retain exact retry results and actual source evidence. Reader privileges remain unchanged.

**Tech Stack:** PostgreSQL 15, Prisma multi-schema migrations, generic commerce contracts, Node real PostgreSQL integration tests.

## Global Constraints

- Implementation starts only after PR #450 is merged and this clean branch is advanced to merged main; no cherry-picking or editing its implementation branch.
- PRODUCT only. No SDK decoder, provider-specific branch, business cursor/successfulThrough advancement, completion, deployment or publishing.
- Reuse #445 stage_page, current lease backend PID/start and fence, full seven-coordinate scope and current authorization/generation.
- Worker receives EXECUTE only; no commerce or sidecar DML. Reader retains SELECT only on its existing listing views/tables.
- Every independently verifiable change gets its own commit. No full tenant gate in parallel with another agent.

## Interface and exact semantics

```sql
sync_host.commit_product_page(
  job_id text, expected_fence integer, page_id text,
  expected_cursor text, page jsonb
) returns jsonb
```

The page is exactly `{items,nextCursor,observedAt,sourceWatermark}`. Scope, source stream, requested window, hashes and counts are database-derived. Output contains `APPLIED` or `REPLAYED` plus the saved applied/duplicate/stale/quarantined and physical SKU inserted/deleted counts.

Page identity is SHA-256 of a versioned JSONB document containing Job identity, seven-dimensional namespace, request window, expected cursor and the exact supplied page. JSON object ordering is immaterial; array ordering and timestamp spelling remain part of exact page identity. The fence is excluded so a properly authorized current lease may replay a prior exact page.

Product payload identity uses canonical business fields, quality and the complete SKU snapshot; SKU/attribute/issue ordering is deterministic. Source version and normalized source time are compared independently. External IDs remain unnormalized namespaces. Text transformations match CommerceTextSchema.

Accept all offset/precision forms allowed by ConnectorTimestampSchema rather than imposing the source-reader control's canonical-UTC syntax. Validate the original calendar/time/offset, truncate fractional seconds text to three digits before any PostgreSQL timestamp cast, then normalize to UTC milliseconds, matching existing Date.parse source-order semantics. Casting first is incorrect because PostgreSQL can round sub-microsecond input across a millisecond boundary. Preserve original values in the exact page hash. Test fractional values around millisecond boundaries and equivalent offsets. Values outside typed storage's year range receive a documented storage-range decision, never an accidental cast failure or silent overflow.

Proposed operational RPC limits: 8,388,608 UTF-8 bytes of supplied JSONB text and 5,000 aggregate SKU candidates per page, alongside contract limits of 200 products, 500 SKUs/product and 30 attributes/SKU. These are RPC admission limits, not changes to ConnectorPage validity. Exceeding either rejects the entire page with fixed `PAGE_TOO_LARGE`, without facts, quarantine, staging or truncation; callers must reduce the requested page limit. A single maximum-contract product must fit the admission budget. Test this explicitly.

Whole-page rejection: malformed envelope, cursor discontinuity, wrong/missing externalStoreId, invalid authority, wrong stream, excessive budget, or unsupported legacy staged-only receipt. Individual correctly scoped invalid products and source/ownership conflicts enter quarantine. Legal PARTIAL quality remains an admissible fact.

For source decisions, follow existing source-order rules exactly: newer timestamp APPLY; older STALE; equal timestamps DUPLICATE only with equal opaque version and payload hash, otherwise CONFLICT. If either timestamp is missing, only both-null with equal version/hash is DUPLICATE. Never parse opaque versions as integers.

## Internal sidecars

- `sync_host.ProductPageCommit`: PK and FK `(jobId,pageId)` to PageReceipt; scope FK, codec, database page hash, actual observedAt/sourceWatermark, terminal flag, acceptedFence and saved counts.
- `sync_host.ProductPageDecision`: PK `(jobId,pageId,ordinal)`; parent commit FK, candidate hash, recoverable validated externalProductId, closed decision, and bounded prior source evidence.
- `sync_host.ProductQuarantine`: decision FK, closed reason, validated identifiers and bounded field paths. No arbitrary raw payload, SQL exception details or private connector metadata.
- All three FORCE RLS and no public/worker/reader direct grants. Internal helper EXECUTE is revoked from PUBLIC.
- Count constraint: `inputCount = appliedCount + duplicateCount + staleCount + quarantinedCount`. Child DML counts are measured, not supplied.

## Task 1: Canonical input/hash/source-decision boundary

**Files:** Create `packages/database/prisma/migrations/20261008020000_product_commit_helpers/migration.sql`; create `packages/database/test/integration/product-commit-input.test.mjs`; reuse `test/helpers/sync-host-fixture.mjs`.

- [ ] Advance clean branch to merged main containing #450; verify migration order and Prisma model names before editing.
- [ ] Write real PG assertions for JSON type/unknown keys, contract limits, transform parity, non-ASCII UTF-16 budgets, amount integer/MAX_SAFE_INTEGER boundaries, null quality/time cases, offset/fraction normalization and malformed calendar inputs.
- [ ] Write source-decision assertions for timestamp order, equal-time conflict, version equality, missing time, reordered snapshot hashing, and differing namespace IDs.
- [ ] Record focused RED failures attributable to absent helpers, then implement pure internal helpers without any worker grant or listing write path.
- [ ] Run focused input tests and migration deployment; commit only helpers and their green tests as `feat(database): validate canonical product commit inputs`.

## Task 2: Atomic PRODUCT RPC and immutable receipt decisions

**Files:** Create `packages/database/prisma/migrations/20261008030000_product_page_commit/migration.sql`; modify `packages/database/prisma/schema.prisma`; create `packages/database/test/integration/product-page-commit.test.mjs`.

- [ ] Write real PG RED tests for one product+SKU apply, exact replay, changed-payload conflict, empty final page, staged-only receipt rejection and complete rollback after a deliberately failing child constraint.
- [ ] Add sidecars and RPC. Pre-authorize without a Job lock, then lock Job and re-authorize; acquire authorization rows in documented consistent order and lock the full SourceScope before examining or changing product/SKU rows.
- [ ] Preflight SKU ownership using pre-page owners and every page candidate, so two products claiming one SKU cannot win according to ordinal processing. Preserve DELETED snapshots; do not reparent or overwrite old versions.
- [ ] Compute immutable candidate decisions and hashes. APPLY performs complete child replacement; duplicates/stale do not touch listing rows. Verify actual DML counts before saving the manifest.
- [ ] Stage the same database-derived page identity inside the transaction and save actual sourceWatermark separately. Existing terminal staging requires Job.until; this remains a staging marker and cannot substitute for actual nullable source proof.
- [ ] Return stored original counts for exact retries before recomputing current canonical decisions. A PageReceipt without ProductPageCommit is rejected rather than promoted to a successful canonical retry.
- [ ] Recheck lease/current authority before return and via deferred commit-time guard on new sidecar rows. Reject expiry/revocation/fence/backend changes during an explicit transaction.
- [ ] Add negative RLS tests: foreign Job cannot block on its lock; missing identity, altered principal, wrong generation, worker direct DML, reader RPC/DML and helper calls all fail closed.
- [ ] Add precise retry/source/quarantine/ownership/resource tests, including retry after later canonical changes, foreign-store whole-page rollback, SQL failure not converted to quarantine, maximum single-product budget and no business progress mutation.
- [ ] Run focused suites; commit migration, Prisma models and green tests as `feat(database): atomically commit product snapshots and page receipts`.

## Task 3: Required gate and operational contract

**Files:** Modify `scripts/test-tenant-database.mjs`; create `docs/operations/product-page-commit.md`.

- [ ] Register both focused integration suites sequentially in the mandatory shared-server harness; verify fixture cleanup and no database/role collisions.
- [ ] Document admission budgets, whole-page versus item rejection, millisecond normalization, immutable retry counts, staged-only receipt limitation and nullable sourceWatermark without success/completion claims.
- [ ] Build database, run focused tests, lint/prettier, Prisma validate and migration-to-schema drift check. Run the shared-server focused suites sequentially; arrange any full gate with root to avoid concurrency.
- [ ] Commit gate/documentation as `test(database): require atomic product ingestion checks`.

## Acceptance and delivery

- Exact page retry changes no facts and returns identical saved counts.
- A newer source snapshot atomically replaces all SKU children; older snapshots never overwrite it.
- Every correctly scoped item receives exactly one immutable decision; invalid records cannot vanish from counts.
- Any transaction, constraint, authority or lease failure rolls back facts and both receipt layers.
- Existing reader authorization and business completion state remain unchanged.
- Report commit SHAs, RED-to-GREEN evidence, focused PG/build/lint/drift results and remaining integration limitations to root. No push, PR or deployment in this unit.

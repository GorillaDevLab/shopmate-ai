# K7 Isolation, Concurrency, and End-to-End Test Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that dashboard layouts, AI-generated dashboard queries, and monitoring resources remain isolated per authenticated user and merchant under concurrent and end-to-end use.

**Architecture:** Extend the existing Nest integration suites with independently signed test sessions and in-memory repositories, keep Prisma boundary tests focused on generated query scopes and compare-and-swap behavior, and extend React interaction tests for failure recovery. Add one browser flow for desktop and 375px only when a local test database is configured.

**Tech Stack:** TypeScript, NestJS, Prisma, Zod, React 19, Vitest, Testing Library, Supertest, Playwright.

## Global Constraints

- Branch name is `feat/k7-isolation-concurrency-e2e`; do not use a `codex/` prefix.
- Documentation belongs in `docs/dashboard/`; do not create `docs/superpowers/`.
- Test identities come from signed server sessions, never request parameters.
- Tests must not require real secrets or external AI/network calls.
- Production fixes are permitted only when a new regression test first demonstrates the defect.
- Keep loaded UI data on recoverable mutation failures and expose a safe Chinese error.

---

### Task 1: Prove Atomic Layout Isolation and Concurrency

**Files:**

- Modify: `apps/api/test/dashboard-layout.e2e-spec.ts`
- Modify: `apps/api/src/dashboard-layout/dashboard-layout.repository.spec.ts`

**Interfaces:**

- Uses `signDemoSession(context, secret, ttl)` to create two authenticated users.
- Verifies `PUT /api/v1/dashboard/layout` compare-and-swap behavior through HTTP.

- [ ] Add a two-user API test that saves different layouts and reads each one back without leakage.
- [ ] Add simultaneous saves with the same expected revision and assert exactly one `200` and one `409`.
- [ ] Assert the winning layout remains stored after the conflict.
- [ ] Run `pnpm -C apps/api exec vitest run test/dashboard-layout.e2e-spec.ts src/dashboard-layout`.
- [ ] Commit as `test: cover layout isolation and concurrency`.

### Task 2: Harden Monitoring Repository Isolation

**Files:**

- Modify: `apps/api/src/monitoring/monitoring.repository.spec.ts`
- Modify only after RED: `apps/api/src/monitoring/monitoring.repository.ts`

**Interfaces:**

- `completeRun(context, ruleId, ...)` must create no notification if the scoped rule update matches zero rows.

- [ ] Add a failing test where `updateMany` returns `{ count: 0 }` and assert `createMany` is never called.
- [ ] Run the focused repository test and confirm it fails because insertion currently happens first.
- [ ] Update the transaction to claim/update the scoped rule before inserting notifications.
- [ ] Re-run the repository and service suites and confirm GREEN.
- [ ] Commit as `fix: enforce monitoring scope during completion`.

### Task 3: Cover the Authenticated Monitoring Flow

**Files:**

- Modify: `apps/api/test/monitoring.e2e-spec.ts`

**Interfaces:**

- Override `MONITORING_REPOSITORY` with a user/merchant-scoped fixture.
- Override `MonitoringEvaluator` with deterministic inventory matches.
- Exercise preview, create, list, pause/start, manual run, notification read, read-all, delete, and cross-user 404 behavior.

- [ ] Add two signed user sessions and a scoped fixture repository.
- [ ] Add a complete happy-path HTTP test with deterministic Mock LLM output.
- [ ] Add cross-user rule and notification access tests returning 404 or empty lists.
- [ ] Add repeated-run notification deduplication coverage.
- [ ] Run `pnpm -C apps/api exec vitest run test/monitoring.e2e-spec.ts`.
- [ ] Commit as `test: cover isolated monitoring workflow`.

### Task 4: Cover AI DSL and UI Recovery Boundaries

**Files:**

- Modify: `apps/api/src/monitoring/monitoring-rule-generator.spec.ts`
- Modify: `apps/web/src/app/monitoring-components.test.tsx`
- Modify only after RED: `apps/web/src/app/notification-center.tsx`
- Modify: `apps/web/src/app/dashboard-layout-editor.test.tsx`

**Interfaces:**

- Wrong tool names, SQL-like extra fields, identity fields, and provider failures must never reach the evaluator.
- Notification read failures retain loaded items and show a safe retryable error.
- Editor save conflicts retain the draft and keyboard focus behavior remains stable.

- [ ] Add generator security cases and run the focused suite.
- [ ] Add a failing notification mutation-recovery test and confirm RED.
- [ ] Add minimal safe error handling and confirm GREEN.
- [ ] Add editor focus/draft assertions without changing layout semantics.
- [ ] Run focused API and Web suites.
- [ ] Commit as `test: expand AI and editor safety coverage`.

### Task 5: Full Verification and PR

**Files:**

- Modify only if a failing acceptance check exposes a K7 defect.

**Interfaces:**

- Produces a clean branch and PR closing Issue #120.

- [ ] Run `pnpm secret:scan`.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm build`.
- [ ] Run `git diff --check`.
- [ ] If `DATABASE_URL` exists, run the Playwright desktop and 375px flow; otherwise report the environment limitation without inventing credentials.
- [ ] Push `feat/k7-isolation-concurrency-e2e`, create `[K7] 补充用户隔离并发保存和端到端测试`, include `Closes #120`, and wait for the quality gate.

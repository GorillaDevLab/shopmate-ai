# K6 Monitoring Rules and Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build authenticated, user-isolated sales and inventory monitoring rules that are evaluated on dashboard access or manual request and create deduplicated in-app notifications.

**Architecture:** Shared Zod contracts define a strict discriminated rule DSL and every API response. Prisma persists rules and notifications with compound user/merchant scopes and a unique notification fingerprint. A monitoring service evaluates due rules through existing analytics services, while the Next.js dashboard provides rule management and a notification center.

**Tech Stack:** TypeScript 6, NestJS 12, Prisma 7/PostgreSQL, Zod, Next.js 16/React 19, Vitest, Testing Library, Supertest.

## Global Constraints

- Branch name is `feat/k6-monitoring-alerts`; do not use a `codex/` prefix.
- Documentation belongs in `docs/dashboard/`; do not create `docs/superpowers/`.
- Rule and notification identity always comes from the authenticated server context.
- AI output is a strict DSL; never execute generated SQL or code.
- Frequencies are `daily` and `weekly`; windows are `7d`, `30d`, `90d`, or the inventory snapshot.
- A user/merchant scope can have at most 10 active rules.
- One evaluation persists at most 20 notification matches.
- Destructive rule deletion requires a confirmation dialog.
- Loading, empty, error, ready, and retry states must be accessible at 375px and desktop widths.
- Do not commit secrets, generated browser artifacts, or agent/tool metadata.

---

### Task 1: Define Strict Monitoring Contracts

**Files:**

- Create: `packages/contracts/src/monitoring/monitoring-rule.schema.ts`
- Create: `packages/contracts/src/monitoring/monitoring-rule.spec.ts`
- Create: `packages/contracts/src/monitoring/monitoring-api.schema.ts`
- Create: `packages/contracts/src/monitoring/monitoring-api.spec.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**

- Produces `MonitoringRuleDefinitionSchema`, a strict union of `salesThreshold` and `inventoryThreshold`.
- Produces request/response schemas for preview, CRUD, run, sync, notification list/count, and read mutations.
- Exposes `MonitoringRuleDefinition`, `MonitoringRuleView`, `MonitoringNotificationView`, and API DTO types.

- [ ] **Step 1: Write failing contract tests**

```ts
expect(
  MonitoringRuleDefinitionSchema.parse({
    kind: "salesThreshold",
    metric: "revenue",
    operator: "below",
    threshold: 100_000,
    window: "30d",
    frequency: "daily",
  }),
).toMatchObject({ kind: "salesThreshold", threshold: 100_000 });

expect(() =>
  MonitoringRulePreviewRequestSchema.parse({
    question: "销售额低于 1000 元时提醒",
    merchantId: "other",
  }),
).toThrow();
```

- [ ] **Step 2: Verify the tests fail because the schemas do not exist**

Run: `pnpm -C packages/contracts exec vitest run src/monitoring`

Expected: FAIL with unresolved monitoring schema imports.

- [ ] **Step 3: Implement the strict schemas**

Use a discriminated union with these exact shapes:

```ts
const SalesThresholdRuleSchema = z.strictObject({
  kind: z.literal("salesThreshold"),
  metric: z.enum(["revenue", "orderCount", "unitsSold", "averageOrderValue"]),
  operator: z.enum(["above", "below"]),
  threshold: z.number().finite().nonnegative(),
  window: z.enum(["7d", "30d", "90d"]),
  frequency: z.enum(["daily", "weekly"]),
});

const InventoryThresholdRuleSchema = z.strictObject({
  kind: z.literal("inventoryThreshold"),
  metric: z.literal("inventory"),
  operator: z.literal("below"),
  threshold: z.number().int().min(0).max(1_000_000),
  scope: z.literal("allProducts"),
  productIds: z.array(z.string().min(1).max(128)).max(20),
  frequency: z.enum(["daily", "weekly"]),
});
```

Requests must be strict, names must be 1–80 characters, natural-language questions 1–2000 characters, and list limits 1–50. Views expose safe failure code/message fields but no stack or provider payload.

- [ ] **Step 4: Run contract tests and public export tests**

Run: `pnpm -C packages/contracts exec vitest run src/monitoring src/public-package.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit the contracts**

```bash
git add packages/contracts/src/monitoring packages/contracts/src/index.ts
git commit -m "feat: define monitoring rule contracts"
```

---

### Task 2: Persist User-Scoped Rules and Notifications

**Files:**

- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/migrations/<timestamp>_monitoring_rules/migration.sql`
- Modify: `packages/database/test/migration-contract.test.mjs`
- Create: `apps/api/src/monitoring/monitoring.repository.ts`
- Create: `apps/api/src/monitoring/monitoring.repository.spec.ts`

**Interfaces:**

- Produces `MonitoringRepository`, `MonitoringRuleRecord`, and `MonitoringNotificationRecord`.
- Repository methods always accept `{ userId, merchantId }` before a resource ID.
- Produces atomic `completeRun` and `failRun` methods.

- [ ] **Step 1: Add failing migration contract tests**

Assert that the migration contains:

```js
assert.match(sql, /CREATE TABLE "UserMonitoringRule"/);
assert.match(sql, /CREATE TABLE "MonitoringNotification"/);
assert.match(sql, /UNIQUE.*userId.*merchantId.*fingerprint/is);
assert.match(sql, /ON DELETE CASCADE/);
```

- [ ] **Step 2: Verify migration tests fail**

Run: `pnpm -C packages/database exec node --import tsx --test test/migration-contract.test.mjs`

Expected: FAIL because the monitoring migration is absent.

- [ ] **Step 3: Add Prisma models and an explicit migration**

Add enums `MonitoringRuleKind`, `MonitoringRuleStatus`, `MonitoringSeverity`, and `MonitoringResourceType`. Add `UserMonitoringRule` and `MonitoringNotification` exactly as specified in the design, including merchant relations, `(userId, merchantId, status, nextRunAt)` index, `(userId, merchantId, fingerprint)` uniqueness, and notification cascade from rule.

- [ ] **Step 4: Write failing repository isolation and deduplication tests**

Test the concrete Prisma repository with a mocked Prisma boundary:

```ts
await repository.findRule(scopeA, "rule-b");
expect(prisma.userMonitoringRule.findFirst).toHaveBeenCalledWith(
  expect.objectContaining({
    where: { id: "rule-b", userId: scopeA.userId, merchantId: scopeA.merchantId },
  }),
);
```

Also assert `completeRun` creates notifications and updates run timestamps in one transaction, and maps duplicate fingerprints to an idempotent success.

- [ ] **Step 5: Implement the repository and generated database types**

The repository must parse JSON definitions with `MonitoringRuleDefinitionSchema` when reading. Use Prisma parameter objects only; do not use raw SQL. Select only fields used by API views.

- [ ] **Step 6: Run database and repository tests**

Run: `pnpm --filter @shopmate/database build && pnpm -C packages/database test && pnpm -C apps/api exec vitest run src/monitoring/monitoring.repository.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit persistence**

```bash
git add packages/database/prisma packages/database/test/migration-contract.test.mjs apps/api/src/monitoring/monitoring.repository.ts apps/api/src/monitoring/monitoring.repository.spec.ts
git commit -m "feat: persist monitoring rules and notifications"
```

---

### Task 3: Evaluate Rules with Bounded Resource Use

**Files:**

- Create: `apps/api/src/monitoring/monitoring-evaluator.ts`
- Create: `apps/api/src/monitoring/monitoring-evaluator.spec.ts`
- Create: `apps/api/src/monitoring/monitoring-schedule.ts`
- Create: `apps/api/src/monitoring/monitoring-schedule.spec.ts`

**Interfaces:**

- Produces `MonitoringEvaluator.evaluate(context, definition, now): Promise<MonitoringEvaluation>`.
- Produces `nextRunAt(frequency, completedAt): Date` and `monitoringPeriod(definition, now)`.
- Consumes existing `DashboardService`, `ProductPerformanceService`, and `LowStockService` interfaces.

- [ ] **Step 1: Write failing schedule tests**

```ts
expect(nextRunAt("daily", new Date("2026-09-03T00:00:00Z"))).toEqual(
  new Date("2026-09-04T00:00:00Z"),
);
expect(nextRunAt("weekly", new Date("2026-09-03T00:00:00Z"))).toEqual(
  new Date("2026-09-10T00:00:00Z"),
);
```

- [ ] **Step 2: Verify schedule tests fail, then implement UTC-safe arithmetic**

Run before and after implementation: `pnpm -C apps/api exec vitest run src/monitoring/monitoring-schedule.spec.ts`

Expected: RED because exports are missing, then GREEN.

- [ ] **Step 3: Write failing evaluator tests**

Cover sales above/below, inventory filtering by product ID, no-match results, Merchant Scope forwarding, and truncation to 20 matches. Assert notification fingerprints use stable rule/resource/period inputs and never model text.

- [ ] **Step 4: Verify evaluator tests fail**

Run: `pnpm -C apps/api exec vitest run src/monitoring/monitoring-evaluator.spec.ts`

Expected: FAIL because `MonitoringEvaluator` is missing.

- [ ] **Step 5: Implement evaluation through existing domain services**

Return structured matches:

```ts
type MonitoringMatch = {
  fingerprintInput: { resourceType: "MERCHANT" | "SKU"; resourceId: string };
  title: string;
  message: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
};
```

Generate title and message from fixed server templates. Keep evaluator functions under 40 lines by separating metric selection, comparison, inventory mapping, and fingerprint creation.

- [ ] **Step 6: Run evaluator, analytics, and type tests**

Run: `pnpm -C apps/api exec vitest run src/monitoring src/analytics`

Expected: PASS.

- [ ] **Step 7: Commit evaluation**

```bash
git add apps/api/src/monitoring/monitoring-evaluator* apps/api/src/monitoring/monitoring-schedule*
git commit -m "feat: evaluate bounded monitoring rules"
```

---

### Task 4: Implement Monitoring API and Due-Rule Synchronization

**Files:**

- Create: `apps/api/src/monitoring/monitoring.service.ts`
- Create: `apps/api/src/monitoring/monitoring.service.spec.ts`
- Create: `apps/api/src/monitoring/monitoring.controller.ts`
- Create: `apps/api/src/monitoring/monitoring.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/test/monitoring.e2e-spec.ts`

**Interfaces:**

- Produces authenticated endpoints under `/api/v1/monitoring`.
- `sync(context, now)` claims and executes at most 10 due active rules.
- `runRule(context, id, now)` bypasses only due-time checking, never scope or resource limits.

- [ ] **Step 1: Write failing service tests**

Cover:

- eleventh active rule returns conflict;
- preview never persists;
- create persists only a normalized definition;
- sync requests at most 10 due rules;
- success calls `completeRun` with a deduplicated notification set;
- evaluation failure calls `failRun` with a safe code and message;
- inactive rules cannot run manually;
- resources outside the current scope behave as missing.

- [ ] **Step 2: Verify service tests fail**

Run: `pnpm -C apps/api exec vitest run src/monitoring/monitoring.service.spec.ts`

Expected: FAIL because the service is absent.

- [ ] **Step 3: Implement service orchestration and error mapping**

Use Nest exceptions with stable response bodies. Do not expose database messages, stack traces, AI provider payloads, or resource existence across user scopes.

- [ ] **Step 4: Write failing API integration tests**

Use the existing demo login helper and Supertest to assert:

```ts
await request(server).get("/api/v1/monitoring/rules").expect(401);
await request(server)
  .post("/api/v1/monitoring/rules")
  .set("Cookie", cookie)
  .send({ name: "库存", definition, merchantId: "other" })
  .expect(404);
```

Also test list, status update, delete, manual run, sync, unread count, single read, and read-all routes.

- [ ] **Step 5: Implement controller/module wiring**

Controllers receive `@MerchantContext() context` and pass it unchanged to services. IDs remain route parameters but every repository operation includes both identity fields.

- [ ] **Step 6: Run API unit and integration tests**

Run: `pnpm -C apps/api test`

Expected: PASS, with database-dependent suites skipped only under their existing environment guards.

- [ ] **Step 7: Commit the API**

```bash
git add apps/api/src/monitoring apps/api/src/app.module.ts apps/api/test/monitoring.e2e-spec.ts
git commit -m "feat: add authenticated monitoring API"
```

---

### Task 5: Add AI Rule Preview with a Restricted Tool Schema

**Files:**

- Create: `apps/api/src/monitoring/monitoring-rule-generator.ts`
- Create: `apps/api/src/monitoring/monitoring-rule-generator.spec.ts`
- Modify: `apps/api/src/monitoring/monitoring.module.ts`
- Modify: `apps/api/src/ai/providers/mock-llm.provider.ts`
- Modify: `apps/api/src/ai/providers/mock-llm.provider.spec.ts`

**Interfaces:**

- Produces `MonitoringRuleGenerator.generate(context, question): Promise<MonitoringRulePreview>`.
- Uses a single `propose_monitoring_rule` tool definition matching the shared DSL.
- Preview runs the proposed definition through the same evaluator used by saved rules.

- [ ] **Step 1: Write failing generator tests**

Assert a valid tool call is normalized and evaluated, extra `merchantId` is rejected before evaluation, unsupported frequency/window is rejected, wrong tool names fail safely, and provider errors return a retryable service error.

- [ ] **Step 2: Verify generator tests fail**

Run: `pnpm -C apps/api exec vitest run src/monitoring/monitoring-rule-generator.spec.ts`

Expected: FAIL because the generator is missing.

- [ ] **Step 3: Implement the strict tool call flow**

System policy must state that the model cannot output SQL, code, identity, arbitrary fields, sub-daily frequency, or unbounded ranges. Parse the tool arguments through `MonitoringRuleDefinitionSchema`, then evaluate with the authenticated context.

- [ ] **Step 4: Extend the Mock provider deterministically**

Map one inventory example and one sales example to valid DSL so the Demo works without a real provider. Test both mappings.

- [ ] **Step 5: Run AI and monitoring tests**

Run: `pnpm -C apps/api exec vitest run src/monitoring src/ai`

Expected: PASS.

- [ ] **Step 6: Commit AI preview**

```bash
git add apps/api/src/monitoring apps/api/src/ai/providers/mock-llm.provider*
git commit -m "feat: generate restricted monitoring rules"
```

---

### Task 6: Build the Rule Manager UI

**Files:**

- Create: `apps/web/src/app/monitoring-api.ts`
- Create: `apps/web/src/app/monitoring-api.test.ts`
- Create: `apps/web/src/app/monitoring-rule-manager.tsx`
- Create: `apps/web/src/app/monitoring-rule-manager.test.tsx`
- Modify: `apps/web/src/app/dashboard.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**

- Produces typed fetch functions for preview, create, list, status update, delete, run, and sync.
- Produces `MonitoringRuleManager({ open, onOpenChange })`.

- [ ] **Step 1: Write failing API client tests**

Assert `credentials: "include"`, strict response parsing, safe Chinese messages for 401/409/5xx, and no identity fields in request bodies.

- [ ] **Step 2: Verify client tests fail, then implement the client**

Run before and after implementation: `pnpm -C apps/web exec vitest run src/app/monitoring-api.test.ts`

Expected: RED because exports are absent, then GREEN.

- [ ] **Step 3: Write failing manager interaction tests**

Cover preview loading/error/retry, disabled confirmation before preview, successful create, active-limit conflict, toggle state, manual run feedback, failed-rule status, and a native accessible confirmation dialog before deletion.

- [ ] **Step 4: Verify component tests fail**

Run: `pnpm -C apps/web exec vitest run src/app/monitoring-rule-manager.test.tsx`

Expected: FAIL because the manager is absent.

- [ ] **Step 5: Implement the responsive manager**

Use a desktop side panel and a 375px full-screen layout. Preserve loaded rules on mutation errors. Use `aria-live`, `role="status"`, `role="alert"`, explicit labels, keyboard-close behavior, and focus restoration.

- [ ] **Step 6: Integrate the manager into the dashboard header**

Add a “监听规则” control near the assistant/appearance controls without changing saved dashboard layout semantics.

- [ ] **Step 7: Run Web tests and accessibility coverage**

Run: `pnpm -C apps/web exec vitest run src/app/monitoring-api.test.ts src/app/monitoring-rule-manager.test.tsx src/app/responsive-a11y.test.tsx`

Expected: PASS.

- [ ] **Step 8: Commit rule management UI**

```bash
git add apps/web/src/app/monitoring-* apps/web/src/app/dashboard.tsx apps/web/src/app/globals.css
git commit -m "feat: add monitoring rule manager"
```

---

### Task 7: Add the In-App Notification Center

**Files:**

- Create: `apps/web/src/app/notification-center.tsx`
- Create: `apps/web/src/app/notification-center.test.tsx`
- Modify: `apps/web/src/app/monitoring-api.ts`
- Modify: `apps/web/src/app/monitoring-api.test.ts`
- Modify: `apps/web/src/app/dashboard.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**

- Produces `NotificationCenter({ open, onOpenChange })`.
- Calls sync once on dashboard readiness, then refreshes unread count and notifications.

- [ ] **Step 1: Write failing notification center tests**

Cover loading, empty, error/retry, descending item display, unread badge, single read, read-all, safe text rendering, and retaining loaded items when a read mutation fails.

- [ ] **Step 2: Verify tests fail**

Run: `pnpm -C apps/web exec vitest run src/app/notification-center.test.tsx`

Expected: FAIL because the component is absent.

- [ ] **Step 3: Implement the notification center**

Render server text as React text nodes only. Announce unread-count changes accessibly, avoid polling, and use one dashboard-ready sync call guarded against duplicate React development effects.

- [ ] **Step 4: Integrate the bell and unread badge**

The bell must have an accessible name containing the unread count. At 375px the panel occupies the viewport and does not cause horizontal scrolling.

- [ ] **Step 5: Run Web tests**

Run: `pnpm -C apps/web test`

Expected: PASS.

- [ ] **Step 6: Commit notifications UI**

```bash
git add apps/web/src/app/notification-center* apps/web/src/app/monitoring-api* apps/web/src/app/dashboard.tsx apps/web/src/app/globals.css
git commit -m "feat: add in-app monitoring notifications"
```

---

### Task 8: Verify End-to-End Behavior and Open the PR

**Files:**

- Modify only if a failing acceptance check exposes a K6 defect.

**Interfaces:**

- Confirms all contracts, persistence, API, and Web behaviors work together.

- [ ] **Step 1: Run focused cross-user and deduplication scenarios**

Run: `pnpm -C apps/api exec vitest run test/monitoring.e2e-spec.ts`

Expected: unauthenticated access is 401; forged identity is hidden; repeated execution creates one notification; another user cannot list/read/delete the first user's resources; a failed rule remains visible.

- [ ] **Step 2: Run the full CI-equivalent gate**

Run each command separately and stop on the first failure:

```bash
pnpm secret:scan
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

Expected: every command exits 0. On Windows, if the ignored `.next` directory has a OneDrive reparse-point deletion error, verify the same source through a fresh ignored build directory and confirm GitHub CI on Linux before completion.

- [ ] **Step 3: Perform browser acceptance**

At desktop and 375px widths verify: create preview, confirm, rule list, manual check, stop/start, delete confirmation, bell badge, empty/error/retry states, mark read, no horizontal scroll, keyboard focus, and Chinese copy.

- [ ] **Step 4: Scan the final diff**

Confirm there is no `any`, production `console.log`, secret, generated browser artifact, `docs/superpowers/`, or `codex/` branch prefix. Confirm only K6 files and approved docs are present.

- [ ] **Step 5: Push and create the PR**

```bash
git push -u origin feat/k6-monitoring-alerts
gh pr create --base main --head feat/k6-monitoring-alerts --title "[K6] 实现站内监听规则与提醒" --body-file -
```

The PR body must use real line breaks, describe the Demo’s login-triggered due evaluation, list security/resource limits, include exact validation commands, and end with `Closes #119`.

- [ ] **Step 6: Wait for GitHub CI**

Run: `gh pr checks <pr-number> --watch --interval 10`

Expected: `质量门禁` completes successfully before reporting completion.

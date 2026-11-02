# P10-001 notification contract implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans. All checkbox completion requires recorded evidence.

**Goal:** Freeze strict station-only notification and daily brief DTOs plus caller-owned transactional enqueue and authorized read/preferences ports.

**Architecture:** Notification dedup identity binds the complete connector scope, stable event id, event state/revision, recipient user and IN_APP channel. Enqueue consumes the existing evaluated PRIMARY effective routing input; event severity and provider suggestions alone grant no authority. Delivery scheduling uses injected SecurityClock, independent of source/business observation time.

**Tech Stack:** Existing TypeScript/Zod/Vitest/pnpm, no dependencies. Base879632acfa951b58eb0bd6cb600e8fa04f69c83a.

## Global constraints

Apply foundation-wave-plan.md Global Constraints verbatim. Own only packages/contracts/src/notifications/delivery.schema.ts, delivery.spec.ts and contracts/src/index.ts under exclusive contracts-index lock. Keep all functions/callbacks/tests fewer than40 physical lines including headers. No action dispatch/verification task model, real transport/worker, arbitrary notification text/PII, new access or deployment.

## DTO boundaries

- Reuse ConnectorBinding, TenantId, EventEvidenceReference, EventState, EventSeverity, EventPeriod, MetricStatus, MetricValue/signed minor and current routed PRIMARY types; do not invent a second tenant clock/context.
- `NotificationRecipient`: full binding and userId. Membership is a current server check at repository entry, not something a client DTO or schema can prove.
- `NotificationIntent`: schemaVersion1, id, recipient, eventId/state/revision, evidence reference, decisionRunId, effective route limited DAILY_BRIEF/NOTIFY_NOW/ESCALATE, createdAt/notBefore, stable dedup key, minimal enum-based summary. Binding must match evidence in all five fields. No raw prompt/contact/customer/order bodies.
- `createNotificationIntentKey`: deterministic JSON tuple with domain/version, full binding, eventid/state/revision, recipient and channel. Exact opaque ids remain unchanged; concatenation cannot collide. Same identity returns same key; different state/revision/recipient/scope cannot collide. Key is an idempotency identity, never authorization.
- `NotificationPreferences`: schemaVersion1, recipient, version, notifications ALL/DAILY_ONLY/NONE, quietHours nullable timezone/startMinute/endMinute, cooldownSeconds. Validate bounded real IANA timezone, minute range0..1439, explicit null quiet hours; do not interpret local clock as observed source time. Current routing adapter can project existing preference shape later.
- `DeliveryReceipt`: strict discriminated states PENDING/LEASED/DELIVERED/FAILED/UNKNOWN, identity, safe attempt count, nextAttemptAt nullable, lease token/until nullable, deliveredAt/readAt nullable. DELIVERED requires actual delivery time; UNKNOWN never gets delivery/read timestamps; only LEASED has token+until; read cannot precede delivery. References and scheduling times require cross-field agreement. No inference that PENDING/UNKNOWN means delivered.
- `DailyBrief`: schemaVersion1, id, full binding, businessDate YYYY-MM-DD, timezone, version, evidenceHash, observedAt, sourceWatermark nullable, period, quality, profit signed safe integer minor ornull, bounded evidence references and bounded minimal event summary references. Every reference stays same scope. Date must be real and correspond to the declared business timezone/window; watermark cannot be future. Nonverified quality remains explicit; missing profit staysnull and cannot be marked VERIFIED. Version plus evidenceHash binds reproducibility, not independent signature. No action approval fields.
- Generic `TransactionalEnqueuePort<TTransaction>` takes caller-supplied transaction plus validated intent and existing DecisionOutboxRequest/context+effective routed run, returns typed success/dedup or error. No implicit transaction creation. Existing actual authority/repository still validates scope, recipient and route; contract alone grants nothing.
- Authorized notification read/preferences query ports carry current TenantContext plus binding/recipientId, validated bounded limit/cursor and SecurityClock where mutation scheduling requires it. Typed failures distinguish forbidden/invalid/conflict/unavailable; unknown is not an empty successful inbox.

## Steps

- [ ] Write synthetic same-scope evidence fixture, valid notification intent and mutation matrix in delivery.spec.ts. RED `pnpm --filter @shopmate/contracts test -- src/notifications/delivery.spec.ts` must fail for absent module/export, captured in report.
- [ ] Add per-boundary tests: malformed recipient/scope/timezone; fractional/unsafe minor or attempt; unknown fields/oversize collections; notification duplicate-key mutation; same event new state/revision/recipient/scope changes key; mismatched evidence binding; provider SHADOW/unavailable/effectiveIGNORE rejected at enqueue input validation; severity alone has no execute/approve field; UNKNOWN notdelivered; LEASED token/until and delivered/read time invariants; quiet hours and source clock separation; real calendar/business date; unknownprofit null and explicit quality.
- [ ] Implement readonly strict schemas and small refinements/helpers. Export actual public DTOs, key helper and ports from index.ts. No runtime service or database access in contracts.
- [ ] GREEN focused test; contracts fullsuite once, typecheck, namedfile ESLint/prettier, build, full-span function checker. Fix demonstrated failures, not unrelated formatting.
- [ ] Granular contract/verification commits; selfreview and record exact exports, RED/GREEN commands/results, counts, limitations in P10-001-implementation-report.md.
- [ ] Coordinator task review + strongest wholebranch review, push/PR/attach, exacthead6CI, normal merge and issue/Project completion readback.

Example test form (test helpers are local only):
```ts
expect(NotificationIntentSchema.safeParse(validIntent()).success).toBe(true);
expect(NotificationIntentSchema.safeParse(withOtherStore()).success).toBe(false);
expect(DeliveryReceiptSchema.safeParse(unknownWithDeliveryTime()).success).toBe(false);
expect(DailyBriefSchema.parse(briefWithUnknownProfit()).profitMinor).toBeNull();
```

P10-002/003 will use these actual merged DTOs, not draft assumptions. Fresh outbox migration is20261103100000, after audit003 under schema/runner lock. P10-003 waits for audit004 and both notification prerequisites to merge.

## Expanded foundation constraints


- 每个细小、独立且可验证的改动都单独提交一个 commit；不要把多个独立改动合成大提交。
- 函数 < 40 行，复杂逻辑注释说明 why 而非 what。Count full function/callback/test/SQL declaration through closing brace, including header.
- TypeScript 禁用 any（除非有充分理由并注释）。No suppression or unvalidated casts to evade validation.
- 所有用户输入必须验证和 sanitize。SQL 查询使用参数化，禁止字符串拼接。
- API 端点默认需要身份验证。Current membership and full organization/workspace/store/connection binding must remain enforced.
- 密钥/Token 只走环境变量，禁止硬编码。No payload/secret echo in errors or production logs.
- One feat/ branch and PR per card. No force push, branch/worktree deletion, deployment, live migration, real vendor/LLM/Jev/notification calls, billing/workflow changes or new access grants.
- Each card needs focused RED/GREEN evidence, appropriate types/lint/build/format checks, independent task review and strongest whole-branch review, six successful current PR-head product CI jobs, normal merge and completion readback.
- Schema/tenant runner and contracts-index changes are exclusive coordinator locks. Pure leaves do not modify shared DTOs or exports.
- P05 starts only after P04 closure. P05-010..012 cannot be declared runtime-complete while required P07/P08 implementations remain absent. Additional 24 cards await explicit scope answer.


## Local execution boundary
Only this contract, its spec, root exports and this plan are committed. Coordinator handles remote review/PR/merge. Existing EventPeriod limits DailyBrief to Asia/Shanghai; quiet-hours IANA zones use Intl validation. Source observation timestamps remain independent from SecurityClock delivery scheduling.

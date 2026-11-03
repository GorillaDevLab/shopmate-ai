# Audit and notification foundations implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Checkbox state belongs to the coordinator; implementations must not mark remotely unmerged cards Done.

**Goal:** Supply the seven real transactional audit/notification prerequisites of P04-029, complete P04-029..032, then implement P05-001..013.

**Architecture:** Preserve the existing strict shared audit DTOs. Pure API redaction/hash leaves feed an append-only, tenant-authorized transactional repository. Notification contracts and outbox persistence feed the same caller-owned transaction. No delivery worker or real vendor transport is added by these foundations.

**Tech Stack:** Existing TypeScript, Zod 4.4.3, Vitest, parameterized PostgreSQL, Prisma schema/migrations, pnpm 11.24.0. Baseline 879632acfa951b58eb0bd6cb600e8fa04f69c83a.

## Global constraints

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

## Execution ledger and file ownership

Wave A: P09-002 redactor, P09-005 hash and P09-003 audit schema are independent; each starts at the pinned main above. P10-001 contract can start when a slot frees. Coordinator owns schema/runner lock for003 and later10-002, contracts index for10-001.

Wave B: P09-004 only after002/003/005 merged; P10-002 only after10-001 merged; P10-003 only after10-001/002 and09-004 merged. Each gets a bounded implementation brief before dispatch based on actual merged interfaces.

Wave C: P04-029 real modules/UoW and same-transaction audit/outbox; P04-030 real concurrency proof; P04-031 scenarios001..008; P04-032 scenarios009..015/oracle isolation. Refresh live cards and produce its own integration plan after foundation merge.

Wave D: P05-001 contract first; then002..009 and013 component/test environment;010 actual wiring only after all hard runtime dependencies;011/012 final UI/a11y/numeric verification. P05-013 precedes011 despite numeric ordering. Design favors a few visual signals, actionable event/decision summaries, and scoped evidence drilldown, with375px/loading/empty/error/keyboard verification. Separate UI plan after P04 closes.

## Task P09-002: strict family audit redactor (#372)

Files: create apps/api/src/audit/audit-redactor.ts and audit-redactor.spec.ts only. Test fixtures stay in the spec. Worktree C:/Users/harry/.codex/worktrees/p24-demo-rules/aiShopASAS, branch feat/p09-002-audit-redactor.

Consumes AuditAppendInputSchema/AuditAppendInput from @shopmate/contracts. Produces API-local `AuditRedactor` with `redact(input: unknown): Readonly<{ redactionVersion: 1; event: AuditAppendInput }>` and a fixed safe domain error. No redactionVersion is inserted into the persisted strict event. Strict rejection of unknown fields is an allowed allowlist strategy.

- [ ] Write a synthetic valid EXECUTION fixture and assert exact preservation of oldPriceMinor/newPriceMinor plus every nullable internal link. Assert valid anonymous and EVENT_STATE_CHANGE envelopes retain their separate semantics.
- [ ] RED: `pnpm --filter @shopmate/api test -- src/audit/audit-redactor.spec.ts`; expected missing-module/export failure. Preserve output in report.
- [ ] Add tests for all21 tenant event families and anonymous authentication, malicious extra fields at each metadata level, token/phone/name/rawPrompt/nestedsecret, unknown envelope keys, cyclic/deep/oversize/nonplain/throwing-accessor inputs. Errors and their serialized properties must never contain the synthetic secret. Legitimate numeric money and opaque ids must remain legal.
- [ ] Implement bounded descriptor-based inspection of untrusted JSON-shaped input before strict schema parsing. Never evaluate accessors or call user serialization. Reject forbidden metadata rather than silently adopting body-provided identity. Convert parse/bounds errors to a fixed payload-free error; return parsed fresh data and version1 alongside it.
- [ ] GREEN: focused test above, API typecheck, lint named files, prettier check and full-span length check. Rebuild contracts/database dist only if stale; no reinstall or unrelated suite.
- [ ] Commit implementation/tests with clear feat/test messages, self-review, write exact commands/counts plus concerns to coordinator/P09-002-implementation-report.md. No push/PR/merge by child.

Behavior sample (fixture helper implemented in spec, not runtime):
```ts
const result = new AuditRedactor().redact(executionFixture());
expect(result.redactionVersion).toBe(1);
expect(result.event).toEqual(executionFixture());
expect(() => new AuditRedactor().redact(withSecret())).toThrow();
```

## Task P09-005: deterministic local integrity (#375)

Files: create apps/api/src/audit/audit-hash.ts and audit-hash.spec.ts only. Worktree C:/Users/harry/.codex/worktrees/p25-canonical-facts/aiShopASAS, branch feat/p09-005-audit-hash.

Consumes strict TenantAuditEntrySchema/TenantAuditEntry; anonymous events are not tenant chains. API-local exported `AuditCanonicalBytes` canonicalizes exact validated `Omit<TenantAuditEntry,"entryHash">` to UTF8 bytes with sorted object keys, preserved array order, no Unicode/id normalization, all declared fields included. Hash calculation is separate, lowercase SHA256 over fixed domain bytes `shopmate.audit.entry.v1\0` followed by canonical bytes. Export/document the recipe so004 does not duplicate it.

Produces typed local verifier diagnostics distinguishing valid local FULL chain, insufficient PARTIAL visibility, sequence gap, predecessor mismatch, entry hash mismatch, malformed input, unknown hashVersion and missing/mismatched checkpoint. A minimal injected readonly checkpoint port supplies scope-bound sequence/hash/version anchor; never build a writer or signer. Unknown versions must be diagnosed before v1-only schema validation masks them. No AuditQueryPage projection or invented mismatchEvidenceId. Empty chain/absent anchor cannot imply full historical integrity. Scope/order/anchor bounds must be validated; do not sort entries to conceal gaps or relink chains.

- [ ] Write a valid synthetic v1 entry and key-reordered equivalent; RED missing-module test via `pnpm --filter @shopmate/api test -- src/audit/audit-hash.spec.ts`.
- [ ] Add a known digest vector, recursive key-order permutation, metadata/actor/scope/time/link/sequence/prevHash mutation tests, positive multi-entry FULL anchored/genesis chain, gaps, duplicates, swapped order, bad predecessor, unknown version, malformed hash and checkpoint mismatch tests. PARTIAL slices with unseen gaps report insufficient visibility rather than tampering/full verification. Test lifecycle payload and Unicode opaque identifiers.
- [ ] Implement schema-bounded canonical serialization and domain hash. Validate checkpoint scope/version/sequence adjacency, verify only visible contiguous links, and report local-only semantics. Keep every callback below40 lines.
- [ ] GREEN focused test, API typecheck, named-file lint/prettier and full-span length check. Export actual leaf signature and diagnostics in implementation report for004.
- [ ] Commit independently; self-review and write P09-005-implementation-report.md with RED/GREEN exact commands/results. No remote operations by child.

## Task P09-003: append-only audit persistence (#373)

Files: create packages/database/prisma/migrations/20261103090000_audit_append_foundation/migration.sql; packages/database/test/audit-migration.test.mjs (offline/static); packages/database/test/integration/audit-storage.test.mjs (mandatory real isolated proof). Modify packages/database/prisma/schema.prisma and scripts/test-tenant-database.mjs under exclusive lock. Existing planned older timestamp is superseded to preserve migration chronology; do not edit prior migrations/checksums.

Consumes existing tenant membership/RLS helpers, P09-001 shapes, migration order through20261031090000. Produces immutable audit logs and checkpoints with per-org sequence/request-occurrence uniqueness and compound scope FKs; separate anonymous security append sink; minimal NOLOGIN capability roles. Ordinary application gets authorized SELECT/INSERT, no UPDATE/DELETE/TRUNCATE. Anonymous writer cannot read/alter tenant logs. USER identity must be current authorized principal; SERVICE/SYSTEM must not be incorrectly FK-bound to a human row or acquire body-controlled bypass.

- [ ] RED static test absent migration; add isolated SQL tests for same-scope append/read, absent scope and crossorg/workspace/store denied, revoked membership denied, compound FK mismatch, invalid sequence/hash/version, duplicate occurrence, changed replay, forbidden UPDATE/DELETE/TRUNCATE and anonymous/tenant separation.
- [ ] Implement chronological migration/schema following existing capability conventions with explicit revokePUBLIC and fixedsearch_path privileged helpers. Per-org sequence allocation must not use store-filtered MAX. Use organization transaction advisory serialization plus narrowly controlled head/tail helper validating current scope; no unrelated payload disclosure. Document exact helper/role signatures for004. Hidden cross-store occurrence collisions fail without leaking entries.
- [ ] Add real two-session same-org/different-store sequence proof, owner rollback retaining no allocated sequence/head/log changes, immutable checkpoint privileges, fresh install and upgrade from baseline main. Use disposable restricted logins with owned isolated URL only.
- [ ] Register nested target explicitly in scripts/test-tenant-database.mjs and expected positive target counts; preserve environment scrubbing, cleanup and0skip/todo/cancel. Top-level default test must stay offline since PG binaries are installed later in CI. Do not weaken runner or CI.
- [ ] GREEN static test, prisma:validate, database build/typecheck, focused real isolated target, then complete tenant runner once after stable implementation. Save output/counts/cleanup evidence, no live DB fallback.
- [ ] Commit small independently verifiable schema and proof/registration changes; write P09-003-implementation-report.md. No push/PR/merge/live migration by child.

## Coordinator gates

- [ ] Recheck live Ready/unassigned card before claim; preserve other owners and all old branches. Record current branch, base, file locks and owner. Parallel isolated batch is coordinated here, rather than untracked competing edits.
- [ ] For each implementation generate immutable full diff from pinned BASE, perform independent task review, resolve concrete findings in one wave, then strongest whole-branch review. Do not ask reviewers to repeat passing suites without evidence of a gap.
- [ ] Push/create/attach PR with Closes issue and actual validation/migration limitations. Required six CI job successes must belong to exact current PR head, not a previous commit. Normal squash merge with expected-head protection, deployment workflow remainsdisabled.
- [ ] Verify merged SHA, issue acceptance/closure and Project Done, release locks. Do not report deployment.

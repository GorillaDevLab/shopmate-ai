# Shared source CONTROL delivery (Phase 2.4c)

Branch `feat/mock-source-control-locks`, reviewed generation foundation integrated at `1abfc51`. This bounded unit is locally implemented and verified; final whole-branch review and GitHub delivery are recorded separately. Deployment and online migrations remain deferred.

## 1. Goal

Serialize existing source initialization/official generation reads and demo advance/reset/disconnect for one full session through transaction completion. Fresh post-wait authorization must reject stale generations and revocations even when raw INSERT VALUES or UPDATE started with an older outer statement snapshot.

## 2. Why this is needed

Independent source and control transactions could otherwise authorize stale generation work before a reset/disconnect and persist it afterward. Raw SQL must share the same mandatory database protocol as the official ports.

## 3. Current architecture impact

Existing public reader/worker and demo APIs, result statuses and source error enum remain unchanged. The source port uses its preserved private max-one pools, actual-login grant checks, explicit recovery and sanitized errors. Initialization acquires CONTROL before resolving the operative grant. Official generation reads retain CONTROL through commit and recheck access; unlocked listGrants remains advisory discovery. Demo mutations perform a read-only candidate lookup, acquire CONTROL, reauthorize, then lock session and connection in separate ordered queries. Both transaction mechanisms explicitly request READ COMMITTED and finite local timeouts.

## 4. Files changed

New SQL migration and source-control integration/fixture; focused source transaction/index/errors and demo repository/mutations; existing generation/demo/API fixtures; migration fixture and mandatory runner. Operator contract is in `docs/operations/mock-source-control.md`; generation operator instructions now link to that current protocol. No UI or provider files changed.

## 5. Database changes

Migration `20261003060000_mock_source_control` adds VOLATILE invoker `demo.lock_source_control(TEXT)` with fixed `pg_catalog` search path and exclusive two-int advisory namespace `1397575508`. It validates safe IDs/READ COMMITTED, inspects this backend's real granted locks with unsigned hash conversion and `objsubid=2`, rejects second distinct keys and shared-mode reentry, and records transaction-local full scope.

Mandatory BEFORE STATEMENT Runtime INSERT and session/connection UPDATE guards acquire CONTROL before candidate rows/uniqueness. Row guards verify full scope and perform authorization in separate fresh PL/pgSQL SQL commands; copied-config/hash/calendar and immutable binding checks remain. PUBLIC helper execution is revoked; only existing source capability groups receive EXECUTE. Operator must separately grant helper EXECUTE to the configured existing demo-control runtime login/group; migration creates no runtime identity or new table/model and grants source no control/auth UPDATE rights.

## 6. Security considerations

The full session/scope and actual login-bound grant authorize work; advisory hashes and caller-set GUCs never confer authority. Genuine hash collisions only serialize. Fixed SM001 means fresh access denial; SM002 means invalid scope/isolation protocol. Source initialization translates SQL denial only after rollback, and returned DENIED also rolls back a prior INSERT. Demo guard denial maps to NOT_FOUND after Prisma rollback; exact affected-count, revision and constraint conflicts retain CONFLICT. Audit failure and zero-row writes still roll back prior changes. Unexpected source SQL/timeout/deadlock errors remain sanitized SOURCE_STORAGE; no automatic replay or credential fallback was added.

## 7. Privacy/compliance considerations

Validation used synthetic data in isolated loopback PostgreSQL 16 with actual restricted source/control logins. Original checkout and `.env`, live URLs, production databases, real providers and consumer data were not accessed. No new runtime monitoring privilege, raw error logging, credentials or cross-border transfer was added. Existing trusted operator provisioning boundaries remain.

## 8. Tests added

New focused CONTROL suite: 18 passed / 0 failed / 0 skipped. It observes real `pg_locks` waiters for initialization-first and reset/disconnect-first schedules; raw VALUES old-snapshot reset/disconnect/grant/member denial; raw ordinary UPDATE fresh manage revocation; owner scope/manage and multi-session rollback; genuine hash collision; negative unsigned hashes, bigint namespace decoys and raw shared locks; independent sessions; concurrent identical CREATED/EXISTS; immutable advance; real pooled identity/scope cleanup; after-write SQL denial rollback; bounded timeout/retry; least privilege and unsafe login-default isolation override.

Existing source+demo integration: 56 passed / 0 skipped (generation 24, demo 32). The prior after-INSERT fault now verifies an inserted Runtime row before grant revocation and proves both Runtime and revocation rolled back on final-access DENIED. Existing genuine zero-row-after-prior-write and audit-failure cases remain green.

`pnpm test:tenant`: 124 passed / 0 skipped (migration 2 + tenant 13 + demo 32 + generation 24 + CONTROL 18 + restricted API 35). All three Prisma schema drift checks passed. `pnpm --filter @shopmate/database test`: 49 passed / 0 skipped; database build and lint passed. Targeted formatting and `git diff --check` passed. Changed production TypeScript AST inspection: 55 functions, longest 34 lines.

Actual red/green evidence: helper absent (`null` vs required function); missing raw INSERT scope (`23514` instead of SM002); old-snapshot raw INSERT did not reject; official initializer lacked mandatory scope (SOURCE_STORAGE); fresh connection revocation initially misclassified SM002 rather than SM001; mandatory shared-cluster fixture initially failed duplicate source login role. Each corresponding corrected focused/mandatory run passed. Initial lint found a missing test-only process import and passed after it was fixed.

Root repository verification: `pnpm test` passed 1,663 tests (root 23 + contracts 480 + database 49 + API 890 + web 221); nine existing optional API tests were skipped in this command and the required restricted API suite passed separately. `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm format:check`, secret scan, extra database formatting and diff checks passed. Build checked 31 client bundles. Formatting initially caught an ignored generated `apps/web/next-env.d.ts`; formatting that generated file resolved the check without a tracked source change. No UI changed, so no new screenshot comparison was required.

Independent task spec/quality inspection passed. Its P3 admin-only cleanup assertion was replaced with actual checked-out source backend observations after COMMIT/ROLLBACK; incremental review passed the fix, role reuse, expanded scope tests, runner wiring and operator docs. Final complete committed package review remains a separate merge gate; no remote CI outcome is claimed here.

## 9. How to manually verify

Use the operator contract to grant helper EXECUTE to the existing control runtime. Approve one demo-manage actor/session and actual-login VIEWER worker grant, then initialize: CREATED, repeat EXISTS with identical config/hash/opening/baseline. Hold CONTROL in one real connection and start source/control work in another; inspect lock waiters from the operator. Reset/disconnect first denies stale initialization; initialization first may commit before control invalidates it. Advance preserves frozen Runtime. Revoke grant/member/marker and verify the next operation denies; inject after-write access loss and confirm complete rollback. Ordinary SQL UPDATE must explicitly use READ COMMITTED, declare one full session and a current manage actor, and verify exact counts.

## 10. Risks / limitations

This unit delivers no global AUTH barrier, auth-table triggers, source facts/events/projections, publication pointer, leases/jobs, worker loop, connector replacement, UI, live migration or provider integration. Revocation after a fresh check may overlap an operation; later failed checks roll back and the next operation denies. Ordering concerns transaction completion, not response arrival. Multi-session control UPDATE is unsupported. Operator DDL disabling triggers and destructive maintenance remain trusted boundaries outside managed reset. Arbitrary malicious raw prelocking can still cause a PostgreSQL deadlock victim; supported paths follow CONTROL → session → connection and do not claim universal raw-SQL deadlock freedom.

## 11. Next recommended step

Complete whole-branch review and GitHub delivery, then proceed to the separately scoped append-only facts and fenced publication unit using this CONTROL contract. Phase 2.4 overall remains incomplete.

## 12. Git commit message

`feat(database): add session source control lock protocol` (`f61995e`); `feat(database): serialize source generations and demo controls` (`fbe2a27`); `test(database): require shared source control integration gates` (`8966342`); operator/delivery/progress documentation is a separate docs commit. Guards and official callers were delivered together because enabling mandatory guards alone would break existing source/control calls and restricted fixture paths. No push, PR, merge or deployment was performed by the implementation agent.

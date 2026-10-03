# Shared source CONTROL implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development for task implementation and independent review.

## Goal and limits

Make existing source generation initialization and demo advance/reset/disconnect serialize on one session lock, including raw Runtime INSERT and ordinary SQL control UPDATE. Fresh post-lock checks must reject old-generation writes. Keep Runtime immutable and current public APIs unchanged.
This unit depends on the restricted source generation foundation. Integrate its reviewed commits before implementation. Use the managed source-control worktree; the original checkout and .env remain untouched.
No AUTH barrier, authorization-table triggers, event/version/job/lease/scan tables, worker loop, connector replacement or UI. No new public methods or error enum variants. No SECURITY DEFINER/elevated runtime identity. Source roles never receive control/auth UPDATE rights.

## Exact existing interfaces and files

Preserve @shopmate/database/mock-platform, createMockSourceReader(env), createMockSourceWorker(env), SourceScope/actor validation, dedicated environment URLs and credential checks.
Preserve the private SourcePool wrapper, contained idle/checked-out connection errors, explicit retry/revalidation and sanitized close from the reviewed foundation; do not expose a pool or introduce automatic replay.
- Reader findGeneration(actor,scope): Promise<SourceGeneration|null>; close().
- Worker initializeGeneration(actor,scope): Promise<{status:'CREATED'|'EXISTS';generation:SourceGeneration}|{status:'DENIED'}>; listGrants(); close().
- Current SourceStorageError codes remain SOURCE_INPUT, SOURCE_CONFIGURATION, SOURCE_CREDENTIALS, SOURCE_STORAGE, SOURCE_INTEGRITY.
- Demo create/advance/reset/disconnect signatures and WRITTEN/CONFLICT/NOT_FOUND results remain unchanged; preserve executeOne exact-row-count rollback and audit atomicity.
Add packages/database/prisma/migrations/20261003060000_mock_source_control/migration.sql. Do not rewrite the foundation migration.
Modify focused existing files: src/mock-platform/{transaction,index,generations,errors}.ts as needed; src/demo-commerce.{repository,mutations}.ts; integration/helpers/tests and operator delivery documentation. Small internal helper files are allowed. No new Prisma tables/models are required.

## Database lock contract

Create demo.lock_source_control(session_id TEXT) RETURNS VOID, LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog. All referenced schemas/functions/tables must be qualified.
Use pg_catalog.pg_advisory_xact_lock(1397575508,pg_catalog.hashtext(session_id)); this exact two-int namespace is shared by controls, source initialization and official generation reads. Always exclusive in this bounded unit; no shared-to-exclusive upgrade path.
Reject a missing/malformed session ID using the existing safe-ID grammar and reject transaction_isolation other than 'read committed'. A hash collision only serializes scopes; no authorization decision uses the integer hash.
Before taking the lock, inspect this backend's granted advisory locks in this namespace (objsubid=2): reject a second distinct key in the same transaction. Compare hashtext's unsigned 32-bit representation with pg_locks.objid correctly. Never trust a GUC as proof that a lock is held. Same-key reentry is safe. Test missing/invalid isolation/scope and second-key rejection.
After acquisition, set transaction-local demo.control_session_id to the full session ID. The setting carries row scope, not authority; callers may set it, so guards always invoke the lock helper rather than trusting it.
One transaction operates on one session. Order: CONTROL first; demo session row second; demo connection row third. Source holds CONTROL but never locks demo/auth rows. No CPU generation, network or sleep under the lock. Configure finite local lock/statement timeouts through existing transaction mechanisms without changing public APIs.
Runtime cannot UPDATE/TRUNCATE/DELETE Runtime or UPDATE demo/auth tables. No lock-related grants on those tables. No role membership changes beyond EXECUTE on the new helper for existing source capability groups and the deployment's existing demo-control runtime login/group.
Revoke PUBLIC function execution. Grant source reader/worker helper EXECUTE explicitly. Do not invent a new application login/group in the migration: extend existing fixture grants and document the exact GRANT needed for the configured control runtime. Existing app role still has no mock_platform access.

## Mandatory database guards

Add BEFORE STATEMENT INSERT guard on mock_platform.Runtime. It reads demo.control_session_id, validates it and calls demo.lock_source_control before any candidate row/unique-key work. Missing setting fails closed, including raw INSERT SELECT. Official initialization sets this setting before issuing INSERT.
Extend/replace validate_runtime_insert in the new migration, explicitly VOLATILE. It must require NEW.sessionId equals the full declared session, reacquire/verify the same lock, then in a DISTINCT PL/pgSQL SQL command evaluate has_worker_access with NEW's entire scope/generation. False=>raise SQLSTATE SM001 with a fixed nonsensitive message. Keep all existing copied-config/hash/calendar checks.
The post-lock authorization query must be a separate command inside the VOLATILE function; its invocation of existing STABLE helpers receives that fresh command's snapshot. Never put lock acquisition and authorization into a single SQL expression/CTE and never rely only on outer INSERT RLS.
Add BEFORE STATEMENT UPDATE guards on demo.DemoCommerceSession and public.PlatformConnection; they require the declared session ID and acquire the same CONTROL before row locks. Add BEFORE ROW UPDATE guards that verify full immutable scope against that session, then perform a separate fresh current authorization SELECT using demo.has_store_access(...,true).
For a connection row, match its id/org/workspace/store/external ID to the declared current session; for a session row require OLD.id=declared ID and preserve existing immutable binding enforcement. Check OLD ownership; legitimate reset changes generation/config and legitimate disconnect changes status. Do not require NEW connection status ACTIVE, because disconnect must remain valid.
Use a fixed guard failure (SM001) for fresh current-access denial; malformed/missing control scope or non-READ-COMMITTED invocation is a fixed protocol error (SM002). Existing immutable-binding/constraint errors retain existing semantics. Do not reveal SQL, role names or row contents in messages.
Creation remains governed by existing INSERT RLS/constraints; no prior source generation exists. No new control INSERT guards are necessary. Creating a session and its connection still follows existing atomic create/audit path.
Ordinary operator control UPDATE must also declare scope, use READ COMMITTED and participate in these guards, even if its role bypasses RLS. It must set an existing authorized demo-manage actor for the fresh guard; document this new operator SQL contract and update isolated maintenance fixtures accordingly. Do not exempt owners inside the function.
Operator provisioning of authorization/marker rows is unchanged and outside CONTROL. Owner/superuser DDL that disables triggers remains an explicitly documented trusted-operator boundary; runtime credentials cannot perform it.
Multi-session control UPDATE is deliberately unsupported and must fail on the first mismatched row with full statement/transaction rollback. DELETE/TRUNCATE are not new supported control operations; existing runtime privileges/policies continue to deny them. Operator destructive maintenance is outside this protocol and must not be described as a managed reset.

## Official transaction changes

Source transaction() begins explicitly BEGIN ISOLATION LEVEL READ COMMITTED. Demo Prisma transactions explicitly request ReadCommitted; do not rely on server/session defaults. Keep parameterized set_config, sanitized errors and rollback/release cleanup.
Reader findGeneration: validate actor/scope before acquiring a client; set reader identity; declare scope/call lock helper; issue currentAccess and generation SELECT as fresh subsequent commands; retain final access check and return null if denied. Hold CONTROL until commit. No locks in listGrants: it remains advisory discovery and cannot authorize a later operation.
Worker initializeGeneration: validate actor/scope; declare session/call lock helper BEFORE resolving the operative grant; then findGrant, matchesGrant, workerIdentity, full currentAccess and existing initialization under that lock. If a candidate grant was read earlier for a necessary implementation reason, reread it after locking before using its principal.
Preserve mock.scope if foundation uses it, but do not infer lock possession or authority from it. All operative scope checks use the complete SourceScope and actual login-bound grant.
The reviewed foundation already rolls back returned DENIED through transaction rollbackWhen, including a final failed currentAccess after INSERT. Preserve that behavior. New SQL guard denials must likewise escape through transaction rollback before translation to {status:'DENIED'}; an internal denial signal may be used without changing the public port. Do not commit any new row on a returned DENIED result.
A before-write denial may return DENIED without changes. SQLSTATE SM001 during official initialization maps to that same rollback-then-DENIED behavior. Invalid inputs retain SOURCE_INPUT; missing unsafe credentials retain their current codes; protocol/timeout/deadlock/unexpected SQL errors remain sanitized SOURCE_STORAGE. Unexpected snapshot/copy/count mismatch remains SOURCE_INTEGRITY. Keep any denial class internal, not a new subpath export/error enum.
An INSERT affected count 0 is legitimate only after an independently verified existing identical Runtime row and fresh current access. Otherwise throw and roll back. CREATED/EXISTS retain frozen config/hash/opening/baseline and generator/runtime versions.
Demo mutateExisting: perform read-only candidate lookup to obtain session ID; declare/call CONTROL; reread readDemoStore(...,true) and session/connection after acquisition; lock session then connection in separate ordered SQL; then compare expectedRevision and mutate. Do not acquire the current FOR UPDATE OF s,c before CONTROL.
Fresh denied control access maps to existing NOT_FOUND, and revision/write-count/constraint conflicts retain CONFLICT; guard-denial after a prior write must throw through rollback before result translation. Preserve finish/audit exact counts. Read-only findDemoStore/findDemoSession need no new locking in this task.

## Authorization and concurrency semantics

Reset/disconnect/advance and source initialize/read are ordered by CONTROL through transaction completion. Reset first=>old-generation initialize denied; initialize first=>it can commit, then reset invalidates it. Never promise response arrival order after commit.
Membership/grant/marker revocation has no shared global barrier. An operation is authorized at its fresh post-lock check and may overlap a later revocation; the next operation must deny. Later failed checks force complete rollback. Do not promise that a concurrent operator revocation must wait for an already-authorized source transaction.
A revocation/reset committed BEFORE the fresh trigger command must be observed, even if the outer INSERT statement snapshot predates the wait. This exact old-snapshot behavior is a mandatory test, not assumed from the word VOLATILE.
Supported paths use one CONTROL key before control rows and must be deadlock-free. Arbitrary malicious raw prelocking/advisory SQL can still cause PostgreSQL to choose a deadlock victim; ensure rollback/sanitization, not an impossible claim that all arbitrary SQL is deadlock-free.

## Real integration acceptance (tests first)

Use the existing isolated PostgreSQL harness and actual source/control login connections, not admin SET ROLE. Observe barriers/pg_locks from the test operator; no runtime monitoring privilege is added. Synchronize deterministically; timeout-only or sleeps-only tests do not prove blocking/order.
1. Source initialization holds CONTROL before INSERT; start real reset and observe it waiting. Commit initialization=>CREATED, then reset=>WRITTEN; old scope read returns null and reinitialize returns DENIED; a fresh generation initializes independently.
2. Reverse schedule: reset owns CONTROL before generation change; initialization waits; after reset commit initialization returns DENIED, and operator inspection confirms no old-generation Runtime row was inserted. Repeat both orders with disconnect; disconnected scope cannot initialize.
3. Real raw worker INSERT begins with old snapshot and waits in BEFORE STATEMENT guard while the other connection owns CONTROL and resets/disconnects. After control commit the fresh row guard must throw SM001 or otherwise deny atomically; no old-generation row. Use direct VALUES from a frozen valid fixture so an old INSERT SELECT predicate cannot make this test vacuously affect zero rows.
4. Repeat raw INSERT old-snapshot denial for grant or membership revocation committed during the lock wait. Revocation itself needs no CONTROL; the test holder supplies the deterministic wait. No new Runtime row or credential leak.
5. Raw ordinary control UPDATE with declared scope and valid manage actor blocks behind source CONTROL. Missing scope/non-READ-COMMITTED/wrong-session UPDATE fails, including owner SQL. Wrong full binding cannot be authorized by a hash collision or a supplied setting.
6. Advance serializes but preserves frozen Runtime config/opening/baseline. Concurrent controls with one expectedRevision still have exactly one winner; no deadlock. Reader findGeneration waits behind reset then returns null for the old scope.
7. Inject fresh access loss after successful Runtime INSERT but before final access check; official method returns DENIED only after rollback. Suppress a mandatory INSERT/update to zero rows after earlier writes and prove no partial Runtime/control/audit result. Existing control audit-failure rollback test stays green.
8. Concurrent identical initialization returns one CREATED and one EXISTS with identical bytes. Lock/identity settings do not leak when the max-one-connection pool is reused by another actor/scope. Different sessions can acquire CONTROL concurrently.
9. Source role still cannot SELECT FOR UPDATE demo/auth rows, modify marker/member/grant/session/connection, or use app DATABASE_URL fallback; reader still cannot insert Runtime. Raw forged principal/grant cannot pass fresh guards. Existing source RLS, immutable Runtime and input tests remain green.
10. Validate helper safe-ID/isolation/second-key rejection, own-lock inspection and lock namespace. Test collision behavior by arranging the same computed key in the harness: waiting must not grant foreign scope access. Bound lock waits and verify failed transactions release locks.

## Verification and delivery

Register focused source-control integration coverage in scripts/test-tenant-database.mjs; extend existing migration fixtures that explicitly list migrations. Preserve Prisma no-drift checks. Use only isolated test URLs supplied by the harness, never workspace .env/live URLs.
Run focused new red/green tests, existing mock-platform-generation and demo-commerce integration suites, pnpm test:tenant, database build/test/lint and targeted formatting; record actual commands/results. Independent task spec/quality review is required before the next persistence unit. Required repository-wide gates/PR/CI/merge follow the parent workflow, not this architecture task.
Keep independently verifiable changes in separate commits: shared SQL guards+fixture acceptance, then official transaction integration+its acceptance if that separation is executable; otherwise choose a smaller meaningful split without shipping a knowingly broken intermediate state. Report migration/operator EXECUTE grants and the ordinary SQL control contract. No deployment or online migration.

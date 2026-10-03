# Shared Mock source CONTROL protocol

This protocol serializes source generation initialization, official generation reads and demo advance/reset/disconnect for one full session. Migration `20261003060000_mock_source_control` follows the reviewed generation foundation. Deployment and online migrations remain deferred; applying or merging these files does not deploy them.

`demo.lock_source_control(TEXT)` is VOLATILE, SECURITY INVOKER, with `search_path=pg_catalog`. It takes the exclusive transaction advisory lock `(1397575508, hashtext(session_id))`, validates the existing safe-ID grammar and READ COMMITTED isolation, rejects a second distinct key already granted to this backend, and rejects existing shared-mode reentry. Same-key exclusive reentry is supported. Hash collisions serialize unrelated sessions but confer no authority: guards verify the full session and ownership binding independently of the hash. The transaction-local `demo.control_session_id` is declared row scope; neither it nor `mock.scope` proves lock ownership or access.

One transaction uses one session and acquires CONTROL, then the session row, then the connection row. Source roles take CONTROL without locking demo/auth rows. Initialization resolves its operative actual-login grant only after CONTROL; reader identity is set before CONTROL and fresh access/generation commands follow it. `listGrants` remains unlocked advisory discovery and cannot authorize a later operation. Source and Prisma demo transactions explicitly use READ COMMITTED even when a login default requests another isolation level. Local lock waits are bounded at five seconds and statements at ten seconds; the Prisma transaction allowance is fifteen seconds. CPU dataset generation, network calls and intentional waits belong outside CONTROL.

## Deployment grants

The migration revokes PUBLIC execution and grants helper execution to the existing `shopmate_mock_source_reader` and `shopmate_mock_source_worker` capability groups. It creates no runtime login/group and grants no UPDATE, DELETE, TRUNCATE, authorization-table or monitoring privilege. Runtime remains immutable. Ordinary application credentials retain no `mock_platform` access. Existing source credential checks, separate URL variables, private pools, contained connection errors, explicit recovery and sanitized errors remain mandatory.

For an approved future deployment, the operator must grant the configured existing demo-control runtime login/group EXECUTE on the helper. For the existing isolated fixture identity, the exact statement is:

```sql
GRANT EXECUTE ON FUNCTION demo.lock_source_control(TEXT) TO shopmate_demo_runtime;
```

Replace only the role identifier with the deployment's existing authorized demo-control login/group using safe identifier handling. Do not create or elevate an application identity as part of this migration. The API fixture extends the same permission for its existing `shopmate_tenant_api` role. Retain existing schema USAGE, authorization SELECT, control table SELECT/INSERT/UPDATE, audit SELECT/INSERT and `demo.has_store_access` execution grants.

## Ordinary operator UPDATE contract

Every ordinary UPDATE of `demo.DemoCommerceSession` or `public.PlatformConnection`, including owner SQL that bypasses RLS, must declare one existing session and a currently authorized manage actor. BEFORE STATEMENT guards obtain CONTROL before candidate row locks; BEFORE ROW guards separately check fresh current access and full OLD ownership. Existing immutable binding triggers keep their constraint behavior. Reset may change generation/config, and disconnect may set status DISCONNECTED; guards do not require NEW status ACTIVE.

Use a trusted prepared/parameterized transaction. This example changes only a session revision and demonstrates the protocol; use the existing application reset/disconnect APIs for their atomic control/audit semantics:

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='10s';
PREPARE operator_control_identity(text) AS
  SELECT pg_catalog.set_config('app.user_id',$1,true);
EXECUTE operator_control_identity('approved-demo-manage-actor');
PREPARE operator_control_lock(text) AS
  SELECT demo.lock_source_control($1);
EXECUTE operator_control_lock('approved-demo-session');
PREPARE operator_control_session(text) AS
  SELECT id FROM demo."DemoCommerceSession" WHERE id=$1 FOR UPDATE;
EXECUTE operator_control_session('approved-demo-session');
PREPARE operator_control_connection(text) AS
  SELECT c.id FROM public."PlatformConnection" c
  JOIN demo."DemoCommerceSession" s ON s."connectionId"=c.id
  WHERE s.id=$1 FOR UPDATE OF c;
EXECUTE operator_control_connection('approved-demo-session');
PREPARE operator_control_update(text) AS
  UPDATE demo."DemoCommerceSession" SET revision=revision+1 WHERE id=$1;
EXECUTE operator_control_update('approved-demo-session');
DEALLOCATE operator_control_update;
DEALLOCATE operator_control_connection;
DEALLOCATE operator_control_session;
DEALLOCATE operator_control_lock;
DEALLOCATE operator_control_identity;
COMMIT;
```

The operator must verify exact affected counts and roll back on failure; an operator UPDATE is not an application managed reset and does not automatically create a control audit. Multi-session UPDATE is unsupported and fails on a mismatched row with statement/transaction rollback. Missing/malformed scope and unsafe isolation use fixed SQLSTATE `SM002`; fresh access denial uses fixed `SM001`. Raw Runtime INSERT, including INSERT SELECT with no rows, must declare scope before its mandatory statement guard. Its row guard independently reacquires CONTROL and authorizes NEW's complete scope/generation in a separate fresh SQL command before copied-config/hash/calendar validation.

Official initialization translates SM001 to DENIED only after rollback. Returned DENIED also rolls back a previously inserted Runtime. Demo guard denial translates to existing NOT_FOUND only after Prisma rolls back; exact-count/constraint/revision conflicts retain CONFLICT, and audit failures still roll back all prior writes. Protocol, timeout, deadlock and unexpected source SQL errors remain sanitized SOURCE_STORAGE. Never replay a failed operation automatically, including uncertain commit outcomes.

## Authorization and trusted boundaries

Reset first denies old-generation initialization; initialization first may commit, then reset invalidates that generation. Disconnect follows the same ordering. This is transaction completion ordering, not response arrival ordering. Membership, grant and marker provisioning/revocation do not take a global AUTH barrier. An operation may overlap a revocation after its fresh check; the next operation denies, and any later failed check forces rollback. A revocation/reset committed before a trigger's fresh authorization command is observed even when the outer VALUES statement started before its CONTROL wait.

Runtime credentials cannot disable triggers or change these guards. Owner/superuser DDL that disables triggers and destructive maintenance are trusted-operator boundaries outside this protocol; DELETE/TRUNCATE are not managed control operations. The supported one-session lock order is tested for serialization and competing revision winners. Arbitrary raw SQL that prelocks control rows or takes unrelated advisory locks can still create a PostgreSQL deadlock victim; rollback and sanitized failure apply. No publication/facts, worker loop, AUTH triggers/barrier or real provider behavior is delivered here.

## Verification

Run `pnpm test:tenant` for mandatory isolated PostgreSQL/API acceptance, including `mock-source-control.test.mjs`, plus database build/test/lint and focused generation/demo suites. Tests use actual restricted login connections; only the isolated operator observes `pg_locks`. They include both real reset/disconnect schedules, raw pre-wait snapshot VALUES and ordinary UPDATE revocations, a genuine hash collision, independent sessions, concurrent CREATED/EXISTS, exact-count rollback, post-insert access loss, privilege denial and bounded timeout/retry. No runtime monitoring grant is added.

# Persistent Mock source identity and generation foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement and review this unit before its PR.

**Goal:** A restricted source worker can initialize an immutable generation from an existing approved demo session; a separate source reader can read its authorized generation after process restart.

**Architecture:** Dedicated PostgreSQL clients and FORCE RLS protect `mock_platform` from the normal application identity. Operator-owned worker grants derive a noninteractive principal; no caller-supplied principal or organization bypass becomes worker authority. This bounded unit freezes configuration, baseline and opening time; journal, build leases, publication and persistent connector paging follow as separately verified units.

**Tech Stack:** Existing TypeScript, pg, Prisma models/migrations, node:test and isolated PostgreSQL. No network provider or framework dependency.

## Global constraints

- Branches use feat/add/fix. Each independently verifiable change receives its own commit. Latest PR CI must pass before the authorized merge; preserve branches/worktrees.
- Deployment and online migrations are deferred. Never use the original checkout or its .env; tests use only the existing isolated PostgreSQL harness.
- Synthetic data only. No runtime provisioning, tenant marking, membership mutation, secrets in code, RLS bypass or simulator oracle exposed to product code.
- Parameterized SQL, strict validated inputs, concrete errors, production functions below 40 lines, no TypeScript any without a reason. Critical boundaries have actual restricted-role PostgreSQL tests.
- Fresh active organization, workspace, membership, role-aware workspace access, Store merchant, DEMO marker, DemoTenant, active MOCK connection and current generation are conjunctive access requirements. Human OWNER/ADMIN retain existing organization-wide workspace access; other humans require current workspace assignment. Worker principals must be VIEWER with current exact workspace assignment.
- Existing session generatorVersion stays `mock-source-v1`; the new storage protocol version is separately `mock-runtime-v2`. Do not silently rewrite generator identity or history.

## Task 1: Restricted source identity and frozen generations

Files:

- Create migration `packages/database/prisma/migrations/20261003050000_mock_source_generation/migration.sql`.
- Add Prisma models for `demo.MockWorkerGrant` and `mock_platform.Runtime`; add datasource schema `mock_platform`.
- Create focused files under `packages/database/src/mock-platform/` for types, input validation, dedicated clients, transaction identity and generation repository; expose only the new `@shopmate/database/mock-platform` subpath.
- Add `packages/database/test/mock-platform-validation.test.mjs` and `test/integration/mock-platform-generation.test.mjs`, isolated fixture helpers as needed.
- Register the mandatory integration suite in `scripts/test-tenant-database.mjs`; update any migration fixtures that explicitly list migrations. Add an import-boundary test preventing normal domain modules from importing this source subpath.
- Add operator setup and 12-item delivery documentation with actual results and explicit unit limits.

### Database data and immutability

`demo.MockWorkerGrant` has ID, databaseRole, principalUserId, full organization/workspace/store/session/connection/externalStore binding, operation `SOURCE_BUILD`, status ACTIVE/REVOKED. Composite FKs enforce same organization membership, assigned workspace and stable session/connection ownership. The worker principal must remain a VIEWER with exact active workspace assignment, never an organization OWNER/ADMIN. SQL constraints restrict operation/status/ID formats. Only an operator provisions or mutates grants; runtime gets SELECT of its own grants only. Grant reads require both `session_user` and `current_user` equal databaseRole; initial lookup intentionally does not depend on app.user_id, avoiding circular principal resolution.

`mock_platform.Runtime` has primary key `(sessionId,generation)`, full ownership binding, sourceConfig JSONB, configHash, generatorVersion, runtimeVersion, openingAt, baselineEnd and createdAt. The configuration and its hash are copied from the current stored session, never supplied by the initializer. Opening time is historyStart for mature/growing/problematic; for new, historyStart + max(0, days-14) days. Baseline end is historyStart + days days. Freeze these at insertion: advancing the session clock never changes baseline, opening or configuration. Explicit reset starts another generation and fences old generation reads, retaining old rows. Immutable binding/config/time fields are protected by a SQL trigger even against roles accidentally granted UPDATE. No mutable publication pointer or empty future job tables in this unit.

All new tables ENABLE + FORCE RLS, PUBLIC privileges revoked, qualified SECURITY INVOKER functions with fixed search_path only. Source readers get SELECT Runtime; source workers get SELECT/INSERT Runtime and SELECT their grant. Normal DATABASE_URL role gets no mock_platform schema/table access. Both source roles get only the existing SELECT and helper EXECUTE rights needed for current authorization; neither can update membership, demo controls, marker, normalized facts or grants. Migration does not create deployment logins or embed credentials.

### Source port

```ts
interface SourceScope {
  organizationId: string; workspaceId: string; storeId: string;
  sessionId: string; connectionId: string; externalStoreId: string;
  generation: number;
}
interface SourceReadActor { userId: string; merchantId: string }
interface SourceWorkerActor { grantId: string }
interface SourceGeneration {
  scope: SourceScope; sourceConfig: unknown; configHash: string;
  generatorVersion: string; runtimeVersion: 'mock-runtime-v2';
  openingAt: string; baselineEnd: string; createdAt: string;
}
interface MockSourceReader {
  findGeneration(actor: SourceReadActor, scope: SourceScope): Promise<SourceGeneration | null>;
  close(): Promise<void>;
}
interface MockSourceWorker {
  listGrants(): Promise<readonly SourceWorkerGrant[]>;
  initializeGeneration(actor: SourceWorkerActor, scope: SourceScope):
    Promise<{ status: 'CREATED' | 'EXISTS'; generation: SourceGeneration } | { status: 'DENIED' }>;
  close(): Promise<void>;
}
```

Client factories accept only explicit environment configuration for their respective URLs (`MOCK_PLATFORM_READ_DATABASE_URL`, `MOCK_PLATFORM_WORKER_DATABASE_URL`), not DATABASE_URL fallback. Tests pass a controlled environment object containing isolated URLs. Do not print connection strings or SQL error payloads. Sanitize storage failures into a concrete source-storage error code. Validate configured database login is not superuser/BYPASSRLS, nor owner of relevant source or authorization objects, nor member of an elevated role. Keep clients out of normal database index exports; no pg Pool access exposed to domain callers.

Strict actor/scope validation rejects unknown keys and malformed IDs, missing/wrong merchant, expanded/out-of-range generations, nonobject values before connection/SQL. IDs follow existing safe ID grammar; externalStoreId allows the existing Connector namespace, bounded to 200 characters. Generation is a nonnegative int32. Worker identity comes only from a currently ACTIVE operator grant belonging to the actual login, then parameterized transaction-local settings for principal, merchant, grant and scope. Current membership/workspace/marker/generation is checked for every operation, not cached from a previous call. Reader sets transaction-local user and merchant and selects only the exact full scope. Transaction cleanup must rollback on failure and release pooled connections; local identity must not leak.

Initialization uses current session fields and configuration as one atomic INSERT SELECT under source RLS; exact row count is mandatory. Idempotent repeat for the same active generation returns EXISTS with identical bytes. A mismatched existing immutable generation is a storage-integrity failure, not overwrite. Derived times and shape are validated before INSERT: profile/days/historyStart/calendar and full binding agree with current session; config must be finite bounded JSON. Querying current clock after advance cannot move baseline/opening. No source facts or publication claims are made by initialization; a reset race can at most leave an inaccessible immutable old-generation row, never return it as the active generation.

### Red/green tests

- [ ] Write required tests first; run the focused validation/integration suites and record actual missing-feature failures.
- [ ] Implement schema and source ports, then run the same suites green.
- [ ] Tests use real login connections (not admin SET ROLE), two organizations, two stores in one organization, assigned/unassigned workspaces and a human belonging to both merchants.
- [ ] Verify application cannot use source schema; reader cannot initialize/update/delete; worker cannot modify marker/membership/session/grants/normalized tables; own grant lookup works without prior app identity and foreign/unknown grant fails.
- [ ] Verify absent/wrong merchant and foreign org/workspace/store/session/connection/external namespace/generation fail; revoked grant/membership/workspace/demo marker/connection deny next call; reusing one pooled connection under a different actor never leaks identity.
- [ ] Verify repeated initialization and a closed/recreated client preserve exact config/hash/opening/baseline; advance preserves them; new-store opening uses frozen days; reset denies old generation and permits separately authorized new generation without deleting old rows.
- [ ] Verify malformed persisted source configuration/hash/calendar is rejected without creating Runtime; SQL composite FKs and immutable trigger reject repurposed rows; invalid inputs never query the database; privileged/missing/fallback credentials fail closed without logging secrets.
- [ ] Run `pnpm test:tenant`, database build/test/lint and targeted Prettier; make independent commits for the schema boundary, client/repository and test gate. Report actual tests, no invented performance claim.
- [ ] Fresh task spec/quality review, fix and re-review any Important/Critical finding; full branch review and full root checks before PR/latest CI/merge.

## Subsequent unit interfaces and unresolved concurrency work

The next unit will add append-only source events and projections, fenced build leases, atomic complete-revision publication and restart-safe opaque scans. It consumes the frozen SourceGeneration and verified grant identity. The worker receives no UPDATE privilege on DemoCommerceSession or PlatformConnection; publication must explicitly serialize with reset/disconnect through a tested shared control lock protocol, rather than assuming SELECT FOR UPDATE works for a SELECT-only source role. This protocol and its real races are that unit's work.

After persistence/publication, implement the chronological incremental background generator, then actual SQL-backed CommerceConnector reads. Preserve accepted historical order/cost/price facts and ongoing future chronology; avoid request-time full regeneration. Durable scenario directives, observable economics, all 15 causal scenarios, sync/metrics/agent/action UI remain on the approved tracker and are not completed by this foundation.

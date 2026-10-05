# Restricted Mock source generation foundation

This unit stores immutable configuration and calendar boundaries for an approved demo session. It initializes no commerce facts and makes no publication claim. The normal database entry point exposes no source client; infrastructure imports the dedicated `@shopmate/database/mock-platform` subpath.

## Operator setup

Deployment and online migrations remain deferred. For an approved future release, apply the complete migration history with the separate migration/provisioning identity, including `20261003050000_mock_source_generation`. The migration creates two NOLOGIN capability groups, no deployment logins or credentials:

- `shopmate_mock_source_reader`: SELECT Runtime plus the existing authorization reads and helper execution.
- `shopmate_mock_source_worker`: SELECT/INSERT Runtime, SELECT its own active grants, and the necessary authorization reads and helpers.

Provision separate minimally privileged logins through the operator's credential-management process. For example, these statements establish capabilities without embedding passwords:

```sql
CREATE ROLE mock_source_read_login LOGIN NOSUPERUSER NOBYPASSRLS
  NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE mock_source_worker_login LOGIN NOSUPERUSER NOBYPASSRLS
  NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT shopmate_mock_source_reader TO mock_source_read_login;
GRANT shopmate_mock_source_worker TO mock_source_worker_login;
```

Do not grant both groups to one login. Every operation checks the actual session/current login, desired group membership, absence of the opposite group, elevated role attributes and inherited ownership of source/authorization objects or schemas. Membership in `pg_read_all_data`, `pg_write_all_data`, `pg_read_server_files`, `pg_write_server_files` or `pg_execute_server_program` is also rejected. Logins must not own these objects or inherit the operator role.

Set only the appropriate secret environment variable in each process:

- Reader: `MOCK_PLATFORM_READ_DATABASE_URL`.
- Worker: `MOCK_PLATFORM_WORKER_DATABASE_URL`.

Factories require an explicit environment configuration object and never fall back to `DATABASE_URL`. Connections are lazy so malformed actors/scopes fail before any database call. Login checks run on every valid operation, including a reused pooled connection. Storage errors expose only concrete source error codes; connection URLs and PostgreSQL error payloads are excluded.

An idle connection failure is handled internally after PostgreSQL's pool removes the failed client. The next valid operation reports one sanitized `SOURCE_STORAGE` failure before opening a connection; an explicit subsequent retry creates a fresh connection and repeats all credential and authorization checks. Multiple idle failures before that operation coalesce into one pending failure. Invalid input does not consume it. Closing remains available with a pending failure, discards that pending report and releases the pool; close failures are also sanitized. No operation is automatically replayed.

A connection lost while checked out is contained by that transaction's internal error listener. The operation fails with sanitized `SOURCE_STORAGE`, attempts rollback, and destroys the failed client on release. Its next explicit retry can create a fresh restricted connection. Neither idle nor transaction listeners throw asynchronous errors or retain raw database error payloads.

The worker principal must already be a current ACTIVE VIEWER member with an ACTIVE assignment to the exact workspace. A fresh active organization/workspace, merchant-bound store, operator-approved DEMO environment and DemoTenant marker, approved session and ACTIVE MOCK connection are prerequisites. The source runtime cannot provision any of them. A human reader retains existing owner/admin workspace access; other human roles require current assignment.

Provision a grant using the separate operator connection. The following prepared statement copies ownership from the existing session and binds the dedicated principal; the operator must require exactly one inserted row:

```sql
PREPARE operator_source_grant(text,text,text,text) AS
INSERT INTO demo."MockWorkerGrant"
  (id,"databaseRole","principalUserId","organizationId","workspaceId",
   "storeId","sessionId","connectionId","externalStoreId",operation,status)
SELECT $1,$2,$3,s."organizationId",s."workspaceId",s."storeId",s.id,
       s."connectionId",s."externalStoreId",'SOURCE_BUILD','ACTIVE'
FROM demo."DemoCommerceSession" s
JOIN public."OrganizationMember" m
  ON m."organizationId"=s."organizationId" AND m."userId"=$3
JOIN public."WorkspaceMember" w
  ON w."organizationId"=s."organizationId" AND w."workspaceId"=s."workspaceId"
  AND w."userId"=$3
WHERE s.id=$4 AND m.status='ACTIVE' AND m.role='VIEWER' AND w.status='ACTIVE';
EXECUTE operator_source_grant
  ('approved-source-grant','mock_source_worker_login','approved-worker-principal','approved-demo-session');
DEALLOCATE operator_source_grant;
```

Grant lookup intentionally precedes application identity and requires both `session_user` and `current_user` to equal the recorded database role. Initialization now takes shared session CONTROL before resolving its operative grant; grant listing remains advisory and unlocked. Each worker call derives its principal and merchant from the grant and stored ownership, validates the exact requested scope/current generation, and sets transaction-local identity. No caller-supplied principal or merchant can become worker authority. Grant, membership, assignment, marker, workspace or connection revocation denies the next call, including grant listing.

An operator can revoke a grant without deleting history:

```sql
PREPARE operator_revoke_source_grant(text) AS
UPDATE demo."MockWorkerGrant" SET status='REVOKED' WHERE id=$1;
EXECUTE operator_revoke_source_grant('approved-source-grant');
DEALLOCATE operator_revoke_source_grant;
```

Runtime rows use `(sessionId,generation)` identity and retain the complete session/connection ownership binding. Configuration/hash/generator identity are copied from the stored session, after validating the canonical existing v1 hash and bounded finite configuration. Opening time is historyStart for mature/growing/problematic; new stores use `historyStart + max(0, days-14) days`. Baseline end is `historyStart + days days`. PostgreSQL insert validation rejects forged snapshots/dates, and an immutable UPDATE trigger protects every field even after an accidental UPDATE grant/policy.

`generatorVersion` remains `mock-source-v1`; `runtimeVersion` is independently `mock-runtime-v2`. Creation timestamps have a database-level UTC default, and client transactions normalize their timezone locally. Advancing the session clock never changes the copied configuration or dates. Reset permits a new generation and fences previous reads while retaining previous rows. A failed final access check rolls back initialization before returning DENIED. Source roles retain no session UPDATE privilege; migration `20261003060000_mock_source_control` grants only the required lock helper capability. Follow the [shared CONTROL operator contract](mock-source-control.md), including its required grant for the configured demo-control runtime and declared scope on raw SQL writes.

## Twelve-item delivery record

Validation on 2026-10-04 used isolated loopback PostgreSQL 16.15 with actual application, reader, worker and foreign-worker login connections. The original checkout and its `.env` were not used.

| #   | Delivered boundary and actual evidence                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Test-first missing-feature run: Runtime schema and source factories absent; five failures, one passing import-boundary test. A transient Windows temporary-directory EBUSY also affected that first run; later clean isolated runs completed.                                                                                                           |
| 2   | Prisma models, ownership composite FKs, operation/status/ID constraints, ENABLE/FORCE RLS, PUBLIC revocation and invoker-only fixed-search-path helpers. Fresh deploy and all three Prisma drift checks passed in the mandatory tenant run.                                                                                                             |
| 3   | Separate URL-only clients; missing/fallback/malformed URLs fail closed. Real elevated, inherited BYPASSRLS, object-owner and mixed-capability logins are rejected. Mixed-capability and pg_write_all_data regressions each first failed with “Missing expected rejection,” then passed after the credential guard.                                      |
| 4   | Application cannot access source schema; reader cannot initialize/update/delete or read worker grants; worker cannot insert/update/delete controls, memberships, grants or normalized facts. Restricted login and forced-RLS metadata assertions passed.                                                                                                |
| 5   | Own active grant discovery without prior app identity, foreign/unknown grant denial and session/current-user equality under SET ROLE. Current worker VIEWER membership and exact assignment are mandatory; revocation is checked on every call.                                                                                                         |
| 6   | Strict actor and seven-coordinate scope validation, selected merchant checks, both merchants and two stores within one organization. Malformed inputs fail before an unreachable database is contacted; unassigned viewer reads deny while owner reads remain valid.                                                                                    |
| 7   | Atomic INSERT SELECT copies the approved session; idempotent repeats and closed/recreated clients preserve exact configuration/hash/dates. No overwrite of a mismatched active snapshot.                                                                                                                                                                |
| 8   | Clock advance preserves frozen baseline/opening/configuration; new profile opening follows frozen days. Reset creates a separate authorized generation, denies old reads and preserves old rows.                                                                                                                                                        |
| 9   | Raw worker forged configuration/hash/opening/baseline rejects; composite FK proof and immutable-trigger proof under accidental UPDATE privileges passed. Genuine zero-row INSERT returns SOURCE_INTEGRITY and rolls back.                                                                                                                               |
| 10  | Post-INSERT generation-change fault first reproduced a committed Runtime after DENIED (expected zero rows, actual one); rollback regression now passes. Non-UTC login regressions first failed for factory and raw INSERT creation timestamps; UTC database default and local normalization now pass.                                                   |
| 11  | Focused source validation/integration: 24 passed, zero failed/skipped. Mandatory tenant run: migration 2 + tenant 13 + demo 32 + source 19 + API 35 = 101 passed, zero failed/skipped. Database package tests: 49 passed; database build/lint and targeted formatting passed.                                                                           |
| 12  | Unit limits: no journal/events/projections, leases, publication pointer, connector paging, background generator, source facts, product UI, provider integration or performance claim. Formal task/branch review, latest-main integration, root gates and GitHub delivery are controller-owned follow-up gates; no deployment/online migration occurred. |

The historical foundation evidence above predates shared CONTROL. The [subsequent CONTROL unit](mock-source-control.md) serializes initialization/official generation reads and controls through transaction completion. Publication and commerce facts are not claimed by that foundation or CONTROL delivery.

## Staged source chunks and explicit retries

The dedicated worker now supports `claim(actor, scope)`, `renew(actor, lease)`, `fail(actor, lease, code)` and `appendChunk(actor, lease, input)`. A claim returns a database-derived lease for the frozen clock target. The fixed wall lease is thirty seconds; renewal and FAILED/expired takeover preserve the accepted journal and checkpoint, while takeover increments the fence. Keep the newly returned lease reference for subsequent calls. Source workers retain no permission to advance clocks, alter Runtime, provision grants or change authorization.

An append input contains exactly `expectedCheckpointHash`, `next: { processedThrough, sealed }` and up to one hundred ordered snapshot events. All seven scope coordinates and every event's exact external store namespace must agree. Input source version is null and source updatedAt equals the canonical UTC event time; PostgreSQL allocates sequences and derives the stored versions, manifests and hashes. Each accepted event has one version, and the declared chunk, checkpoint and receipt commit atomically. Unknown fields, malformed references and record bounds fail as `SOURCE_INPUT` before a connection is acquired.

`COMMITTED` returns the new checkpoint and hash. After an uncertain acknowledgment, explicitly retry the same complete input under a current matching live lease. Only the latest receipt can return `ALREADY_COMMITTED`, including after sealing, renewal or takeover with the new reference. The retry compares the ordered event and derived version envelopes, proposal, count and saved expected hash, and changes no facts or checkpoint. A saved hash alone does not prove equal input. Changed input or an older receipt returns `CONFLICT`; an expired or replaced lease returns `FENCED`, and missing current source authority returns `DENIED`. Malformed stored facts/counts/hashes raise `SOURCE_INTEGRITY`; other storage failures are sanitized as `SOURCE_STORAGE`. The SDK performs no automatic replay after an uncertain commit.

The private unsealed frontier may equal the target while additional strictly later tuples at that same timestamp remain to be appended. An empty chunk requires frontier progress or sealing an already-equal target; unchanged empty progress conflicts. Seal only after the synthetic generator has supplied its intended prefix. These checks prove physical completeness of accepted facts, not causal or financial completeness of generated commerce. No generator or live platform/Jev integration is delivered by these ports.

Official publication and certificate-reader ports remain the next delivery step. The existing SQL publication checks expose an inclusive published frontier; a private checkpoint does not establish reader coverage. An irreparable open revision requires an authorized reset rather than abandoning its revision. Unchanged-clock command writes still require the separate requestRevision/command-receipt extension. Deployment and online migration remain deferred.

# P03 metric storage

The additive `20261004090000_metric_snapshots` migration stores approved metric definitions and immutable snapshot history in `public`. It does not compute metrics, change the P03 public DTOs, grant application credentials, or backfill existing analytics into verified snapshots. Both tables start empty.

## Storage and ownership

`MetricDefinitionRow` maps to `metric_definitions`. Each definition contains a UUID, all five binding identifiers (`organizationId`, `workspaceId`, `storeId`, `connectionId`, `externalStoreId`), the public metric key, definition version, unit, definition digest and creation instant. Definitions contain server-provisioned metadata; they cannot carry serialized calculators. The unique key is the full binding plus metric key and definition version. Repeated metadata in different connection namespaces is intentional.

`MetricSnapshotRow` maps to `metric_snapshots`. A row retains the same binding, key and definition version, schema/hash versions, input revision/digest, subject, half-open window, fixed timezone/currency, visibility/source/computation instants, sample/coverage/quality metadata, original evidence identifiers, strict issues and one typed value. There is no arbitrary payload or PII extension column.

Both tables reference `Store(organizationId, workspaceId, id)` and the complete `PlatformConnection(id, organizationId, workspaceId, storeId, externalStoreId)` tuple. Snapshots also reference the exact full-scope key/version of their definition. Every ownership FK uses `ON DELETE RESTRICT ON UPDATE NO ACTION`. Definitions or connections from a different scope/version cannot be substituted.

The snapshot unique key comprises all five binding fields, key, subject kind/ID, definition version, period start/end and input revision. `STORE` uses the nonnullable empty subject-ID sentinel; `SKU` and `CAMPAIGN` require a literal external ID. This closes the nullable-subject uniqueness hole. A duplicate revision raises `23505`; an updated computation appends a new revision. New definition versions preserve historical definitions and snapshots. The scope/key/window/computed-at index supports period/history queries.

## Boundary invariants

The single `metric_unit` mapping follows `MetricValueSchema` in the contracts package. Money, quantities and basis points use `BIGINT`, bounded by JavaScript's safe integer range. GMV, paid revenue, AOV, settled refunds and COGS are nonnegative. Settlement/net merchandise revenue, profit, contribution and profit delta may be negative. Probability basis points are at most 10000; ROAS may exceed 10000 up to the safe integer maximum. Hours use a separate finite nonnegative double precision column and retain fractional values. Money never uses the hours column or decimal rounding.

Available statuses require exactly the column associated with the key's unit; all other value columns are null. `UNAVAILABLE` requires every value column to be null. Sample size is a safe nonnegative integer; coverage is 0..10000. Known public statuses are `VERIFIED`, `ESTIMATED`, `INSUFFICIENT`, `STALE` and `UNAVAILABLE`.

Instants must be finite and within years 1..9999, bounded in UTC. A positive half-open period satisfies `periodEnd <= visibleAt <= computedAt`; a watermark is null or no later than visibility. A null watermark implies `UNAVAILABLE`. `VERIFIED` requires a value, complete coverage, no issues and a watermark covering period end. Every other status requires nonempty valid issues. A verified zero is representable, including an empty complete window, but the database does not invent its completeness proof.

Evidence arrays are nonempty, one-dimensional, duplicate-free and contain only valid literal IDs. Each issue has exactly `code`, `field`, `evidenceIds`; its code is public, its field is a literal ID, and its nonempty unique evidence is a subset of the snapshot's evidence. Shape checks reject missing/null/unknown/extra/malformed issue fields without incidental casts. Checks use `IS TRUE` and explicit null guards to reject SQL three-valued unknown results. Literal identifiers are not normalized; trim/control restrictions and the public UTF-16 length budget apply. Identifier/version/key/evidence storage uses the literal `C` collation.

`definitionHash` and `inputHash` require `sha256:` followed by 64 lowercase hex characters. Hash format cannot establish canonical content, authorization, or completeness. The future host/repository write boundary must recompute and verify P03-013 canonical input hashing (`metric-input-sha256-v1`) from the supplied input and approved definition before insertion. Store the original public snapshot evidence IDs; do not replace source facts with P03-013 derived proof IDs.

## Capability roles and RLS

The migration creates three `NOLOGIN NOSUPERUSER NOBYPASSRLS` groups, with no public table permissions and no application-login membership grant:

| Group                               | Definitions    | Snapshots      |
| ----------------------------------- | -------------- | -------------- |
| `shopmate_metric_reader`            | SELECT         | SELECT         |
| `shopmate_metric_writer`            | SELECT         | SELECT, INSERT |
| `shopmate_metric_definition_writer` | SELECT, INSERT | none           |

No group receives UPDATE, DELETE or TRUNCATE. There are no mutation RLS policies. Unconditional row UPDATE/DELETE and statement TRUNCATE triggers reject operator DML too, including an update that assigns existing values. Operators retain their ordinary PostgreSQL ability to change DDL; migration administration is a trusted boundary.

Both tables use `ENABLE/FORCE ROW LEVEL SECURITY`, with default denial when a capability or exact identity/scope is absent. After authenticating the session, the existing application transaction boundary must set every context field locally and use READ COMMITTED:

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;
-- Bind these values as query parameters; never interpolate request text.
SELECT set_config('app.user_id', $1, true),
       set_config('app.organization_id', $2, true),
       set_config('app.workspace_id', $3, true),
       set_config('app.store_id', $4, true),
       set_config('app.connection_id', $5, true),
       set_config('app.external_store_id', $6, true);
-- Execute the authorized read or append.
COMMIT;
```

The `metric_scope_access` boolean helper compares every scope GUC with the row and checks the actual store, active organization/workspace, fresh active organization membership and active workspace assignment. OWNER/ADMIN bypass the assignment requirement; writes always require OWNER/ADMIN and the appropriate capability. Reads permit assigned active members. Higher transaction isolation levels fail closed, preventing a repeatable snapshot of revoked authority from being reused. Authority is rechecked on later READ COMMITTED statements/transactions; revocation does not retroactively cancel an already executing statement.

The helper uses fully qualified relations, `SECURITY DEFINER`, `search_path=pg_catalog`, no dynamic SQL, and revoked PUBLIC execution. Its migration owner must be a superuser or BYPASSRLS provisioning identity; otherwise installation fails. The migration rejects unsafe preexisting capability role flags rather than silently altering them. Runtime groups receive only required helper/validator execution and no raw tenant or Store SELECT grant. Store has no RLS, so granting it to readers would disclose unrelated merchant data. The helper has no dependency on DEMO authorization or the later commerce schema. The complete connection FK establishes namespace ownership; historical reads do not require a currently active connection.

GUCs and digests are not authentication. A trusted existing session boundary must verify identity and binding before setting them. This card introduces no worker-grant protocol, endpoint, credentials, host behavior or background write service. A deployment operator may later grant one capability to a separately provisioned restricted login, for example `GRANT shopmate_metric_reader TO approved_reader_login`; this is an offline provisioning example, not an action performed by this change. Do not grant runtime logins membership in the helper owner.

## Migration and rollback

The migration folder deliberately precedes the October 8+ history and references only earlier tenant/Store/PlatformConnection dependencies. Deploy with the normal Prisma migration operator. Tests install the complete history freshly and also install all preexisting migrations into a populated disposable database before adding this earlier-timestamp migration as newly pending. Both paths must produce an empty Prisma schema diff and preserve legacy rows. No legacy row is rewritten and no synthetic VERIFIED value is created.

Before rollout, take the normal database backup and inspect the three group flags/privilege memberships. Apply the additive migration through the controlled deployment process, then provision only the needed capability memberships. No live development/production migration is performed by the test suite or this card.

Application rollback can stop metric readers/writers and revoke the newly provisioned capability memberships while retaining both history tables. Do not delete history, rewrite definitions, remove an applied migration record, disable guards, or fabricate a destructive down migration. If a storage defect needs repair, use a reviewed forward migration and retain historical meaning. Disposable test databases are dropped in guarded finally blocks; that cleanup is not a production rollback strategy.

## Required tenant evidence

`scripts/test-tenant-database.mjs` preserves every existing explicit Node target and adds the nested metric-storage integration target. It uses `isolatedPostgres`; a validated explicit CI `TEST_DATABASE_URL` remains supported. Inherited development/operator/migration/shadow/direct database URLs and PostgreSQL connection variables are removed before child execution. Children receive validated runner-owned URLs; dotenv override is disabled. API tests use only the prepared restricted API login and the owned operator URL.

Each direct Node test process streams TAP and retains a bounded tail for its final actual test summary. A target must report positive passing tests and zero failures, cancellations, skips and todos; exit zero alone is insufficient. Direct script mode avoids Node's `--test` empty-file wrapper producing a false positive test count. Vitest must provide a JSON report with positive passing assertions in each of the two existing tenant API files, with no failed/pending/todo tests or suites. The default API configuration still excludes those files. Missing/empty/partial reports are fatal. The runner always stops its owned server and removes its guarded temporary report directory.

The storage integration target accepts only a validated runner `TEST_DATABASE_URL`, never a fallback `DATABASE_URL` or silent skip. Its synthetic fixtures use distinct disposable database names and actual restricted LOGIN identities. Coverage includes numeric/status/evidence/window boundaries, foreign compound bindings, append history, operator immutability, live authority, role privileges, poisoned inherited environments, report failures, actual empty/real Node child reports, fresh migration and populated upgrade. No real merchant data or provider calls are involved.

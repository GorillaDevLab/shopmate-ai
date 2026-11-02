# P04 decision storage

P04-026 adds forward-only migration `20261031090000_decision_records`, after the existing event/evidence migration `20261025090000_events_evidence`. Apply it using the existing migration operator during an approved release. This change does not provision an application login, grant a login new capabilities, wire API modules, call a provider, deploy, or migrate a live database.

## Durable model

`decision_runs` is immutable history of the actual P04-002 `DecisionRun`: request/correlation IDs, PRIMARY or SHADOW mode, provider descriptor, ruleset version, result, latency, created time, fallback link, suggested labels and effective labels. Its additional claim ID/token and flattened role fields are internal database fencing data, not changes to the shared DTO.

Every run references one immutable claim through a composite foreign key containing claim UUID/token and all five scope fields (organization, workspace, store, connection and external store). An insert trigger compares the raw event, fingerprint, evidence ID/version/hash and decision key against that immutable claim with byte-exact `C` collation. The claim in turn references the existing immutable event evidence with the full event/scope/fingerprint/version/hash composite foreign key. Matching a hash alone is insufficient.

`decision_records` offers an optional typed projection of each evaluated run. Its primary key is `(runId, decisionType)`. The six supported types are `SEVERITY`, `NOTIFICATION_ROUTE`, `LLM_ESCALATION`, `EVIDENCE_SUFFICIENCY`, `ATTENTION_PRIORITY`, and `REASON_CODES`. A trigger requires suggested/effective JSON values to equal the corresponding labels in the immutable run. The complete labels remain available in the run even if a projection has not been inserted.

`decision_comparisons` carries an internal claim UUID and a composite claim/full-five-scope foreign key. Its PRIMARY and SHADOW foreign keys bind run ID, claim UUID, correlation ID, mode and result status; an insert trigger independently compares the full raw event/fingerprint/evidence ID/version/hash/key tuple to the claim. This internal UUID is database fencing data, not a shared DTO addition. Consequently a comparison cannot point to another tenant, another evidence version/hash, an unavailable result, or an inverted role. Its unique primary/shadow/evaluation-version tuple makes comparison appends idempotent. The differences list uses only the six shared difference codes without duplicates.

Fallbacks reference an unavailable PRIMARY in the same claim and correlation through a composite foreign key. The fallback itself must be PRIMARY; SHADOW has no fallback, effective labels, override or winner authority. Historical PRIMARY effective labels express the host's gated/routed result; **only the claim's `winnerRunId` identifies a committed result**. Reading an arbitrary evaluated run does not authorize product side effects.

Result JSON and labels have executable strict shape/enum/version checks. Correlation IDs compare as UUID identities after canonical-form syntax validation, preserving uppercase UUID spelling in the original result JSON. Unknown confidence is JSON `null`; the sole supported metadata is `{kind: "HOST_ACCEPTANCE", value: boolean, semanticsVersion: "host-acceptance-v1", calibrationVersion: null}`. Numeric confidence, probability claims, extra vendor fields and mismatched result/ruleset versions are rejected. This metadata describes adapter acceptance, not probability, calibration or evidence sufficiency.

## Internal claim/commit SQL seam

The shared `DecisionRunRepository` currently declares append only. P04-027 may wrap the following database seam in an API-local orchestration port without inventing shared DTO fields:

```sql
SELECT * FROM public.decision_claim(
  $1, -- event ID
  $2, -- current evidence ID
  $3, -- current evidence version
  $4, -- current evidence hash
  $5, -- validated stable decision key
  $6, -- proposed opaque claim token
  $7  -- overall security deadline, timestamptz
);
SELECT public.decision_commit($1, $2, $3);
-- claim UUID, returned claim token, evaluated terminal PRIMARY run ID
```

`decision_claim` locks the event first, checks the current authenticated live writable scope, validates every proposed field/deadline, then atomically inserts or returns the existing claim. The unique key is `(eventId, evidenceId, decisionKey)`: globally unique event/evidence IDs plus the existing full evidence foreign key fix scope, fingerprint, version and hash without repeating those variable-width values in the B-tree; request ID and correlation ID are deliberately excluded. Concurrent retries return the same persisted token, deadline and optional winner. The database derives scope, fingerprint and event revision from the locked event rather than accepting a caller assertion.

An uncommitted expired claim remains immutable. A retry receives its expired deadline and must return a controlled conflict; it does not silently extend or take over a lease. A committed retry resolves the existing `winnerRunId` and returns that historical outcome. A fresh evaluation requires the caller's authorized current evaluation/revision/key policy. Changing a key arbitrarily to bypass expiry is not recovery. The host/repository must derive and validate the stable key consistently; SQL intentionally does not invent a new canonical key algorithm absent from the shared contract.

The lease deadline covers primary evaluation, optional Rules fallback and commit. An individual provider attempt must have a shorter deadline if fallback is required. PostgreSQL `clock_timestamp()` fences both appends and winner selection; historical/business timestamps cannot extend authority. After expiry, event revision/evidence supersession, or a winner, a raw PRIMARY append fails. SHADOW can append immutable observation history only while its lease is current and live, and cannot become winner.

`decision_commit` locks the event before updating the claim, checks live writable membership/scope, exact current event revision/evidence, token, native deadline, no previous winner and an evaluated PRIMARY in the same claim. It returns true once and false for a stale/wrong/expired/revoked token, SHADOW, unavailable result, or a subsequent winner attempt. The winner FK additionally enforces same-claim PRIMARY/EVALUATED authority. A trigger makes the claim identity/token/deadline immutable and checks deadline/current evidence/live authorization even for a direct migration-owner winner update. Writers have no direct claim INSERT/UPDATE/DELETE permission.

The caller must use its existing READ COMMITTED tenant transaction for commit, immutable failure/fallback/result appends, routing decision, audit and delivery intent. The SQL functions never open a second transaction. A callback/effect failure must roll back the winner and all associated writes. P04-029 owns that actual composition; storage tests do not claim audit/outbox/runtime acceptance. Consistent event-then-claim locking is required for orchestrators that hold additional locks.

## Index size and exact identity

The widest new three-text index keys (claim event/evidence/key and comparison primary/shadow/evaluation-version) contain at most 2,304 data bytes: each shared external ID/version is capped at 256 JavaScript UTF-16 units, giving at most 768 UTF-8 bytes with BMP CJK text. Supplementary characters use two UTF-16 units each, so 128 such characters occupy only 512 UTF-8 bytes. Existing `metric_literal` uses the same UTF-16 limit, not a plain PostgreSQL character count.

The scoped indexes retain all five scope fields. Four tenant IDs have at most 128 ASCII bytes each. The existing connection also limits external store IDs to 200 PostgreSQL characters; combined with 256 UTF-16 units, its actual UTF-8 maximum is 656 bytes (144 BMP plus 56 supplementary characters). Scope plus a maximum token/run ID therefore uses at most 1,936 text bytes, plus fixed UUID fields and small index overhead. These bounded tuples fit the PostgreSQL 16 B-tree limit of 2,704 bytes. Full raw evidence stays in the tables, the existing full evidence FK stays executable, and no hash substitutes for identity or authorization.

Tests first insert valid maximum-size upstream event/evidence rows, then exercise claim reuse, failure/fallback, run projections, comparison and winner commit with maximum CJK/supplementary values. A separate maximal scope fixture exercises the scoped indexes; one-unit overflow and each raw binding/scope mutation remain rejected. Existing upstream fingerprint/evidence indexes can still constrain other combinations of source values; this migration does not change those independent limits.

## Authorization and immutability

All four tables enable and force RLS. Separate `shopmate_decision_reader` and `shopmate_decision_writer` capability roles are NOLOGIN, NOSUPERUSER and NOBYPASSRLS; unsafe preexisting role definitions abort the migration. There are no PUBLIC grants. The migration owner must bypass forced tenant RLS so fixed-search-path SECURITY DEFINER functions can inspect authoritative live scope safely.

Policies reuse the existing `event_scope_access` membership/store/connection binding check. All six current settings (`app.user_id`, organization, workspace, store, connection, external store) are required; missing settings, revoked or suspended membership/scope, and non-READ-COMMITTED transactions deny. Readers may read assigned scope; only OWNER/ADMIN/assigned OPERATOR can write through the writer capability. ANALYST/VIEWER cannot acquire a claim merely by holding that capability.

Ordinary writers can only SELECT claims and INSERT immutable runs/projections/comparisons. They can acquire/commit claims only through the bounded functions. UPDATE/DELETE/TRUNCATE of outcome history raises an immutable-history constraint even for the migration operator; claim deletion/truncation and token/deadline rewrites are also rejected. Database superusers remain trusted operators capable of disabling database enforcement; runtime must use restricted capabilities.

## Verification boundary

`packages/database/test/integration/decision-storage.test.mjs` requires the runner's explicit isolated `TEST_DATABASE_URL`, creates owned disposable child databases, applies real migrations, and cleans up. It never falls back to a developer `DATABASE_URL`. Tests exercise full foreign keys, label/result validation, PRIMARY/SHADOW separation, live restricted-role RLS, raw SQL bypass rejection, immutable history, native deadline/supersession, two actual PostgreSQL connections sharing one claim/winner, and Prisma deploy/schema diff without drift exclusions.

The nested target is explicitly registered in `scripts/test-tenant-database.mjs`; the existing scrubbed environment, per-file positive TAP checks, zero-skipped/todo/cancelled checks and owned disposable PostgreSQL shutdown remain intact. No API target/config change is necessary for this database-only card. P04-030 still owns the ten-evaluation production transaction race including real audit and delivery intent; this component proof does not replace it.

# Demo scenario management implementation plan

Approved scope: P2 completion-plan unit 5. Synthetic demo-only scenario configuration and run management, independent of source/sync processes. All fifteen strict causal plans exist. Delivery policies 009/010 are stored here; SDK execution belongs to the sync unit.

Architecture: POST load takes scenario ID, optional day window, observed clock, confirmed session ID and expected revision/generation. API resolves and validates the full scoped session and builds an owned plan. Database rechecks writable access and current session under CONTROL then session then connection locks, validates frozen configuration, advances generation and session revisions, and atomically inserts an immutable run plus audits. GET returns at most twenty scoped runs; ACTIVE/SUPERSEDED/DISCONNECTED is derived from current connection state. Existing session and failure-rule controls remain lifecycle controls. A new run never modifies an accepted Runtime snapshot.

Alternatives: session-only storage loses run history; independently mutable run state duplicates session state. Immutable generation-bound records provide the smaller consistent boundary.

- [ ] Strict bounded load/view contracts with fail-first tests and independent commit.
- [ ] Additive DemoScenarioRun and trigger audit migration, FORCE RLS, no source-role management grants. Database transaction rechecks session/revision/generation, bumps generation atomically and persists frozen source-v2 config. Isolated PostgreSQL tests cover all fifteen plans, restart, production/foreign/viewer/revoked denial, malformed plans, concurrent stale loads, old worker/read fencing, immutable snapshots, reset/disconnect history and audit rollback. Independent commit.
- [ ] Guarded API controller/service/repository, demo environment, verified actor, manager permission, strict validation. Fail-first service/HTTP tests cover cookie, origin, spoofing, conflicts and disabled demo. Independent commit.
- [ ] Register mandatory tenant gate; build/typecheck/lint/format and PostgreSQL verification; twelve-field delivery notes. Parent owns PR/CI/merge. No deployment or online migration.

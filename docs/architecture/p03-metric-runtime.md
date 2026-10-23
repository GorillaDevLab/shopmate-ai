# Normalized metric runtime

`MetricsModule` registers the authenticated v1 store metrics and history GET routes in
`AppModule`. Each request resolves current tenant membership and current store binding.
GET/history read persisted snapshots only. They never capture source facts, calculate,
provision definitions, or call a connector/LLM. There is no public compute endpoint.

For logins inheriting `shopmate_metric_source`, a restrictive snapshot SELECT policy
also requires each exact `inputRevision` archive to belong to a currently authorized
source generation. It intersects P15 membership checks in the returned row's statement
snapshot, including history pagination and cursor anchors. A reset cannot revive old
snapshots when the same five-field binding receives a new current source scope. Generic
P15 readers without the source capability retain their existing storage contract.

The server-only `MetricRuntimeService.compute({ actor, query, computedAt })` validates
the query and exact `metrics-g4-v1` version, resolves the complete current binding,
checks immutable database definition hashes/units, and captures a source bundle when
`inputRevision` is null. An explicit revision reads only that exact archive, without
fallback. P16 rechecks current binding and composes the read-only normalized adapter,
actual captured business clock, production calculator/registry/hasher, and actor-bound
P15 append repository. Source failure returns a typed failure without a fabricated zero.
`computedAt` is audit time; visibility is bounded by the persisted source business clock.

The runtime invokes P16 separately for each requested kind/subject against the same
captured revision, registry and clock. P13 hashes the complete input coverage; singleton
inputs keep each P15 metric identity stable across batch, subset and reordered requests.
A batch can append earlier valid snapshots before a later failure; it returns that
failure without presenting partial results as a complete success. Retrying the same
revision is idempotent.

## Release configuration and provisioning

- Apply the existing tenant/P2/metric migrations, including
  `20261022090000_metric_source_bundles` and
  `20261023090000_metric_snapshot_current_source`, through the separately authorized release process.
  This change does not apply an online migration or deploy the API.
- `DATABASE_URL` remains the restricted tenant membership connection.
- `METRIC_DATABASE_URL` must explicitly identify a restricted login inheriting only
  `shopmate_metric_source` and `shopmate_metric_writer` (and their required inherited
  capabilities). It must not inherit the definition writer or worker capabilities.
- `METRIC_CURSOR_SECRET` is an explicit stable secret of at least 32 UTF-8 bytes.
  Share the same secret across API replicas and restarts. Rotation invalidates old
  cursors. Production has no generated/default key or membership-URL fallback.
- Optional `METRIC_DEFINITION_DATABASE_URL` uses a distinct login on the same host,
  effective port and database, inheriting `shopmate_metric_definition_writer` only.
  Keep this credential in the release/server process that provisions definitions.
  Normal reads and compute do not require the definition writer credential.

Before first computation for a binding, call the explicit server-only
`provisionDefinitions({ actor, binding })` with a current authorized OWNER/ADMIN actor.
The operation first resolves ownership using the source connection, then inserts the
fixed server manifest's kinds, units, version and SHA-256 hash using the separate
writer. `ON CONFLICT DO NOTHING` is followed by a separate exact hash/unit comparison.
It never overwrites definitions; mismatch or missing definitions return
`VERSION_MISMATCH`. GET/history never provision automatically. New mapping or policy
semantics require a new retained definition version and explicit provisioning.

Pools are lazy and close on module shutdown only if initialized. Every checkout rejects
superuser, RLS-bypass, owner, SET ROLE and broad administrative capabilities. URL query
options are rejected. Missing/invalid configuration allows health and other APIs to
boot, while authenticated metric operations fail with a sanitized 503. An idle pool
error marks that runtime unavailable; restart after restoring database availability.

## Evidence and replay limits

P2 real leased page commits supply paid orders, succeeded refunds, inventory and
campaign facts. Captures retain exact normalized bytes and actual prefix/receipt proof.
Frozen costs, refund allocations, return receipts, fees, traffic, inventory extensions,
measured campaign intervals and aligned profit baselines remain unknown. Their metric
values remain null with explicit quality evidence; current catalog costs are not used.

Replay supports previously captured revisions within the currently authorized active
source generation. It cannot reconstruct uncaptured overwritten history. Revoked
membership, disconnected/reset generations, unknown revisions, false windows or future
visibility never fall back to current facts. Retained prior-day payments support next-day
refund linkage. New late corrections create a new revision/evidence while old captured
v1 input hashes and results remain unchanged.

## Verification

`node packages/database/test/helpers/run-metrics-api.mjs` starts and owns an isolated
PostgreSQL cluster, removes inherited test URLs, migrates that database, prepares
separate restricted logins, replaces inherited production metric keys and runs the real
signed-cookie AppModule proof. Strict JSON evidence requires positive passing assertions
with zero skipped/pending/todo tests. The mandatory `pnpm test:tenant` runner also runs
the nested source-bundle database target before all three required API targets and
enforces the same report guards. All generated runtime URLs target the runner's database;
the metric fixture uses its own namespace on that same database.

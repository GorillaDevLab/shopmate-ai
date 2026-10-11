# Durable sync worker ports

Migration `20261009060000_sync_worker_progress` adds worker RPCs and Job
`observedAt`, `sourceWatermark`, and `pageCount`. It requires the existing Product
and generic canonical page migrations. This is a code delivery; deployment and
online database migration remain deferred.

`@shopmate/database/sync-host` is a separate privileged worker entry point. It
requires `SYNC_WORKER_DATABASE_URL` and never falls back to `DATABASE_URL`. A
dedicated PostgreSQL Client verifies its restricted login and current server
grant/principal. The grant owns the complete organization/workspace/store/
connection/external store/provider/generation binding. Application business
modules cannot import this entry point; the database input suite checks that
boundary.

`list_work` returns the latest job for each stream, at most five, for the current grant. `create_window`
uses a server-generated Job ID and serializes the complete scope/stream. It
returns an existing identical open window or creates the next fixed window from
the completed requested boundary. The existing 31-day maximum remains enforced.
Raw foundation INSERT/claim compatibility remains, and workers still receive no
direct cursor, freshness or completion UPDATE grant.

`control_lease` authorizes before locking and rechecks afterward. Claims increment
the fence, renewals/failures require the original backend and fence, and the
database owns the two-minute lease duration. The SDK holds one Client for the
lease. Connector fetch callbacks run while that backend is idle, outside SQL
transactions. ORDERS requests at most ten records; the other streams request at
most 200. Three failed connector reads produce only `CONNECTOR_FAILED`; provider
diagnostics are neither persisted nor returned.

`commit_worker_page` invokes the existing Product or generic canonical ingestion
RPC and updates the business cursor and freshness in the same server statement
and transaction. Completion requires the complete immutable PageReceipt chain,
one exact correct-stream manifest per receipt, the exact tenant/source scope,
matching whole-page hashes and terminal flags. Gaps, cursor collisions, loops,
and staged-only receipts abort the transaction. Exact completed-page replay
requires the final fence and current authority and returns original immutable
counts, including after a reconnect. Different bytes reject.

`receivedThrough` retains its requested-boundary meaning. `sourceWatermark` is
the minimum actual source watermark only when every committed page has a known
watermark; otherwise it remains NULL. `successfulThrough` receives that same
conservative value only on terminal completion. A transport-complete SUCCEEDED
window can therefore have unknown or earlier business freshness. The next window
uses the completed requested boundary, never invented source freshness.
`observedAt` records the greatest observed page time. Unknown amounts and source
watermarks remain NULL, with their existing canonical record semantics.

Completion retains the accepted backend lease fields for deferred checks. Existing
Product/generic count guards still run their original live lease, fence, backend
and current authority check; a proof-verified completed Job is checked as its
accepted running lease. A separate deferred progress guard checks the chain and
freshness. Expiry before normal COMMIT rolls back facts, receipts and completion.
The approved raw-SQL `SET CONSTRAINTS ALL IMMEDIATE` wall-clock deadline limitation
still applies. SDK methods own their autocommit statements and expose no raw
Client or arbitrary transaction callback.

The SDK page boundary is closed, UTF-8 bounded and sanitizes unsupported JSONB
record text into fixed invalid candidates for canonical quarantine. An invalid
candidate retains only its original safe `externalStoreId`, without business
content. The RPC still checks that namespace before record quarantine: foreign,
missing, overlong or unsafe scope remains a whole-page rejection, and the SDK
never substitutes the Job's scope. It exposes
generic fetch callbacks; it contains no provider-specific business ingestion.
It is a bounded worker port, not a scheduler, source publication host, P3 event
engine, or proof of full phase acceptance. Fetches longer than the lease fail
closed at ingestion; after process loss a new worker takes over after expiry.

Verification covers all five streams, unknown and conservative known freshness,
rollback/redelivery, lost acknowledgement replay, loops, staged-only manifests,
backend takeover, two tenants, terminal expiry and generation reset. SDK tests
verify idle fetches, fixed bounded failures, same-client resume, operator-login
refusal and fixture cleanup beside an already populated supplied test database.
Mandatory tenant CI includes both focused real PostgreSQL worker suites.

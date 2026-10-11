# Atomic canonical commerce page ingestion

`sync_host.commit_canonical_page(job_id text, expected_fence integer, page_id text,
expected_cursor text, page jsonb)` ingests ORDERS, REFUNDS, INVENTORY and MARKETING.
Dispatch uses the authenticated Job stream and fixed typed relation/key mappings;
it has no provider-specific branch. PRODUCTS retains its existing RPC and codec.
Migration `20261009040000_canonical_page_commit` adds the internal helpers, RPC and
one generic immutable sidecar family. Prisma tracks the sidecars and their tenant
relations. This work does not deploy a database or complete SDK orchestration.

The caller must use the current backend-pinned live Job lease, fence, principal,
worker grant and current tenant/source authority. The RPC checks authority before
waiting on a foreign Job, then locks Job, grant, memberships, tenant entities,
connection and SourceScope. READ COMMITTED is required. Scope locking serializes
canonical writes across streams. Exact retries recheck authority and lease after
waiting for a manifest lookup, even when they do not write facts. A different
backend cannot replay another backend's live pinned lease.

The closed page has `items`, `nextCursor`, `observedAt` and `sourceWatermark`.
Admission accepts at most 200 records, 16 MiB of UTF-8 PostgreSQL JSONB text and
5,000 aggregate order lines; a legal order contains 1–500 lines. Foreign or missing
externalStoreId, malformed envelopes and resource overruns reject the whole page.
The future SDK must fetch ORDERS with a page limit no larger than 10, allowing ten
maximum-size orders within this resource budget; this RPC does not change the
ConnectorPage contract or impose a ten-record limit on other streams.

Each record is validated against its closed connector DTO before source ordering.
IDs and source versions retain literal spelling and use the existing 256 UTF-16
unit budget and C collation. JSON types are exact, monetary/quantity integers are
safe nonnegative values, timestamp fractions are truncated to milliseconds and
timestamps must fit years 0001–9999. The internal validator evaluates trusted
typed-table CHECK and NOT NULL constraints against parameterized populated rows.
SQL relation names, keys, column names and CHECK expressions come only from the
fixed relation whitelist or trusted PostgreSQL catalog; business values never
become SQL text. This keeps anomaly/null constraints aligned with storage without
attempting writes or converting physical failures into quarantine. Orders also
validate closed unique lines, safe totals and complete parent/line economics.

Invalid representable records receive only fixed quarantine reasons:
`INVALID_RECORD`, `INVALID_SOURCE_TIME`, `SOURCE_TIME_STORAGE_RANGE`,
`SOURCE_TIME_OUTSIDE_WINDOW` or `SOURCE_CONFLICT`. Quarantine stores no provider
payload, error details or invalid identifiers. Decisions store a candidate hash;
only fully validated candidates can retain their typed business key. PostgreSQL
JSONB cannot represent unpaired UTF-16 surrogates or NUL: parsing fails before the
RPC executes and the entire transport call writes nothing. In-RPC quarantine of
those bytes is impossible. The later SDK's pre-JSONB record boundary must map such
input to a fixed `INVALID_RECORD` outcome without persisting parser diagnostics;
this migration does not claim to supply that SDK boundary.

Source ordering uses timestamps and equality evidence, never ordering opaque
versions. A newer source timestamp applies; an older timestamp is stale. Equal
timestamps require identical version and normalized payload hash to duplicate;
otherwise they conflict. With missing timestamps, only identical missing-time,
version and payload evidence duplicates; changed or known-vs-unknown evidence
conflicts. Absent amounts and timestamps remain SQL NULL and never become zero.
Quality contributes to payload identity; issue order and complete order line
order do not. The exact page hash separately binds the whole original JSONB page,
expected cursor and Job tenant/source/stream/window namespace.

APPLY upserts typed parent facts. ORDERS replaces every line atomically and checks
the complete snapshot immediately and through existing deferred constraints.
REFUNDS can arrive before their business order or SKU. INVENTORY keys combine SKU
and location; MARKETING keys combine campaign and date. Physical failures or
suppressed writes reject the transaction. Returned counts include per-record
APPLY/DUPLICATE/STALE/quarantine decisions and inserted/deleted order lines.

Facts, PageReceipt staging, CanonicalPageCommit, CanonicalPageDecision and
CanonicalQuarantine share one transaction. An exact committed page retry returns
REPLAYED and original stored counts after subsequent fact changes. A conflicting
page ID/payload or a staged receipt lacking a canonical manifest cannot be adopted.
Sidecars enforce tenant composite foreign keys, FORCE RLS, immutability and count
consistency. Workers receive EXECUTE only on the public RPC; no direct fact or
sidecar DML/read privilege or internal helper EXECUTE is introduced.

Terminal staging records the requested window boundary and absent actual source
watermarks stay NULL. Job.cursor, successfulThrough and business SUCCEEDED remain
unchanged until future server-owned SDK completion proof. A lost acknowledgement
followed by rollback writes nothing; redelivery after a successful transaction
returns the immutable receipt.

An initially deferred guard normally rechecks the live lease/current principal at
COMMIT and rolls back expired or identity-reset transactions. **This is not a hard,
unbypassable wall-clock COMMIT deadline.** A raw SQL worker can drain the guard with
`SET CONSTRAINTS ALL IMMEDIATE` while live, wait for expiry and then COMMIT. The
real PostgreSQL suite records that approved limitation. Future server-owned SDK
orchestration must control transaction boundaries; this RPC does not claim that
malicious workers cannot drain PostgreSQL deferred constraints.

Mandatory tenant CI runs `canonical-commit-input.test.mjs` and
`canonical-page-commit.test.mjs` alongside the existing product and typed storage
suites. The tests use restricted PostgreSQL logins, separate isolated databases,
real expiry/lock waits, rollback/redelivery, resource maxima, reader isolation,
concurrent stream locks and Prisma migration drift checks.

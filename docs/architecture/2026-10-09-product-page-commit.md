# Atomic product page commit

`sync_host.commit_product_page(job_id text, expected_fence integer, page_id text,
expected_cursor text, page jsonb)` is the restricted worker entry point. It derives
the complete tenant/source namespace from the current PRODUCTS Job. The caller
must hold that Job's current backend-pinned live lease and matching fence, grant,
principal and current tenant authority. Exact retries repeat these checks.

The RPC validates the closed page DTO and admits at most 200 products, 5,000
aggregate SKUs and 16 MiB of UTF-8 JSONB text. Invalid product items are quarantined;
foreign store IDs, malformed envelopes and oversized pages reject the whole page.
Unsupported source timestamp storage ranges are quarantined explicitly. Facts,
SKU replacement, source-order decisions, quarantine, staging receipt and canonical
manifest share one transaction. Physical write failures or suppressed writes abort
it. Source versions are opaque; ordering uses normalized source timestamps and
payload equality. Cross-product SKU ownership uses the pre-page state.

A canonical page hash binds the Job namespace, expected cursor and complete page.
An exact retry returns the original stored counts even after later fact changes;
conflicting input is rejected. A staged receipt without a canonical manifest cannot
be adopted or followed. Sidecars are immutable and inaccessible to worker/reader
table access. Job.cursor, successfulThrough and status are not advanced by this RPC;
business completion remains a separate unit. Actual source watermark may be absent.

Job, authority and source-scope locks linearize takeover, revocation and concurrent
canonical writes through transaction completion. Lease validity is checked at call
and write boundaries. An initially deferred constraint trigger normally rejects
COMMIT after lease expiry and rolls back the complete page. **This is not an
unbypassable wall-clock COMMIT deadline:** a caller can run `SET CONSTRAINTS ALL
IMMEDIATE` while the lease is live, wait until expiry and then COMMIT. PostgreSQL
drains that trigger early. Both behaviors have real PostgreSQL regressions. The
later server-owned SDK transaction orchestration must control the transaction
boundary; raw SQL workers must not be advertised as enforcing a hard COMMIT deadline.

Migration `20261008030000_product_page_commit` adds the RPC and three sidecars plus
the Job tenant key. Prisma models track these tables and composite relations.
Apply only with the existing migration identity when deployment is authorized;
this unit does not deploy or migrate a live database. Required tenant CI runs both
the input helper and RPC integration suites.

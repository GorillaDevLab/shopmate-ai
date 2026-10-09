# Bound source read ports

Server composition imports `createMockSourceReadPorts` and its named types from
`@shopmate/database/mock-platform-read`. This entry exposes a read-only factory,
fixed storage error codes and types; it exposes no worker, SQL, pool, signing key
or cursor codec. Configure `MOCK_PLATFORM_READ_DATABASE_URL` with the approved
reader login and `MOCK_SOURCE_CURSOR_KEY` through server environment variables.

Bind the freshly authorized actor `{ userId, merchantId }` and the complete
organization, workspace, store, connection, external store, session and generation
scope. Bound values are copied and frozen. Closing the factory invalidates existing
ports and prevents new bindings.

First reads use the earlier of requested cutoff and business time. Publication
discovery must cover this effective cutoff; unknown or insufficient coverage returns
null. The subsequent latest read receives the discovered certificate as an explicit
pin. Both operations share one absolute deadline, capped at thirty seconds, and the
same abort signal. Controls and requests reject accessors and proxy objects before
source I/O.

Continuations verify the signed cursor and recover the original effective cutoff.
Latest-state validation checks the scope, query hash, pinned certificate and witness.
A later publication or advancing business clock does not renew expiry or change
the pinned snapshot. Legal contract identities outside record storage bounds can
return certified empty results. Lone surrogate identities remain literal and become
certified empty only after authorization and valid publication checks.

The mandatory tenant gate includes the read-port PostgreSQL suite. No additional
migration or privilege grant is required by this facade. Deployment and online
migrations remain deferred; this unit does not complete P2.

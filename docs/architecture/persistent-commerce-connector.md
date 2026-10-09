# Persistent CommerceConnector boundary

`PersistentCommerceConnector` implements the common thirteen-method contract using an injected,
server-owned `PersistentReadPort`. It does not generate or cache synthetic history. Runtime
`MockConnectorFactory` now requires the persistent binder and constructs this adapter. Public
callers use the authoritative factory; offline `MockCommerceConnector` remains an explicit fixture.

The composition must bind the reader to the complete organization, workspace, store, connection,
external store, session and generation namespace. It must verify persisted publication certificates,
pin the first page, use the same absolute real-time deadline and abort signal for all SQL, and recover
the signed effective cutoff on continuation. A decoded token alone is neither authorization nor a
certificate. Query context includes the original canonical until/since, method, limit, SKU filter and
point reference; business-clock advancement does not change that context or the pinned cutoff.

Each call checks fresh access before source I/O and again before returning its result. The adapter
validates returned namespace, source metadata, kind, entity key, publication bounds and effective
cutoff. One call receives at most 32 candidate states. Filtering may produce an empty intermediate
page with a continuation; clients must follow that continuation. The watermark reports the pinned
effective cutoff, bounded by the requested time and observed business clock.

An absent or lagging publication returns `TEMPORARY`. A validated complete empty page is successful,
and a point absence under that publication returns `NOT_FOUND`. Deleted rows, partial quality and
unknown costs remain explicit. Malformed source responses return `INVALID_RESPONSE`. Mock writes
remain rejected with their original execution ID, and verification remains unsupported.

`DemoCommerceModule` owns one lazy `DatabasePersistentReadPorts` provider. This unique composition
module imports the named read-only factory and types from `@shopmate/database/mock-platform-read`.
Business and web modules cannot import source SQL, pools, worker ports or cursor codecs. The
provider closes its pool on module destruction and translates source errors to fixed connector
failure codes. Each open receives its own `PersistentMockClock`; binding actor and full scope come
from the freshly validated access record, never a request namespace.

Configure `MOCK_PLATFORM_READ_DATABASE_URL` with the approved reader login and
`MOCK_SOURCE_CURSOR_KEY` through server environment variables. Missing configuration fails closed;
there is no offline runtime fallback. Discovery and latest SQL share one server-capped absolute
deadline and the same abort signal. Access lookup retains its existing fifteen-second transaction,
ten-second statement and five-second lock limits; the resolver has no active SQL cancellation.

The mandatory authenticated AppModule/PostgreSQL suite publishes fixtures through restricted worker
initialize/claim/append/publish ports. It exercises certificate absence, known DTOs, restart and later
publication, scope/filter tamper, generation/session replacement, access revocation during SQL and
source backend cancellation with pool reuse. Disposable operator teardown restores trigger
protection before normal calls; fixtures never manufacture certificate or source version rows.

This composition adds no migration or deployment. Incremental generation, scenarios, failures,
other stream sync and final P2 acceptance remain separate work.

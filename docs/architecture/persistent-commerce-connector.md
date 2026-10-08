# Persistent CommerceConnector boundary

`PersistentCommerceConnector` implements the common thirteen-method contract using an injected,
server-owned `PersistentReadPort`. It does not generate or cache synthetic history. The existing
factory is not switched by this unit; composition with the database latest reader is a subsequent
change. Public callers must continue using an authoritative factory, never constructing this adapter.

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

No migration, production deployment, public factory switch, normalized fact ingestion or sync
completion is included in this adapter unit.

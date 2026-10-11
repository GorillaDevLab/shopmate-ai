# Sync runtime execution plan

Approved scope: an independent worker consumes all five CommerceConnector streams. Composition may select a provider; business ingestion cannot. No deployment or production migration is included.

## 1. Independently reviewable checkpoint recovery

- Add `refreshLatestCheckpoint(actor, scope, input, control)` to the restricted source reader and `refreshCheckpoint(request, control)` to its bound read port. Normal reads continue rejecting expired cursors.
- Verify the original MAC and closed bounded state, exact scope/query, current actor authorization, immutable publication certificate/revision/high event sequence, and the original last tuple witness. Only expiry changes. Recheck authorization after waiting and before returning.
- Refresh and subsequent read share the caller's original 25 second deadline and abort signal. No business cursor update occurs until the atomic page commit accepts the original expected cursor.
- Fail first with real restricted PostgreSQL: expired normal read fails; restarted authorized refresh resumes exactly; later publications do not repin; tampering, changed query, revocation and generation reset fail. Include deadline and abort cases. Build, lint and existing read suites precede a small commit.

## 2. Server derived bootstrap and pure connector composition

- Reserve migration `20261009110000_sync_runtime_bootstrap`. The dedicated sync login supplies only an environment grant id. The database derives principal, merchant, complete current binding, demo configuration, opening time and business clock from `session_user` and the active grant. No caller supplied identity or target; no Prisma or application database fallback.
- Provide a narrow read repository and pure API connector export that never imports AppModule. A separate restricted source identity supplies publication/read/checkpoint ports.
- Freeze a common target for all five streams at or before both the actual business clock and verified published source watermark. Missing publication waits without creating or advancing a window. Windows are contiguous and at most 31 days.
- Use full snapshots as of each target for nullable source timestamps and late corrections. Marketing begins at the runtime opening midnight, not an arbitrary incremental window boundary.

## 3. Bounded runner and acceptance

- Create `apps/sync-worker`. Renew the pinned backend lease, perform connector reads outside SQL transactions, renew again and atomically commit. Retry only bounded retryable connector failures; reject unsupported providers while preserving progress.
- Check AbortSignal before and after fetch and before commit. Budget exhaustion and graceful stop close the connection with committed progress intact; a RUNNING lease becomes claimable after its existing two minute expiry. Only exhausted actual connector failures use `CONNECTOR_FAILED`. No YIELD state is introduced.
- Test restart, expired persisted checkpoint, revocation/reset, backfill and nullable freshness with real restricted PostgreSQL. Add focused unit cases and mandatory CI fields/gates; each independently testable logic change gets its own commit. Root owns push, review and merge.

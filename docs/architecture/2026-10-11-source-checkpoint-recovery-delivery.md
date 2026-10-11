# Persistent source checkpoint recovery

1. Scope: independently reviewable recovery foundation for P2 durable synchronization. No worker process, business ingestion, deployment or online migration is included.
2. Reader: `refreshLatestCheckpoint(actor, scope, input, control)` accepts a previously issued signed latest-state checkpoint, including one whose read expiry has elapsed. Ordinary reads still reject expired cursors.
3. Bound port: `refreshCheckpoint(request, control)` retains the server-bound actor and complete source scope. It restores the signed original cutoff and rejects a requested/business cutoff earlier than that instant.
4. Input: the existing closed bounded request validators and canonical 1,024-character HMAC envelope remain mandatory. Scope, generation, query context, kind, exact key, limit and cutoff stay bound to the original checkpoint.
5. Authority: the recovery transaction acquires the existing control lock and checks current reader credentials and actor membership. It checks current access again after restoring the witness and before returning.
6. Snapshot: recovery reads the original revision, verifies its certificate and high event sequence, and restores the original immutable tuple witness. A later publication never repins this operation.
7. Expiry: only the new cursor expiry changes, using the existing fifteen-minute maximum. Recovery does not update a business cursor or commit a synchronization page.
8. Cancellation: the existing restricted read transaction and capped absolute deadline apply to recovery. Callers must pass the same original deadline and AbortSignal to recovery and subsequent read; no new time budget is required.
9. Storage: there is no schema or role migration. Recovery uses existing authorized publication and EntityVersion reads; the read-only package exports no signing codec, secret or worker operation.
10. Verification: fail-first real PostgreSQL coverage establishes expired normal-read refusal and restarted recovery. Restricted database tests cover later publication, exact continuation, altered query/MAC, unknown actor, revoked membership, replacement generation, pre-abort/deadline and cancellation while waiting on the control lock, followed by pool reuse.
11. Review and compatibility: parent reviewed current authority, immutable publication/witness checks, exact scope/query bindings, cancellation and read-only exports. Existing cursor, latest-state, architecture and read-port tests remain enabled in mandatory CI.
12. Remaining work: server-derived sync bootstrap, pure connector composition, the independent sync process and final full-profile source-to-sync acceptance follow the approved runtime plan. This foundation does not complete P2; exact-head GitHub CI and merge are separate delivery gates.

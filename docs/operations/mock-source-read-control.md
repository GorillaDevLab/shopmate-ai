# Source reader cancellation

The database reader accepts optional `SourceReadControl` on `findGeneration(actor, scope, control)`, `findPublication(actor, scope, control)`, `scanVersions(actor, scope, input, control)` and `readLatestStates(actor, scope, input, control)`. Existing callers remain valid. Pass `signal` and `deadlineAt`; the deadline must be a real canonical UTC ISO timestamp with milliseconds and `Z`. An adapter accepting timezone offsets should normalize with `toISOString()` before calling this boundary.

The total read budget includes pooled acquisition, credential checks, CONTROL waits, queries and commit. It defaults to thirty seconds and caps longer caller deadlines at thirty seconds. An already aborted signal returns `SOURCE_ABORTED`; an expired budget returns `SOURCE_DEADLINE`. Invalid controls return `SOURCE_INPUT`. Error messages contain only these fixed codes, never the caller's abort reason or database details.

For an acquired connection, cancellation opens a short-lived connection with the same configured reader login and calls parameterized `pg_cancel_backend(pid)`. Same-login cancellation needs no elevated role, extra grants or migration. The primary connection stays checked out until cancellation completes or fails, then is destroyed and its pending query is drained. PostgreSQL rolls back its transaction and releases locks. Closing the socket alone cannot promptly stop SQL on every supported platform.

The cancellation connection has one-second connection and query timeouts and is closed on all outcomes. If cancellation fails, the primary socket is still destroyed and the original fixed abort/deadline error is preserved. PostgreSQL may retain blocked work until its server timeout: at most ten seconds for an active reader statement, or five seconds for a CONTROL lock wait. Reader startup also applies the ten-second statement bound to credential verification before BEGIN. These fallback limits are not a claim that failed cancellation stops server work immediately.

A canceled pool wait rejects promptly and drains the eventual checkout by releasing it; the existing five-second acquisition timeout bounds its pending pg request. Current credentials and human access are rechecked on subsequent calls. Worker transactions, source semantics and lease lengths are unchanged. The mandatory tenant harness includes `mock-source-read-control.test.mjs`; isolated PostgreSQL tests assert backend disappearance, lock cleanup, cancellation failure cleanup and pool recovery. Deployment and online migrations remain deferred.

Latest-state reads use the same total transaction boundary for CONTROL, certificate,
candidate, value and compact cursor-witness queries. Cancellation does not advance
the caller's cursor; an explicit retry retains its signed publication/query identity
and absolute cursor expiry. The cancellation budget is per call, so a host performing
publication discovery followed by a latest-state read should pass the same absolute
deadline and signal to both calls to share its remaining caller budget.

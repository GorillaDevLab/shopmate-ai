# Sync worker building blocks

This package provides a pure advisory window planner and restricted commerce read composition. It does not yet provide a CLI or durable job runner.

`SyncCommerce` opens the existing read-only connector from a freshly checked server runtime bootstrap and restricted source ports. Factory access rechecks current authority and refreshes the persisted business clock. `CheckpointReadPort` can recover expired signed continuations without changing their original cutoff or committing business cursor progress. All five read streams are supported; windows and business facts still require the separate durable runner.

`planSyncWindows(input)` accepts a closed normalized projection and validates it at runtime, including bounded identifiers, exact canonical UTC milliseconds, five unique stream slots and data-only objects. Accessors, proxies, custom prototypes and unknown fields are rejected without invoking user getters or proxy traps.

The caller must first validate the server-derived runtime bootstrap with the database SDK and verify the immutable source publication with the restricted source reader. Project those validated results into `WindowPlannerInput`:

- `binding`: the worker's fixed `grantId`, `provider: "MOCK"`, complete source `scope`, and grant `initialSince`.
- `bootstrap`: only the current `scope`, actual UTC `businessNow`, and `READY` or `WAITING_RUNTIME` state. The SDK owns READY/runtime opening consistency. The planner does not require `initialSince` to equal runtime opening.
- `publication`: `null` when unpublished; otherwise verified `scope`, `targetTime`, and `processedThrough`. A published source with zero events still has valid coverage; event counts are irrelevant to planning. This structural projection does not itself authenticate a certificate.
- `latestJobs`: at most one latest job per stream, each containing only `grantId`, `provider`, `scope`, `stream`, canonical `since`/`until`, and `status`. Parse raw `list_work` JSON before projection. SQL job identity lacks sessionId; attach the fixed session scope only after checking the job's full persisted binding against the validated bootstrap. Never pass raw SQL job JSON directly.

Scope consists of organization, workspace, store, session, connection, external store and generation. Each projection must match the fixed binding. Historical contiguity and terminal receipt proof remain enforced by `create_window` and database triggers; the planner cannot certify history omitted from a latest-job projection. `SUCCEEDED.until` is durable consecutive receipt progress even when business freshness is unknown. The planner intentionally does not consume `successfulThrough` or assert sync freshness.

Fresh windows share the minimum of the actual business clock, verified publication target/coverage and every stream's start plus 31 elapsed UTC days. Each start is the latest completed job's `until`, or grant `initialSince` for a missing stream. Streams already at that common target are skipped.

Any unfinished latest job freezes its original target, including READY, RUNNING and FAILED jobs. Existing jobs appear in `existingStreams`; only missing/lagging streams appear in `windows`. Conflicting unfinished targets, completed progress beyond the frozen target, or a missing stream that cannot reach that target in one contiguous 31-day window are rejected. Insufficient current clock or publication coverage waits without creating windows.

A `PLANNED` result contains the target, whether it is frozen, windows to create, and existing streams to resume. A `WAITING` result always has an empty `windows` array and one of `WAITING_RUNTIME`, `WAITING_PUBLICATION`, `WAITING_COVERAGE`, or `CAUGHT_UP`. Callers remain responsible for rechecking server authority when applying advisory plans.

# Common synchronization window planner

1. Scope: establish the pure `apps/sync-worker` package and the P2 common-window planning boundary. There is no executable worker process in this change.
2. Streams: PRODUCTS, ORDERS, REFUNDS, INVENTORY and MARKETING share one proposed target time. The planner performs no SQL or Connector calls.
3. Authority: callers project a checked server-derived bootstrap and a certificate-verified source publication. The planner rejects mismatched grant, provider, complete source scope or generation; projections are advisory and never replace server authority.
4. Input: closed bounded projections reject unknown keys, duplicate or unknown streams, malformed calendars, accessors, proxies and oversized or sparse job arrays without invoking hostile getters.
5. Availability: WAITING_RUNTIME, absent publication and insufficient clock or verified source coverage produce explicit waiting results with no proposed new windows. Published empty data is not treated as absent publication.
6. Target: a new common target is bounded by actual business time, publication target and processed watermark, and every required stream's thirty-one-day maximum window.
7. Continuity: each stream starts at the grant's initialSince or its latest completed job.until. Durable receipt progress remains usable when business freshness is unknown; no successfulThrough value is synthesized.
8. Restart: unfinished READY, RUNNING or FAILED jobs freeze their original common target. Partially created windows are completed at that target; streams already completed there are skipped. Conflicting active targets, scope or dates reject.
9. Server proof: unseen historical gaps cannot be proven from a latest-job projection. Existing create_window constraints and receipt proof remain responsible for historical continuity, current authority and atomic state changes.
10. Unit verification: 55 planner cases plus the package boundary test pass after recorded fail-first runs. Independent review reran the 56 cases, typecheck and lint with no actionable findings.
11. Root verification: database and sync-worker builds, all 56 package tests, lint and diff checks pass after incorporating current main. Workspace scripts discover the package and root formatting includes its source and configuration.
12. Remaining acceptance: exact-head CI gates merge. Connector composition, persisted checkpoint integration, real runner/restart behavior, scenario outcomes and full-profile source-to-sync validation remain required for P2. No deployment or remote migration is included.

# Grant-scoped runtime failure metadata

1. Scope: P2 read-only bridge from persisted demo failure rules to the dedicated sync worker; no deployment or online migration.
2. Input: one bounded grant ID on the pinned dedicated sync login. Caller identity GUCs cannot select another principal or source namespace.
3. Authority: current active grant, workspace membership, DEMO marker and exact organization/workspace/store/session/connection/external-store/generation binding are required.
4. Concurrency: the existing bootstrap acquires the source CONTROL lock; a fresh descriptor after reading rules fences current authority and mutable business time.
5. Isolation: workers receive only guarded RPC EXECUTE, with no direct DemoFailureRule SELECT or mutation privileges. PUBLIC execution is revoked.
6. Rules: nonremoved rules ending after the current business clock are returned by priority descending and ID. Future start times remain available for the connector to evaluate at call time.
7. Bounds: SQL returns at most 33 entries; the SDK rejects more than 32, duplicates and malformed effects rather than silently truncating an invalid view.
8. SDK: runtimeFailureRules() uses the existing grant-bound backend and checks the returned grant ID. Null means current authority or binding is unavailable.
9. Validation: descriptor-only bounded checks reject context/rule proxies and accessors before parsing, including nested scope and configuration. Context and rules are deeply immutable after validation.
10. Verification: nine real PostgreSQL tests cover identity spoofing, foreign grants, permissions, membership/grant revocation, CONTROL wait, production marker, expiry/removal and generation replacement. Four focused parser tests include hostile nested context regressions; legacy bootstrap and tenant migration checks pass.
11. Delivery: migration, SDK, mandatory CI registration, review fix and this report are separate commits. Independent review and exact-head full CI are merge gates.
12. Remaining P2: wire this loader into the bounded durable sync runner, verify interruption/replay scenarios and complete full-profile source-to-sync acceptance. Rules alone do not establish publication or downstream freshness.

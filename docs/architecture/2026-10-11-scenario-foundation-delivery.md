# P2 scenario configuration foundation

1. **Scope:** synthetic, owned commerce configuration and causal facts only. This is a foundation for completion-plan unit 5, not P2 phase acceptance.
2. **Behavior:** fifteen bounded manifests change orders, inventory, refunds, pricing, launch ramps, economics and marketing through deterministic causal inputs. Expected conclusions remain test-only.
3. **Versioning:** optional strict `scenarioPlan` creates `mock-source-v2`; unplanned configuration remains `mock-source-v1`. Existing accepted generations are never reinterpreted.
4. **Compatibility:** four frozen v1 profile hashes are asserted against values measured independently from parent `fc1ed17`.
5. **Ownership:** plans bind `externalStoreId`, reject unknown keys, duplicate/out-of-range SKU mutations and invalid delivery bounds. Configuration hashes canonicalize JSONB field order.
6. **Persistence:** migration `20261009050000_mock_scenario_version` permits owned v2 Runtime snapshots and v2 BuildJobs while retaining v1 constraints. Apply through the normal ordered migration flow; no online migration was run.
7. **Causal observations:** scenario 003 raises actual order revenue while order costs, fees, refunds and marketing lower profit; 008 introduces an actual product launch and ramp; 014 uses the new-store fourteen-day opening and missing cost evidence.
8. **Restart checks:** all fifteen plans reproduce timestamp groups and snapshots across daily restarts, including price transitions and unknown opening cost.
9. **Focused validation:** API scenario facts, restart and v1 parity suites; schema-order configuration guards; isolated PostgreSQL migrated v1/v2 initialization, claim, append, publication and restricted reads; raw restricted-worker incompatible Runtime inserts; tenant-gate registration test.
10. **Operational limits:** scenarios 009/010 freeze interruption/replay policies only. Source business facts intentionally equal baseline; real SDK delivery interruption, saved-page replay and durable sync acceptance are pending.
11. **Remaining work:** authenticated demo-only load/advance/fault management, audit/run state, SDK delivery controls, persistent connector observations and full source-to-sync phase gates. No management UI, real platform/Jev/LLM calls or deployment is included.
12. **Integration:** source-worker exports/version selection must consume the optional scenario plan after branch integration. Throughput and durable sync work are separate units; this branch does not edit their host code.

# Restricted commerce composition for the sync worker

1. Scope: P2 composition of checked server bootstrap, restricted source reads and the existing read-only CommerceConnector; no deployment or online migration.
2. Identity: dedicated grant-only sync login derives the actor, merchant and full source namespace. Worker code supplies no tenant selection or business target to bootstrap.
3. Isolation: pure API commerce export avoids AppModule and application database initialization. Source reads use the separate restricted reader; no generator, signing codec or mutation API is exposed through the composition.
4. Readiness: missing/current-generation runtime waits with null; verified empty publication is distinct from unknown coverage. Opening a connector cannot assert synchronized freshness.
5. Current authority: each factory access resolves fresh grant/member/DEMO/current configuration and generation. Revocation or immutable binding replacement denies reads. Mutable business-clock and rule revision advances remain valid.
6. Clock: actual persisted clock revision/generation refreshes the business clock before each authorized read. A continuation retains its signed original cutoff despite later clock/publication advances.
7. Checkpoints: expired signed source cursors are explicitly recovered only after original certificate/query/witness/current authority verification. Read, refresh and retry share the original absolute budget; business cursor persistence remains the atomic commit's responsibility.
8. Errors: source input/integrity/abort/deadline/storage failures map to specific Connector results. Unsupported writes remain unsupported.
9. Controls: closed descriptor-only read controls reject proxies, accessors and forged/overridden signal state before invoking source work. Deadlines are capped at 25 seconds for worker composition.
10. Verification: five-stream real PostgreSQL commerce acceptance and two restart/checkpoint recovery tests pass. Focused API and worker tests cover live revocation, binding changes, current clock, budgets, cancellation and hostile input. These PostgreSQL suites are mandatory in tenant CI.
11. Delivery: dependencies, checkpoint adapter, source error translation, composition, review fixes, real database acceptance, CI registration and this report are separate commits. Latest-head complete CI and independent review are merge gates.
12. Remaining P2: application of verified common-window plans, fault loader wiring, bounded durable runner/CLI, interruption/replay and full-profile source-to-sync acceptance. This component reads pages; it does not create jobs or commit business facts.

# P04-030 Event Concurrency and Atomic Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Prove concurrent deduplication, revision ordering, atomic effects and security deadlines against real disposable PostgreSQL without changing production behavior.

**Architecture:** Exercise the merged P04-029 transaction owner, event/decision repositories, host, routing, audit and outbox on independent restricted connections. Keep the actual AppModule's conservative offline Rules behavior separate from typed component fixtures that explicitly provide known preferences, budget and sufficient evidence. Register both proof targets in the mandatory tenant runner.

**Tech Stack:** Node test runner, Vitest, Nest testing, pg, existing isolatedPostgres and migration helpers.

## Global Constraints

- BASE ec8a426722c9425d181e9b67f4f82237123ca662; feat/p04-030-event-route-concurrency; issue #258. P04-029 is merged, verified Done; Harry's sole active card is P04-030.
- QA-only: no production source, migrations, dependencies, workflows, deployment or provider integration changes. A reproducible production defect must be reported back to its implementation card rather than hidden by weaker assertions.
- Functions, callbacks, tests and SQL bodies <40 physical lines; TypeScript no any or suppressions; validate fixture boundaries; parameterized SQL and env-only credentials.
- Preserve all existing 59 mandatory targets. Add packages/database/test/integration/event-decision-concurrency.test.mjs and apps/api/test/event-route-atomicity.e2e-spec.ts explicitly; API tenant include/default exclude. Every target executes positive tests with zero skipped/todo/cancelled; empty selection fails.
- Only runner-owned isolated PostgreSQL URLs; scrub inherited database/operator/migration URLs. Stop owned resources in finally. Do not touch previously policy-rejected abandoned temporary resources.
- No Jev, LLM or vendor traffic, scenario oracle, fabricated runtime normalized source facts, or claim that default unknown preferences/budget authorize immediate/DEEP routing.
- Same event ten repeats/concurrent evaluations: one active event, unique effective winner, one immediate intent and corresponding audit; demonstrate a positive authorized DEEP route before checking duplicate authorization is absent.
- Older source/evidence cannot replace newer evidence; fresh severity upgrade/recovery can legitimately break cooldown while old route keys remain unique.
- Audit/outbox failure rolls back the whole event/decision/effects transaction. Real SECURITY_UTC deadline and monotonic time prevent late effective commit. Timed-out primary's late result cannot displace a committed fallback winner.
- Keep separate granular verified commits; independent task review and whole-branch review; exact latest-head six-job CI before normal PR merge. Keep branch/worktree.

## Existing seams and file map

- Owned mandatory targets: the two new paths above. Shared locked paths: scripts/test-tenant-database.mjs, apps/api/vitest.tenant.config.ts, apps/api/vitest.config.ts.
- New test-only helpers, if needed: packages/database/test/helpers/event-decision-concurrency-fixture.mjs (+ .d.mts only for TS consumers); apps/api/test/helpers/event-route-atomicity-fixture.ts and event-route-component-fixture.ts. Keep fixture setup, component wiring and behavioral assertions separate. No unrelated helper edits.
- Existing notification-outbox-fixture.mjs exports database(action) and migrate(admin). database creates a child shopmate_tenant_test_<uuid> from validated runner TEST_DATABASE_URL and drops it in finally. This allows the fixed-ID EventDecisionsApiFixture to initialize in a child database without colliding with other API targets.
- Prepare child restricted URLs with prepareTenantApiRuntime(url), prepareMetricApiRuntime(url), prepareEventDecisionRuntime(url); use tenantEnvironment for child execution and restore test environment afterward. EventDecisionTransactionOwner.run(authority, work) owns real transaction/client and routing advisory lock.
- persistRuntimeCandidate(uow, scope, candidate, requestId, correlationId) persists validated test-only candidate evidence through real repositories. Production DefaultDecisionInputSanitizer, DefaultDecisionHardGate, DecisionEvaluationHost, DecisionRoutingService and real createDecisionRunRepository remain the implementations under test.
- Default createRuntimeDecisionHost deliberately fixes preferences/budget null and Rules-only descriptors. It cannot prove a non-rules fallback or positive DEEP authorization. Component fixtures use explicit known typed routing state; custom primary/fallback stable keys require real createDecisionRunRepository({actor,client:scope.client,clock,decisionKey}) and NotificationEnqueueRepository({decisionKey}). Do not reuse runtimeDecisionKey/applyRuntimeEffects with an incompatible custom key or claim a fake App wiring.

## Task 1: Add and register PostgreSQL concurrency and API atomicity proofs

**Deliverable:** Two mandatory real-database targets, focused helper fixtures, evidence mapped to all four acceptance criteria. No application change.

- [ ] Record clean baseline: routing/evaluation host unit tests already passed 102/102 at BASE; preserve this dated evidence. Inspect actual repository/fixture signatures before constructing test inputs.
- [ ] Add the smallest real DB fixture and DB target. Validate isolation URLs, current restricted identities and two different pg_backend_pid values. Use explicit deferred barriers/observed database waits with bounded deadlines to prove overlap; avoid relying solely on Promise.all or arbitrary sleeps. Exercise ten sequential and overlapping attempts of one fingerprint/key, duplicate append, stale expectedRevision, newer evidence then delayed old evidence; verify durable counts and identities through independent readback.

```js
const pids = await Promise.all(sessions.map((client) => client.query('SELECT pg_backend_pid() AS pid')));
assert.equal(new Set(pids.map((result) => result.rows[0].pid)).size, 2);
// Assertions read committed state after both attempts finish, not local mock counters.
```

- [ ] Add API proof using a child database and actual AppModule. Seed source only through existing EventDecisionsApiFixture and metric provisioning, then evaluate concurrently on real pools and query protected event/evidence endpoints. Assert the genuine default DAILY_BRIEF/no-DEEP behavior separately; keep server-only evaluation unexposed.
- [ ] Add typed component tests with sufficient aggregate evidence, known notifications ALL/allowDeep/budget, real host/hard gate/routing/repositories and transactional effects. Assert first NOTIFY_NOW + DEEP, repeat/concurrent same-key replay retains one winner/intent/audit and does not call the route/provider twice for the committed key. New evidence with unchanged severity defers; a higher severity and a legitimate recovery produce their new routes with immutable old winners intact. Persisted history, not an invented local list, supplies cooldown state.

```ts
expect(first.effective).toMatchObject({
  notificationRoute: 'NOTIFY_NOW', llmEscalation: 'DEEP_REASONING_REQUIRED',
});
expect(new Set(results.map((run) => run.id)).size).toBe(1);
// Count committed winner and intent identities as the authorization/effect proof.
```

- [ ] Inject audit and outbox failures at actual SQL/effect boundaries in the isolated database after earlier writes have occurred; restore fault hooks in finally. Check no event, evidence, claim, winner, audit or intent half-commit and that a clean retry commits once. A typed enqueue denial must also propagate rollback.
- [ ] Gate an offline primary provider with explicit entered/release promises. With real SECURITY_UTC plus bounded attempt timeout, let fallback win, release the late primary, await its completion, then fresh-query the original fallback winner/route/intent. Separately let the overall deadline expire while work is pending; release and drain late work, assert no effective winner/effects. Never use vi fake timers for these security proofs.

```ts
const control = runtimeControl(500);
// Resolve entered before awaiting the result; release only after deadline/fallback outcome.
await expect(expiredEvaluation).rejects.toMatchObject({ status: 503 });
expect(await fixture.counts()).toEqual(before);
```

- [ ] Show tests are sensitive to the protections they exercise using bounded temporary test-only negative controls (e.g. deliberately wrong expected durable count or disabled fixture fault). Record expected failure then restore and rerun; no production guard mutation is required for a QA-only card.
- [ ] Register DB target with the runner's explicit nested run call; add API target to apiTargets and tenant config include/default config exclude. Assert each new target is selected; preserve existing report validation, environment scrubbing and all old targets. Run config/runner regression checks.
- [ ] Format/lint changed code, API typecheck, required package builds and focused real-PG proofs. Each independently verifiable unit gets its own commit with real check results.
- [ ] Run pnpm test:tenant once after focused checks pass; capture per-target counts, zero skips/todos/cancellations and cleanup. Final target count must be 61. Record exact source SHA, commands and outputs; no reused earlier source proof.
- [ ] Self-review all four card criteria and each Global Constraint; report any unproven requirement explicitly. Freeze clean source and hand task/full-branch review the entire BASE..HEAD range. Address findings with covering checks. Create/attach PR closing #258; merge normally after six exact-head checks succeed; verify task completion/readiness through existing state sync.

## Verification boundaries

This proves test-only component authorization and real PostgreSQL race/rollback semantics plus the default bounded App path. It does not grant production DEEP access, add real providers, complete the fifteen scenario families or deploy anything manually. A counterexample in existing production behavior blocks completion and returns to the responsible implementation scope.

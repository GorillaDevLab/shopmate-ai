# Persistent demo failure rules (P2.4 completion plan #6)

## 1. Goal

Authenticated creation, inspection, confirmed removal and business-clock expiry of persistent demo read failures. The production merchant context cannot enable these controls.

## 2. Why

Recovery tests need failures selected by durable session state, including after connector or API restart. Rules affect actual connector calls; they do not inject business conclusions into sync, event processing or agents.

## 3. Architecture impact

`DemoFailureRulesController` uses the existing authenticated demo guard and Origin protection. The service resolves current membership and `demo:manage`; the repository independently verifies current demo tenant, environment, session and connection. `DemoCommerceConnectorHost` supplies a server-owned loader to `ReadFaultInjectingConnector` around the persistent source adapter. Rule loading and authorization never accept client namespace or actor fields.

## 4. Changed files

Shared rule/command contracts; normalized database rule and audit tables; database read/mutation repository; demo API controller/service/repository; factory/host composition; restricted PostgreSQL, authenticated AppModule and malformed control regressions; mandatory tenant gate registration.

## 5. Database

Migration `20261009030000_demo_failure_rules` adds `demo.DemoFailureRule` and `demo.DemoFailureRuleAudit`. Each rule binds organization, workspace, store, session, connection, external store and generation. Mutations acquire `demo.lock_source_control` before ordered session/connection row locks, use the current session revision and increment that revision once. Trigger-created audit and rule state commit atomically; suppressed audit insertion rolls back the rule and revision. Audit insertion requires a nested rule-mutation trigger, and audit UPDATE/DELETE have no RLS policy.

Both tables enable and force RLS. Public and source worker/reader table privileges are revoked; source-role members are also denied rule writes if tables are accidentally granted. API role provisioning needs SELECT/INSERT/UPDATE on rules, SELECT/INSERT on audit, USAGE on its sequence and EXECUTE on `demo.has_failure_rule_access`; the isolated runtime fixture demonstrates these grants without weakening source privileges. Existing `DemoControlAudit` kinds remain unchanged. Prisma migration drift checks pass.

## 6. Security

Mutation bodies are strict bounded data: plain prototypes, own data descriptors, depth/key/string limits, no getters, custom prototypes or throwing reflection. Durations are at most 30 days, current unremoved/unexpired rules at most 32, methods unique and effects bounded. SQL is parameterized. Removal requires rule ID, expected revision and explicit confirmation of the current session ID. Membership, demo marker, session/generation and current read permission are verified around rule loading and actual persistent reads. Storage exceptions are sanitized at HTTP and connector boundaries.

## 7. Privacy

Only synthetic demo records and bounded rule metadata are stored. No secrets, request actors, raw namespace selectors, real provider credentials or external model calls are introduced.

## 8. Tests

- Shared command contracts: 4 passed, including throwing reflection; missing contracts and accessor/proxy failures observed before implementation.
- Focused demo/fault/factory API suites: 244 passed across 10 files. Wrapper authorization regression observed TEMPORARY before correction and PERMISSION_DENIED afterwards.
- New restricted isolated PostgreSQL rule suite: 10 passed, no skips. Covers reopen, CAS, confirmation, current role, atomic audit suppression, clock expiry, reset generation exclusion, removal, 32-rule limit, concurrent mutation, worker denial and immutable audit.
- Existing demo database suite: 32 passed, no skips, including Prisma migration drift.
- Full authenticated restricted persistent AppModule suite: 32 passed, no skips. The new HTTP test creates a RATE_LIMIT rule, opens and reopens a connector, confirms removal, then receives the actual persisted product.
- Contracts/API/database type checks, changed-file lint and formatting, production function length check and `git diff --check` passed.

`test:tenant` now requires the new database suite. Full tenant acceptance and latest-head CI remain parent integration gates; they were not run concurrently here.

## 9. Manual verification

Under a valid demo cookie and same-origin POST, use `/api/v1/demo-commerce/stores/:storeId/session/failure-rules`. GET returns session ID, generation, revision, business clock and current rules. POST accepts `{ expectedRevision, rule }`; POST `/remove` accepts `{ expectedRevision, confirmSessionId, ruleId }`. Read-only callers may inspect authorized rules; only owner/admin demo managers may mutate. Production-disabled, foreign-store, unauthenticated and invalid-control requests fail without selecting arbitrary ownership.

## 10. Risks and limits

Expiry is evaluation against persisted business time, without background deletion; ADVANCE records the clock transition in the existing control audit. Historical and removed rules remain stored, and old generation rules cannot reactivate on reset. No runtime hit counters or write acknowledgement ambiguity are introduced. DELAY postpones an actual read within its real deadline; the current port does not expose an older-visibility control, so this does not manufacture delayed-consistency facts. INVALID_RESPONSE is a bounded failure code, not raw corrupted provider output. No UI, deployment or online migration was added.

## 11. Next

Parent independent review, integrated mandatory tenant gates and latest-head CI before any authorized merge. Scenario/source-generation/sync modules and P8 write acknowledgement behavior remain outside this unit.

## 12. Commits

Separate commits cover shared contracts, reflection hardening, storage/audit, authenticated API, persistent wrapper, fixture lint/format, integration gates and this delivery document. The branch is retained without push or PR for parent review.

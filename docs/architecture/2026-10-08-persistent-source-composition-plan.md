# Persistent source runtime composition

## Boundary

Wire the existing persistent CommerceConnector adapter into the demo connector host. Runtime reads use certified latest entity states from a server-owned, read-only database port. Missing publication or coverage means unknown/TEMPORARY. There is no synthetic replay fallback, worker API, write behavior, new connector registry, deployment or P3 scope.

Dependencies are #449 session identity binding (already main), #451 compact witness cursors, #447 SQL read control and #452 persistent adapter. Start on main in `feat/persistent-source-composition`; keep dependency commits separate and rebase a clean tree after they merge.

## Architecture

- Add a dedicated `@shopmate/database/mock-platform-read` export that exposes a read-only factory and transport types. The source signing key and compact decoder stay inside the database package. The API cannot obtain worker factories through this export.
- The factory owns one reader pool; binding a port freezes the server-resolved actor and complete scope, including immutable sessionId and generation. Each read still authorizes inside the source SQL transaction.
- First request uses `min(requestedUntil,businessNow)`, discovers the published certificate with the request's absolute deadline/signal, checks coverage, then reads with its explicit publication pin.
- Continuation verifies the signed compact cursor to obtain its original effective cutoff. It then invokes the latest reader, which checks full scope, context, filters, pin, witness, expiry and current authorization. It never recalculates the cutoff using a later business clock or extends expiry.
- Every source operation receives the same absolute read control. The regular demo session resolver retains its existing 15-second Prisma transaction, 10-second statement and 5-second lock limits; call checks prevent late resolver results or clock mutation. This unit does not claim active cancellation for that separate Prisma path.
- The only API module importing the read-only subpath is `demo-commerce/database-persistent-read-ports.ts`. The architecture guard continues to deny every privileged source import elsewhere, and denies worker imports even in the composition module.
- A lazy Nest provider creates the reader only for an authorized enabled host path. Missing credentials fail closed; disabled demo mode does not require reader configuration at startup. Module shutdown awaits pool close. Connector disposal does not close the shared pool.
- Factory selection requires a server-owned source binder, builds `PersistentCommerceConnector` with the resolved fixed scope, and retains the current session/config/generation fingerprint and fresh permission checks.
- Each host open keeps its own `PersistentMockClock`. No shared clock, tenant/session scope or cursor registry is introduced. Existing pure offline connector tests remain useful, but the persistent runtime factory has no offline default.

## Independent changes

### 1. Read-only database facade

- [ ] Write fail-first tests for first-page coverage/pin, signed continuation cutoff, changed scope/context, unknown publication and propagated absolute control.
- [ ] Implement closed bounded request validation, fixed actor/scope binding, source reader lifecycle and private codec use.
- [ ] Export only read-only factory/types; verify the package root does not expose privileged APIs.
- [ ] Ensure latest source reads use #447 `SourceReadControl`/`readTransaction`; coordinate this dependency with its author.
- [ ] Run database build, focused unit and real PostgreSQL tests; commit separately.

### 2. API composition and boundary

- [ ] Write fail-first provider tests for server-only construction, lazy missing configuration, lifecycle and source error sanitization.
- [ ] Implement the unique API composition provider and preserve architecture import fences.
- [ ] Map source input/abort/deadline/integrity/storage failures to specific Connector failures without SQL or credentials in responses.
- [ ] Run boundary tests, API focused tests/typecheck/lint; commit separately.

### 3. Runtime factory and host

- [ ] Write fail-first factory/host tests proving persisted reads replace replay, without any fallback.
- [ ] Inject the source binder, select PersistentCommerceConnector and register the provider in DemoCommerceModule.
- [ ] Keep required sessionId, full fingerprint and per-call permission checks; update old factory fixture expectations for the additional post-I/O authorization.
- [ ] Verify independent clocks across open connectors and session replacement/reset/disconnect invalidation.
- [ ] Add a real PostgreSQL host read test for publication coverage, point/list DTOs, empty/quality/deleted states and restart-safe continuation after business clock advancement.
- [ ] Register any new real database suite in the required tenant gate; commit separately.

## Delivery

- [ ] Run focused API/DB tests, relevant real PostgreSQL tests, typecheck/lint/format, secret scan and diff checks.
- [ ] Rebase cleanly onto main when all dependencies merge; re-run affected checks.
- [ ] Obtain independent review, report remaining limitations, and coordinate the separate PR with the root agent.

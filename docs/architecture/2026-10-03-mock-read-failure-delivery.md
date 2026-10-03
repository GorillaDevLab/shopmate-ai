# Mock read failure injection delivery

Branch: `feat/mock-connector-failures`; base: `6bfb39ebc5545afe910e3344a98d3308d9b52e49`.

## Result

`failure-rules.ts` validates strict server-only arrays (maximum 32 unique IDs), normalizes
timestamps to UTC within Gregorian years 0001–9999, enforces bounded effects and windows, and
selects one active method rule by descending priority then ascending code-unit ID. Invalid
policy/time throws a sanitized `MockConnectorError(INVALID_RESPONSE)`.

`ReadFaultInjectingConnector` wraps the actual read-only CommerceConnector without adding
capabilities. All eight reads validate method inputs, use the existing real-time 30-second call
gate, obtain fresh explicit permission, and load host-owned policy through linked validated
options. It rechecks cancellation/deadline after authorization/loading and before delegation.
FAIL returns standard errors, TIMEOUT waits for gate deadline/abort, DELAY uses a cancellable
timer before actual base reads. All four writes and verification pass unchanged to the base
adapter for rejection, input validation and execution correlation.

## Evidence

- Engine RED: `pnpm --filter @shopmate/api exec vitest run src/integrations/mock/failure-rules.spec.ts`
  initially reported 38 failed assertions against a temporary null selector. GREEN: 38 passed.
- Wrapper RED: `pnpm --filter @shopmate/api exec vitest run src/integrations/mock/read-fault-connector.spec.ts`
  initially reported 25 failed / 9 passed against a temporary base passthrough constructor.
  24 failures demonstrated missing injection/access/timing/validation behavior. The remaining
  failure was receipt `receivedAt` differing across successive wall-time calls; freeze wall time
  for that comparison. GREEN: 34 passed. One further base write-boundary test brings wrapper
  coverage to 35.
- Final `pnpm --filter @shopmate/api exec vitest run src/integrations/mock`: **178 passed,
  10 files** (existing baseline 105 plus 73 new tests).
- `pnpm --filter @shopmate/api typecheck`: exit 0.
- `pnpm exec eslint apps/api/src/integrations/mock/failure-rules.ts apps/api/src/integrations/mock/failure-rules.spec.ts apps/api/src/integrations/mock/read-fault-connector.ts apps/api/src/integrations/mock/read-fault-connector.spec.ts --max-warnings=0`: exit 0.
- Prettier check on all four source/spec files and the plan: exit 0; `git diff --check` and
  staged diff checks: exit 0. TypeScript AST audit after formatting found maximum production
  function declaration lengths of 19 lines (engine) and 24 lines (wrapper).
- Tests exercise actual generated source reads, pinned paging/retries, source unchanged after
  injected recovery, fixed permissions, denial before policy loading, sanitized exceptions,
  late loader/access without base work, real-time timeout despite simulation advances, delay
  revocation/abort/timeout cleanup and unchanged unsupported writes/verification.

## Commits and integration

- `42db406` — `feat(mock): select deterministic read failure rules`
- `8f4f140` — `feat(mock): inject cancellable read failures into real connector`

No existing application/contracts/database/environment files were changed. Parent normalized
pre-existing checkout CRLF artifacts only when their normalized bytes matched HEAD exactly.
No push, PR, merge, HTTP registration, migration or deployment occurred in this unit. Parent
will integrate latest main, review the complete branch and run remaining delivery gates.

## Limits

Rules are loaded per read with no injection counter, persistent selection or rule administration.
The wrapper does not own a dispose method or base lifecycle. The host must make its explicit
access callback authoritative for session expiry/revocation and retain/dispose the base adapter;
base disposal is checked by delegated operations, whereas injected failures do not invoke the
base. Schema-invalid requests take precedence over injection; opaque cursor validity remains
the base pager's responsibility on delegated reads. No source platform outage is claimed. The
read-only constructor rejects writable or idempotent/precondition-capable bases; this work adds
no mutable writes, timeout-after-write, UNKNOWN receipts, synthetic execution IDs or proofs.

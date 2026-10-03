# Mock read failure injection plan

Base: `6bfb39ebc5545afe910e3344a98d3308d9b52e49`, branch `feat/mock-connector-failures`.

## Boundaries

Add server-only `failure-rules.ts` and specs, then `read-fault-connector.ts` and specs under
`apps/api/src/integrations/mock`. Preserve all existing source, contracts, database, modules,
configuration and environment files. The wrapper accepts an already bound read-only connector,
fresh read authorization, a business clock, and a host-owned rule loader.

## Implementation and validation

1. Test the strict bounded rule schema, UTC normalization, activation window and deterministic
   priority/ID winner. Implement a pure selector, then run focused tests, API typecheck and lint,
   format checks, and commit this independently.
2. Test the wrapper with the actual MockCommerceConnector: all eight reads, invalid inputs,
   permissions, injected standard failures, real cancellable delay/timeout, late loader/access,
   source/pagination stability and unchanged unsupported write/verification behavior. Implement
   the wrapper using executeMockRead and linked validated options; check timing again after
   asynchronous boundaries. Run focused and full mock tests, typecheck/lint/format and commit.
3. Record exact commands, red/green evidence, test counts and limitations in delivery notes and
   the parent report. Parent handles integration, broad review, CI and publishing.

## Limits

Single winner only; no random counters or state mutation. No HTTP registration, persistent rule
selection, failure metrics, disposal lifecycle ownership, real provider outages, write fault
injection, UNKNOWN receipts, migration or deployment. Delay and timeout use wall time; activation
uses BusinessClock. Invalid policy and clock details are sanitized as INVALID_RESPONSE.

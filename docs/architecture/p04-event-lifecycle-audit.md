# Event lifecycle and atomic audit component

P04-018 adds acknowledge, resolve and suppress through authenticated, current
OWNER/ADMIN/OPERATOR membership. ANALYST/VIEWER remain read-only. It grants no
commerce execution, proposal, approval or credential capability.

## Boundary and transaction

AuthGuard supplies the identity. TenantScopeService resolves the strict workspace
selection and store ownership; mutation bodies independently accept only a safe
expectedRevision and the operation's typed reason. The existing read-only
TenantContextGuard keeps rejecting mutation bodies.

A generic injected unit of work rechecks membership and ownership, then binds
query/detail and stateTransition to its transaction. The service checks the current
event, expected revision and legal transition, validates the returned record, and
appends the audit through AuditAppendPort using that same transaction. Only
successful completion commits both. Rejected audit, invalid returned records and
CAS failures abort the transaction. SUPPRESSED retains the event and evidence,
including SYNC_FAILURE visibility.

## Narrow audit contract addition

EVENT_STATE_CHANGE carries strict fromState, toState, reason, expectedRevision,
revision and the full immutable evidenceReference. Revisions are consecutive safe
positive integers; the transition matrix agrees with EventStateTransitionSchema.
The tenant envelope requires SUCCESS, a server USER actor, matching evidence
scope, the exact transition timestamp and an EVENT resource with the real event
ExternalId. Request/occurrence links remain; other legacy links are null.

The standalone legacy AuditResourceSchema and its TenantId restrictions remain
unchanged. Only the tenant envelope accepts the additional EVENT resource branch.
Append and persisted-entry schemas enforce the same conditional refinements.
Public root exports expose the existing audit port and schemas. Query event-type
limits track the enum size so all accepted families can be requested together.

## Proof and integration limit

Tests use a transaction-bound staged fixture: state mutation happens before an
audit failure, and committed state/evidence/audits remain unchanged after rollback.
Success records exactly one revision and one correlated audit. Fixtures cover
revoked membership, read-only roles, foreign scope, strict inputs and competing CAS.

This is component verification. Current TenantScopeService membership lookup uses
a separate transaction and alone cannot guarantee authorization at write time.
Production controller registration and actual transaction-safe repository/audit
writers remain P04-029/P09-004; real database concurrency/RLS proof remains
P04-030. No production migration, deployment or external provider call is included.

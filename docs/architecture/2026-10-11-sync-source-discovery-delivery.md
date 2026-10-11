# Bound publication discovery for synchronization

1. Scope: provide the publication discovery boundary needed by the P2 synchronization coordinator. The coordinator and independent sync process remain separate work.
2. API: `BoundSourceReadPort.findPublication(control)` returns the current verified publication or `null`, using the same restricted reader as entity reads.
3. Binding: the actor and complete source scope are captured and frozen at bind time. Discovery accepts no replacement identity, scope, generation or caller-selected target.
4. Authority: existing source control locking, current membership and connection-generation checks, and immutable publication certificate verification remain mandatory on every discovery.
5. Unknown state: an unpublished source returns `null`. A published empty snapshot returns its actual certificate and watermark; neither result claims successful business synchronization.
6. Controls: the existing closed control validator rejects proxy/accessor/extra fields before source I/O. The original caller deadline and AbortSignal are preserved within the existing thirty-second cap.
7. Lifetime: a closed factory rejects discovery and its other bound operations. Discovery exposes neither signing credentials nor source-worker mutations.
8. Compatibility: checkpoint recovery is extracted into a small private helper to keep bound-port construction within the function-size limit. Its scope, cutoff, original certificate and witness behavior are unchanged.
9. Unit verification: fail-first discovery tests establish fixed identity/scope, known versus unknown publication, closed-factory refusal and hostile-control rejection. All 159 database unit tests pass.
10. Restricted PostgreSQL verification: all five read-port integration tests pass, including current membership revocation, generation replacement, empty publication discovery, control-lock deadline/abort cancellation and pool reuse.
11. Build and quality: contracts, database and API builds, database lint, focused formatting and diff checks pass. Existing mandatory read-port CI coverage includes the extended integration cases.
12. Remaining acceptance: exact-head CI and independent review gate merge. Common-target coordination, durable sync execution, scenario outcomes and full-profile source-to-sync acceptance are still required before P2 completion. No deployment or remote migration is included.

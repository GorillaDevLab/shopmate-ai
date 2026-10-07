# Mock source publication ports delivery

## Goal

Complete the dedicated source worker's publication port and the source reader's certificate port after the reviewed lease and append ports. Publish an immutable physical accepted-prefix certificate and read it through current authorization.

## Why needed

A private checkpoint, including an unsealed frontier at the target, cannot establish reader coverage. Publication proves the dense accepted range and derived versions atomically, while explicit retry resolves an uncertain acknowledgment without rewriting history.

## Architecture impact

`@shopmate/database/mock-platform` retains private reader/worker pools and separate credentials. `publish` reuses the guarded READ COMMITTED worker transaction, CONTROL, login-bound grant and fresh access. Its PUBLISHED retry checks the same reference and exact expectations but ignores expiry because it performs no mutation. `findPublication` uses reader identity/current access and public certificate columns; it never resolves worker authority or applies a lease. PostgreSQL derives and verifies hashes; TypeScript validates closed input and stored DTOs. No normal database entry-point export was added.

## Files changed

Publication behavior lives in `publication.ts` and `publication-certificate.ts`, with dedicated factory/type additions. New official publication integration and input validation suites reuse the isolated port, corruption, suppression and deferred-failure fixtures. The tenant harness requires the official suite. The [operator guide](../operations/mock-source-generation.md) documents initialization, leases, append, publication and retry behavior.

## Database changes

This port step changes no schema, migration, grants, wall lease or payload cap. It consumes the previously reviewed `20261003070000_mock_source_publication` invoker guards, RLS and immutable tables. Future deployment requires the complete reviewed migration history through a separate provisioning identity; online migration and deployment remain deferred.

## Security

All seven scope coordinates and exact namespace spelling are bound to parameters. Inputs validate before acquiring a client. Mutations require current grant/owner/fence and a live lease, exact update count, final access/live checks and deferred COMMIT proof. Expected domain statuses surface only after full rollback; native failures are sanitized. Read-only retries preserve the certificate. Readers independently verify the certificate hash with legal PostgreSQL builtins and reject malformed DTOs without private-column access or additional privileges.

## Privacy/compliance

Only synthetic demo commerce snapshots and certificate metadata are involved. No real platform, Jev or LLM calls, external messaging, secrets or deployment credentials are added. Source events, checkpoints, receipts, failures and lease information are excluded from the reader DTO.

## Tests added

Two genuine restricted-login missing-method RED failures preceded production implementation; initial GREEN passed both. The complete official publication suite passed 33/33 with no failures, cancellations, skips or TODOs. It covers empty/nonempty publication, physical omissions, expiry-independent exact retry, changed expectations/reference, takeover, exact-count/deferred rollback, natural expiry, immutable recreation, legal reader privileges, malformed hash/DTO, own-certificate holes, merchant/scope recovery, reset/disconnect, frozen targets and exact Unicode namespaces. Two new pure cases cover invalid worker/reader inputs before an unreachable database; the database unit gate passed 100/100. Natural published expiry and deferred publication expiry used the unchanged thirty-second lease. Actual focused and serial gate evidence is recorded in the implementation report; the final tenant run follows this document commit.

## Manual verification

Use the dedicated restricted factories and an operator-approved synthetic session/grant. Initialize, claim, append and seal the intended snapshots; publish with the returned checkpoint hash and frozen base. Read through a currently authorized human merchant actor, recreate both clients and explicitly retry the same publication. Confirm the certificate is unchanged, staged prefixes remain hidden and reset/disconnect returns denied/null for the old scope. Restricted-login automated acceptance exercises these steps; no production database was used.

## Risks/limitations

The certificate proves physical completeness of accepted facts, not future generator causal or financial completeness. An intentionally empty prefix may seal. Published coverage is inclusive; a private unsealed frontier at the target may still accept more increasing tuples at that timestamp. Latest append receipt retry requires a current live lease and uses the new reference after takeover; published retry instead remains read-only after expiry. No abandoned revision or reset recovery mechanism is introduced. Existing bounds remain 100 events/2 MiB per chunk and 256 KiB per record with a thirty-second wall lease. The whole-job final proof makes no throughput claim. Same-clock commands still require future requestRevision/command receipts. No generator, paging/scan API, background job, UI, connector replacement or full P2 claim is delivered.

## Next step

Independent Task 3c review and root-owned whole-unit/security/repository gates, current-head remote CI and GitHub delivery remain required. The root separately owns the Task 3b mandatory acceptance and control-race timezone correction. No test result alone authorizes deployment or online migration.

## Commit messages

The port behavior, mandatory harness registration and delivery documentation are separate independently verified commits. Exact commit IDs, clean HEAD/tree and durable actual exit/count evidence are in `shopmate-source-publication-publish-ports-report.md`, the root handoff artifact.

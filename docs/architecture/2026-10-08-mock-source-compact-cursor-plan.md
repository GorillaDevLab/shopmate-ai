# Compact source cursor implementation plan

**Goal:** make latest-state reader cursors fit the Connector's 1024-character bound, survive process restarts, and pin first reads without writing cursor state.

**Architecture:** a domain-separated HMAC envelope carries fixed-size scope and query digests, the immutable publication identity, and an immutable EntityVersion event-sequence witness for the last scanned candidate. The reader resolves the witness by its scoped primary key inside the authorized transaction. Explicit first-page publication pins and structured entity-key filters extend the reader without changing Connector contracts.

**Tech stack:** TypeScript, node:crypto, parameterized pg SQL, real isolated PostgreSQL integration tests, existing Prisma migration history.

## Scope and invariants

- Work only in the existing tenant-foundation worktree, branch `feat/mock-source-compact-cursor`, initially based on #446 `a7ccc61`; rebase only after the dependency merges and the tree is clean.
- No adapter, factory, worker behavior, P3, cursor write table, deployment, push or PR.
- Full scope binds organization/workspace/store/session/connection/external store/generation. Cursor possession never establishes authorization.
- Sign the normalized latest request and an optional fixed-size host query digest. The host can bind method, original time window, limit and sorted SKU selection without placing those values in the cursor.
- Preserve the first cursor's wall-clock expiry across the chain. Retry of an identical cursor returns the identical next cursor.
- Candidate witness must be visible under the pinned publication's revision, highEventSeq and targetTime, including candidates with no version at the earlier requested until.
- Keep the 32-candidate budget and indexed key/time seeks; no history reconstruction or page-filling loops.
- Existing raw string entity-key filters remain exact. Structured keys use PostgreSQL's own `jsonb::text` canonicalization with bound JSON parameters.
- Until beyond the pinned published target still rejects; no silent horizon clipping or invented completeness.
- Functions remain under 40 lines; no any; secrets remain environment supplied.

## Task 1: fixed-size signed cursor codec

Files: modify `packages/database/src/mock-platform/latest-cursor.ts`; create internal `latest-cursor-codec.ts` and `test/mock-source-latest-cursor.test.mjs`; extend `latest-types.ts` for `contextHash?: string`.

- [ ] Write a unit test using all scope IDs at their maximum length and a long valid candidate entity key, expecting a cursor of at most 1024 characters and an exact certificate/witness roundtrip.
- [ ] Run `node --test packages/database/test/mock-source-latest-cursor.test.mjs`; record the expected RED for the missing witness codec.
- [ ] Define `LatestPosition` with `kind`, `entityKey`, `eventSeq` (the witness); define decoded `LatestCursorState` with `certificateHash`, `revision`, `highEventSeq`, `until`, `afterEventSeq`, `expiresAt`.
- [ ] Sign a closed compact envelope: codec version, 32-byte scope digest, 32-byte query digest, certificate hash, canonical UInt revision/high sequence/witness, UTC cutoff and fixed expiry. Reject extra fields, noncanonical base64url, unsafe integer/time/hash bounds, wrong scope/query/signature/domain and expired tokens.
- [ ] Verify hostile/tampered/maximum values, method context changes, wrong key, scope fields and expiry. Run database build and focused unit suite.
- [ ] Commit `feat(database): encode latest cursors as signed version witnesses` together with reader integration in Task 2 so no intermediate commit breaks real reads.

## Task 2: resolve witnesses in pinned latest reads

Files: modify `latest.ts` and `latest-types.ts`; extend `test/integration/mock-source-latest.test.mjs` and helpers.

- [ ] Write a real PostgreSQL regression for a future-only candidate empty page, restart the reader, resume, and assert preserved prior snapshot with a compact cursor.
- [ ] Record RED before replacing the legacy full-scope cursor.
- [ ] Select a witness eventSeq with each candidate key. Query witness by full scope/session/generation/eventSeq with explicit certificate revision/high-sequence/target limits before restoring its key position.
- [ ] Missing or mismatched witness fails `SOURCE_INTEGRITY`; never infer position from an unverified client key.
- [ ] Carry `state.expiresAt` into every subsequent token instead of refreshing the lifetime.
- [ ] Test same-token retries, all scope/context tampering, unpublished/staged witnesses, reader restart, no-gap pagination and expiry. Assert 32 candidates still bound the page and witness resolution adds only one indexed lookup per continuation.
- [ ] Run build, focused unit and real latest/scan integration suites, touched-file lint and format checks; commit Task 1+2.

## Task 3: explicit first-page pin

Files: modify `latest-types.ts`, `latest.ts`, and latest integration tests; extract bounded input validation if necessary.

- [ ] Add failing test: discover publication A, publish B with a new entity key, start read with `publication: { revision, highEventSeq, certificateHash }` from A; assert A's certificate, keys and termination.
- [ ] Define `PublicationPin` as a strict object with canonical UInt revision/highEventSeq and lowercase SHA-256 certificate hash. Select `readPublication` at the explicit revision and validate all three identities before reading.
- [ ] If both cursor and explicit pin exist they must match. A missing explicitly pinned certificate fails integrity rather than silently switching to the newest certificate.
- [ ] Test pin tampering, coverage cutoff, access revocation and reset; run focused tests; commit `feat(database): pin initial latest reads to explicit publications`.

## Task 4: structured exact key filters

Files: modify `latest-types.ts`, input validator and candidate SQL; extend latest integration tests.

- [ ] Add failing real test using `entityKey: ["PRODUCT", "quoted/non-ASCII ID"]` and assert it selects the exact record even though JSON.stringify differs from PostgreSQL jsonb::text spacing.
- [ ] Accept the existing `EntityKey` tuple union in addition to raw strings; validate tuple kind/length/IDs/date and explicit kind correlation before database access.
- [ ] Bind `JSON.stringify(tuple)` as a value and normalize only this known structured filter with `$value::jsonb::text`; preserve raw string behavior and C collation ordering.
- [ ] Sign structured filter/query context changes. Test STORE/PRODUCT/ORDER/REFUND and INVENTORY/MARKETING composite keys, absent exact keys and invalid tuples.
- [ ] Run focused tests, commit `feat(database): select latest states by structured entity keys`.

## Delivery verification

- [ ] Database package build/tests/lint/format, real latest + scan + compact/pin suites, Prisma empty deployment/drift, secret scan and diff check.
- [ ] Record codec worst-case character bound and EXPLAIN evidence; distinguish candidate count from physical B-tree/RLS certificate work.
- [ ] Rebase onto main after #446 merges, resolve only this unit's conflicts, and rerun affected checks.
- [ ] Return clean local commits and actual test results to the parent; no push, PR or deployment.

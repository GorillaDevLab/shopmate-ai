# P10-003 Transactional Enqueue Implementation Plan

> For agentic workers: use subagent-driven-development task-by-task. Coordinator verified actual eligibility2026-11-07: PR544/545 normalmerged, all6CI each green, Issue385liveReady/unassignedthenclaimed uniquelyhannnnnnnny. Newbase93754e8e4ff4e7b9a83f86049de23dac290bb3ac; branchfeat/p10-003-transactional-enqueue in p24-source-groups. Implement only card385; controller retains remote actions.

**Goal:** Implement #385's caller-transaction notification enqueue and stable replay, with atomic audit append.

**Architecture:** API leaf consumes persisted current PRIMARY authority, inserts normalized outbox columns, and appends audit on the identical client. The owner controls READ COMMITTED, trusted settings, lifetime, and rollback.

**Tech stack:** TypeScript, existing contracts/Zod, parameterized PostgreSQL through the structural audit client, Vitest. pg already belongs to @shopmate/database; add no driver dependency.

## Gate, ownership, sources

- [x] Coordinator verified PR #544/#545 normally merged with all six CI checks green, then claimed live Ready/unassigned #385 uniquely before dispatch. Implementation base is 93754e8e4ff4e7b9a83f86049de23dac290bb3ac; this worker performed no remote actions.
- [x] Own only apps/api/src/notifications/notification-enqueue.repository.ts and .spec.ts plus this plan. Three-hour bound; split excess work through coordinator.
- Inspected actual delivery.schema.ts, audit.schema.ts, audit-append.repository.ts, decision-run.repository.ts, event/decision/audit migrations and 20261103100000_notification_outbox/migration.sql. Database test mappers are examples, not production exports.
- No shared schemas/helpers/grants, pool, BEGIN/COMMIT/savepoint, provider/LLM/worker dispatch, deployment, or runtime oracle. Every function/callback/test <40 physical lines; no any; errors bounded and payload-free. Separate each independently verified change into a commit.

## Task 1: Trusted boundary and current authority

**Interfaces:** Export API-local BoundNotificationTransaction extending the actual BoundTenantTransaction with readonly binding: ConnectorBinding, connectionGeneration: number, auditRequestId: string. Implement TransactionalEnqueuePort<BoundNotificationTransaction>. Constructor options supply only trusted decisionKey(context: EvaluationContext): string and AuditAppendRepository (default real instance). The server constructs the handle; never deserialize it from a request. Reuse AuditTransactionClient.query(sql, parameters?: unknown[]) returning readonly Record<string,unknown>[] rows and rowCount:number|null; do not narrow it to rows-only.

- [x] RED: invalid/mismatched handle, malformed request, wrong clock, aborted signal and elapsed deadline issue no SQL.
- [x] Snapshot parsed request, scope, actor, binding, generation and auditRequestId before awaiting; retain original AbortSignal, client and bound isActive callback. Validate generation as nonnegative PostgreSQL integer, auditRequestId with TenantIdSchema. Scope's three identifiers must equal binding; request/context/run/evidence must match all five binding identifiers. Current USER actor must equal context.actor.userId and GUC app.user_id; retain trusted AuditActor for append. Initial authenticated USER mapping is supported. SERVICE/SYSTEM have no mapped human-principal field in this handle, so fail closed FORBIDDEN before SQL; do not assume their actorId is a membership identity. A later explicit trusted mapping can extend the local handle when a real server service owner needs it, without granting provider/body authority.
- [x] Check isActive and SECURITY_UTC clock/deadline before/after each SQL/audit await; never reuse after owner completion. NotificationEnqueueRequestSchema proves agreement only. Constructor key must derive trusted current policy from cloned context, validate ExternalId, and equal persisted run/claim keys; an echoed request key is not a policy.
- [x] Parameterized authorization first:

```sql
SELECT public.notification_scope_access($1,$2,$3,$4,$5,$6,$7,'ENQUEUE') AS allowed,
 current_setting('app.user_id',true) AS "currentUser";
```

Parameters: five binding fields in organization/workspace/store/connection/external-store order, recipient user, trusted generation. Require exactly one row, allowed=true and currentUser=context.actor.userId; USER actor equality also applies. Do not set GUCs from the request. Helper checks READ COMMITTED, actual SESSION_USER enqueuer membership, current writer/recipient membership, active connection/tenant and generation. OWNER/ADMIN inherited workspace access stays supported.

- [x] Lock and inspect current event using:

```sql
SELECT e.*,v.payload AS "evidencePayload"
FROM public.events e JOIN public.event_evidence v ON v.id=e."currentEvidenceId"
WHERE e."organizationId"=$1 AND e."workspaceId"=$2 AND e."storeId"=$3
 AND e."connectionId"=$4 AND e."externalStoreId"=$5 AND e.id=$6
FOR UPDATE OF e;
```

Compare revision/state/fingerprint/currentEvidenceId/currentEvidenceVersion/currentEvidenceHash plus schemaVersion,eventType,entityKind,entityId,severityFloor,rulePolicyVersion,baselineVersion to context. STORE event entityId is storeId (outbox STORE entityId is null). Parse EventEvidenceRecordSchema, compare complete genuine JSON payload to context, and check createEventFingerprint. Validate evidence row's scope/identity using explicit selected aliases, not payload alone.

- [x] Select r.* from decision_runs r JOIN decision_claims c ON c.id=r.claimId, using quoted mixed-case names. Predicate all five r/c binding fields, r.eventId=c.eventId=$6, c.winnerRunId=r.id=$7, c.eventRevision=$8, c.fingerprint=r.fingerprint=$9, c.evidenceId/Version/Hash=$10/$11/$12 and matching r fields, c.decisionKey=r.decisionKey=$13, c.claimToken=r.claimToken, c.winnerMode=r.mode='PRIMARY', c.winnerStatus=r.resultStatus='EVALUATED'. These chained equalities denote separate AND predicates, not literal SQL chains. Parameters derive from validated current context, routed run ID and trusted key. Select claim metadata with distinct aliases, bigint as text.
- [x] Reconstruct strict RoutedPrimaryDecisionRunSchema from physical providerKey/providerVersion/supportedInputVersions, result/effective, rulesetVersion,fallbackOf,overrideReason,latencyMs,createdAt,requestId and evidence. Check fingerprint, correlationId/result correlation, fallbackMode/fallbackStatus, claim envelope and complete normalized routed-run equality. Never authorize an arbitrary historical effective run. Claim expiresAt must be well formed, but already committed winners remain reusable after lease expiry as committed() specifies; uncommitted candidates and expired current control fail.
- [x] GREEN focused tests; commit trusted boundary/current-winner implementation.

P04-029 must enqueue after evaluate/commit has persisted appendStored and chooseWinner, still within the outer transaction. Its routing callback currently precedes those writes and must only compute labels.

## Task 2: Exact storage mapping and stable replay

- [x] RED: submitted SQL parameters reconstruct a real JSON-round-tripped fixture; all receipt states, corrupt rows, Unicode, bigint and timestamp boundaries fail/pass correctly.
- [x] Local toPendingColumns(intent,generation), toIntent(row), toReceipt(outbox,inbox) use actual columns. INSERT columns, in parameter order:

```text
intentId,organizationId,workspaceId,storeId,connectionId,externalStoreId,
recipientUserId,eventId,eventState,eventRevision,channel,decisionRunId,route,
eventType,severity,createdAt,notBefore,evidenceId,evidenceVersion,evidenceHash,
entityKind,entityId,definitionVersion,baselineVersion,connectionGeneration,nextAttemptAt
```

Set nextAttemptAt=notBefore; omit rowId,status,attempt,leaseToken,leaseUntil,deliveredAt so DB defaults apply. Enqueuer has no INSERT privilege on these omitted fields. Return explicit immutable and receipt columns, including generated rowId.

- [x] Natural identity is exactly (organizationId,workspaceId,storeId,connectionId,externalStoreId,eventId,eventState,eventRevision,recipientUserId,channel), all text identities C-collated. Authorized scoped lookup may return original immediately; otherwise INSERT ... ON CONFLICT ON CONSTRAINT notification_outbox_natural_key DO NOTHING RETURNING ... . Require rowCount/rows coherence: one means insertion; zero requires a separate scoped SELECT for the natural tuple, generation and authorization. Separate READ COMMITTED statement sees the concurrent winner. Never UPDATE replay payload.
- [x] If authorized natural-key row is absent, fail CONFLICT; intent-key 23505 also becomes bounded thrown CONFLICT because PostgreSQL aborted that transaction. No recovery SELECT in an aborted transaction. Do not expose constraint names or foreign IDs. Same revision/state/recipient preserves first ID, summary and schedule; severity-only changes do not create another intent. New routed revision may.
- [x] Rebuild one shared binding and evidence entity (STORE=null storage; SKU/CAMPAIGN/CONNECTION appropriate ID), schemaVersion=1 and regenerated createNotificationIntentKey; strictly parse NotificationIntentSchema. Private generation/rowId never enter public DTO.
- [x] Decode revision/attempt/latency bigint only from integers or canonical decimal strings/bigints within safe bounds; no boolean/null/empty-string Number coercion. Preserve opaque Unicode without trim/normalization; reject lone surrogates/NUL and invalid shared literals before pg substitution; enforce 256 UTF16 units/768 UTF8 bytes for outbox literals.
- [x] JSONB result/effective/evidence/supportedInputVersions must be genuine finite plain JSON, not JSON-looking strings, Dates, BigInts, undefined or cyclic objects. Validate first, normalize numeric -0 through JSON semantics, reparse and compare; never erase unsupported values via stringify.
- [x] Validate EventTimestampSchema before conversion; reject significant sub-ms digits. Canonical UTC input year 0000 maps explicitly to PostgreSQL year 0001 ... +00 BC; other years use UTC ISO. Read timestamps using explicit SQL (extract(epoch FROM column)*1000)::text aliases, validate integral safe milliseconds and year0000..9999 range, then new Date(milliseconds).toISOString(). Do not parse PG BC/offset strings with guessed Date casts; preserve instant, not original lexical fractional zeros.
- [x] Read an existing outbox row and its corresponding inbox projection in one parameterized SELECT/LEFT JOIN at a single statement snapshot (with explicit aliases and full scope), not two statements that can straddle a concurrent delivery commit. DELIVERED requires matching recipient_inbox projection: compare reconstructed intent/deliveredAt and outboxId; distinguish absent projection from present readAt=null. Other states reject stray projection. Newly inserted RETURNING rows are necessarily initial PENDING and need no separate inbox lookup. DeliveryReceiptSchema validates attempts, scheduling/lease/delivery/read consistency; UNKNOWN readState is UNKNOWN, otherwise READ only with confirmed delivered readAt.
- [x] GREEN; commit normalized storage and replay.

## Task 3: Audit and failure atomicity

- [x] RED: new insert calls real/injected AuditAppendRepository once on the identical base handle/client; replay never appends another audit. Audit/post-write decode/lifetime failure rejects, never resolves ok:false.
- [x] appendTenant event: scopeKind TENANT, trusted scope/actor, resource {type:NOTIFICATION,id:returned rowId}, result SUCCESS, occurredAt validated security time, sourceOccurredAt null; links requestId=trusted auditRequestId, occurrenceId=rowId; runId/evidenceId/actionId/revisionId/approvalId/executionId explicit null. Metadata only eventType NOTIFICATION_INTENT and {channel:IN_APP,deliveryStatus:PENDING}. Public ExternalIds are not coerced into audit TenantIds.
- [x] Reuse audit's client-keyed serialization; do not duplicate its chain locking/hash logic or copy its mutex without a demonstrated separate invariant. Outbox natural-key INSERT ON CONFLICT plus database uniqueness handle overlapping enqueue requests; audit serializes its own sequence across instances. Add a deterministic same-client overlapping enqueue regression requiring one durable natural-key intent and one first-insert audit, plus independent-client progress and lifetime/error controls. If a concrete remaining protocol race is demonstrated, coordinate a minimal shared mechanism instead of a second verbatim queue.
- [x] Pure pre-write validation/authorization denials may return declared INVALID_INPUT/FORBIDDEN/CONFLICT. SQL errors and every failure once INSERT is attempted reject a local bounded error; owner must roll back the entire unit. Owner also rolls back typed false outcomes. Never catch-and-return after successful writes.
- [x] GREEN; commit audit composition/failure propagation.

## Verification and host handoff

- [x] Run focused pnpm --filter @shopmate/api test -- src/notifications/notification-enqueue.repository.spec.ts, API typecheck/build, named-file ESLint/Prettier, secret:scan, existing function-span checker and git diff --check. Each change has meaningful RED/GREEN proof; no rerunning unrelated already-passing dependency suites.
- [x] Cover revoked actor/recipient, binding/generation/key/event/evidence/route changes, loser/SHADOW/candidate, committed expired-lease reuse, races scripted through actual SQL parameters, all mapper boundaries and owner rejection propagation. Fixtures remain synthetic; do not claim real UoW/race proof.
- [ ] Independent review, latest-head CI and normal merge remain delivery gates.

Host compatibility to confirm in P04-029/030: local extended handle carries authorized P3 source-bundle generation, full binding, and a real TenantId audit transport/UoW request ID. Public logical requestId may be ExternalId. Host supplies identical stable-key policy and current-user mapping. Existing notification/event/decision/audit capabilities must be composed on the owner connection; enqueuer alone cannot read event/decision tables, lock events, or append audit. Neither enqueuer nor event/decision grants provide PlatformConnection SELECT; private notification_connection_access/member_access are not directly executable. Use notification_scope_access, never invent grants. Real owner lifetime, privileges, rollback and concurrent PostgreSQL proofs belong to P04-029/030.


Coordinator pre-dispatch refinement2026-11-07: no second copied mutex is mandated without a demonstrated enqueue-specific invariant; exercise same-client natural-key+audit concurrency against actualSQLprotocol. Existing receipt/projection reads use one statement snapshot to avoid a valid worker delivery causing a split-read contradiction. These clarify routine implementation choices, not changed publiccontracts/permissions or dropped acceptance.

## Local implementation handoff (2026-11-09)

- Implemented the API-local trusted handle/options/error/repository exports without shared contract, database, grant, dependency or workflow changes.
- Final focused command passed 120 tests. API typecheck/build, named-file ESLint/Prettier, secret scan, function-span check (188 functions; maximum 39 lines) and diff check passed.
- PostgreSQL timestamp projections explicitly cast milliseconds to bigint before text, avoiding numeric fractional-scale assumptions. Year 0000 writes map to year 0001 BC.
- Audit uses the exact owner client and existing audit queue; its handle guard also checks original owner/request lifetime around every internal audit query. No second queue was added.
- Scripted clients cover normalized rows, one-snapshot receipts and overlapping enqueue protocols. They do not prove real host rollback, role composition, database locking or PostgreSQL races. P04-029/030 remain responsible for those proofs and for invoking enqueue only after the winner is persisted inside the outer transaction.
- Independent review, latest-head CI and normal merge remain coordinator-owned gates.

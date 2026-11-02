import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import {
  ConnectorBindingSchema,
  ConnectorTimestampSchema,
  DecisionControlSchema,
  DecisionCorrelationIdSchema,
  DecisionRunSchema,
  PrimaryDecisionRunSchema,
  EventDetailQuerySchema,
  EventHistoryQuerySchema,
  EventEvidenceRecordSchema,
  createEventFingerprint,
  sameDecisionEvidence,
  EvaluationContextSchema,
  EventTimestampSchema,
  ExternalIdSchema,
  TenantContextSchema,
} from "@shopmate/contracts";
import type {
  ConnectorBinding,
  DecisionControl,
  DecisionPortError,
  DecisionPortResult,
  DecisionRun,
  EventDetailQuery,
  EventHistoryQuery,
  EventPage,
  DecisionRunRepository,
  EvaluationContext,
  PrimaryDecisionRun,
  SecurityClock,
  TenantContext,
} from "@shopmate/contracts";
import type { EventTransactionClient } from "./event.repository.js";

type Row = Record<string, unknown>;
type Result<T> = DecisionPortResult<T>;
type Authorized = { readonly actor: TenantContext; readonly binding: ConnectorBinding };
export interface DecisionReadQuery extends EventDetailQuery {
  readonly decisionId: string | null;
}
export interface DecisionReadPort {
  /** Summary compatibility: at most 100 rows; larger histories use the paginated port. */
  readonly read: (query: DecisionReadQuery) => Promise<Result<readonly DecisionRun[]>>;
  readonly history: (query: EventHistoryQuery) => Promise<Result<EventPage<DecisionRun>>>;
}
export interface DecisionClaimRequest {
  readonly context: EvaluationContext;
  readonly decisionKey: string;
  readonly control: DecisionControl;
}
export interface DecisionCommitRequest extends DecisionClaimRequest {
  readonly commitToken: string;
  readonly runs: readonly PrimaryDecisionRun[];
}
export type DecisionClaim =
  | Readonly<{ status: "CLAIMED"; commitToken: string }>
  | Readonly<{ status: "COMMITTED"; run: PrimaryDecisionRun }>;
export interface DecisionEvaluationAuthority {
  /** Reuses only the persisted claim winner, preserving its original request/correlation metadata. */
  readonly claim: (request: DecisionClaimRequest) => Promise<Result<DecisionClaim>>;
  readonly commit: (
    request: DecisionCommitRequest,
    route: (run: PrimaryDecisionRun) => Promise<Result<PrimaryDecisionRun>>,
  ) => Promise<Result<PrimaryDecisionRun>>;
}
export interface DecisionRepositoryOptions {
  readonly actor: TenantContext;
  /** Already-open READ COMMITTED transaction; the host owns commit/rollback. */
  readonly client: EventTransactionClient;
  readonly clock: SecurityClock;
  /** Trusted server policy, identical to the evaluation host's stable-key policy. */
  readonly decisionKey: (context: EvaluationContext) => string;
}
type Operation = {
  auth: Authorized;
  reads: Promise<void>;
  open: boolean;
  readable: boolean;
  fatal?: unknown;
};
type Bound = DecisionRepositoryOptions & { operations: AsyncLocalStorage<Operation> };
type Lease = ReturnType<typeof decodeLease>;
type Identity = Pick<DecisionClaimRequest, "context" | "decisionKey">;
const keys = [
  "organizationId",
  "workspaceId",
  "storeId",
  "connectionId",
  "externalStoreId",
] as const;
const scoped = keys.map((key, i) => `"${key}"=$${i + 1}`).join(" AND ");
function failure<T>(code: DecisionPortError): Result<T> {
  return { ok: false, code };
}
function values(binding: ConnectorBinding): string[] {
  return keys.map((key) => binding[key]);
}
function object(value: unknown, names: readonly string[]): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Expected strict request object");
  const row = value as Row;
  if (Object.keys(row).length !== names.length || names.some((key) => !Object.hasOwn(row, key)))
    throw new TypeError("Unexpected request fields");
  return row;
}
function time(value: unknown): string {
  return EventTimestampSchema.parse(value instanceof Date ? value.toISOString() : value);
}
function integer(value: unknown): number {
  if (typeof value === "string" && !/^[1-9][0-9]*$/u.test(value))
    throw new TypeError("Invalid revision");
  const number = typeof value === "string" || typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1)
    throw new TypeError("Invalid revision");
  return number;
}
function binding(row: Row): ConnectorBinding {
  return ConnectorBindingSchema.parse(Object.fromEntries(keys.map((key) => [key, row[key]])));
}
function decodeLease(row: Row) {
  if (row.winnerMode !== "PRIMARY" || row.winnerStatus !== "EVALUATED")
    throw new TypeError("Invalid claim authority");
  const createdAt = storedTime(row.createdAt);
  const expiresAt = storedTime(row.expiresAt);
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw new TypeError("Invalid lease lifetime");
  return {
    id: DecisionCorrelationIdSchema.parse(row.id),
    binding: binding(row),
    eventId: ExternalIdSchema.parse(row.eventId),
    eventRevision: integer(row.eventRevision),
    fingerprint: ExternalIdSchema.parse(row.fingerprint),
    evidenceId: ExternalIdSchema.parse(row.evidenceId),
    evidenceVersion: ExternalIdSchema.parse(row.evidenceVersion),
    evidenceHash: ExternalIdSchema.parse(row.evidenceHash),
    decisionKey: ExternalIdSchema.parse(row.decisionKey),
    claimToken: ExternalIdSchema.parse(row.claimToken),
    winnerRunId: row.winnerRunId === null ? null : ExternalIdSchema.parse(row.winnerRunId),
    winnerMode: "PRIMARY",
    winnerStatus: "EVALUATED",
    createdAt,
    expiresAt,
  };
}
function matchesLease(lease: Lease, request: Identity): boolean {
  const { event, evidence } = request.context;
  return (
    isDeepStrictEqual(lease.binding, event.binding) &&
    lease.eventId === event.id &&
    lease.eventRevision === event.revision &&
    lease.fingerprint === event.fingerprint &&
    lease.evidenceId === evidence.reference.id &&
    lease.evidenceVersion === evidence.reference.version &&
    lease.evidenceHash === evidence.reference.hash &&
    lease.decisionKey === request.decisionKey
  );
}
function parseClaim(
  options: Bound,
  input: unknown,
  names = ["context", "decisionKey", "control"],
): DecisionClaimRequest {
  const row = object(input, names);
  const context = structuredClone(EvaluationContextSchema.parse(row.context));
  const decisionKey = ExternalIdSchema.parse(row.decisionKey);
  if (decisionKey !== ExternalIdSchema.parse(options.decisionKey(structuredClone(context))))
    throw new TypeError("Invalid trusted stable key");
  return { context, decisionKey, control: DecisionControlSchema.parse(row.control) };
}
function live(options: Bound, control: DecisionControl): boolean {
  return (
    !control.signal.aborted &&
    Date.parse(time(options.clock.now())) < Date.parse(control.deadlineAt)
  );
}
async function authorize(options: Bound, request: Authorized, write: boolean): Promise<boolean> {
  await options.client.query(
    `SELECT set_config('app.user_id',$1,true),set_config('app.organization_id',$2,true),
    set_config('app.workspace_id',$3,true),set_config('app.store_id',$4,true),
    set_config('app.connection_id',$5,true),set_config('app.external_store_id',$6,true),
    set_config('app.merchant_id',$7,true)`,
    [options.actor.userId, ...values(request.binding), options.actor.merchantId],
  );
  const result = await options.client.query(
    "SELECT public.event_scope_access($1,$2,$3,$4,$5,$6) AS allowed",
    [...values(request.binding), write],
  );
  return result.rows.length === 1 && result.rows[0]?.allowed === true;
}
async function recover(client: EventTransactionClient): Promise<void> {
  // If rollback itself fails, escape so the owner aborts the outer transaction.
  await client.query("ROLLBACK TO SAVEPOINT decision_repository_operation");
  await client.query("RELEASE SAVEPOINT decision_repository_operation");
}
function sqlFailure<T>(error: unknown): Result<T> {
  const code = error !== null && typeof error === "object" && "code" in error ? error.code : null;
  if (code === "42501") return failure("FORBIDDEN");
  if (code === "23503") return failure("VERSION_MISMATCH");
  if (code === "23505" || code === "23514" || code === "40001" || code === "40P01")
    return failure("CONFLICT");
  return failure("UNAVAILABLE");
}
async function execute<T>(
  options: Bound,
  auth: Authorized,
  write: boolean,
  work: () => Promise<Result<T>>,
): Promise<Result<T>> {
  if (!isDeepStrictEqual(auth.actor, options.actor)) return failure("FORBIDDEN");
  if (
    auth.binding.organizationId !== options.actor.organizationId ||
    auth.binding.workspaceId !== options.actor.workspaceId
  )
    return failure("SCOPE_MISMATCH");
  try {
    await options.client.query("SAVEPOINT decision_repository_operation");
  } catch {
    return failure("UNAVAILABLE");
  }
  let result: Result<T>;
  try {
    result = (await authorize(options, auth, write)) ? await work() : failure<T>("FORBIDDEN");
    if (result.ok) {
      await options.client.query("RELEASE SAVEPOINT decision_repository_operation");
      return result;
    }
  } catch (error) {
    const scope = options.operations.getStore();
    // A failed nested rollback leaves its savepoint live; only the owner can safely abort.
    if (scope && "fatal" in scope) throw scope.fatal;
    result = sqlFailure(error);
  }
  await recover(options.client);
  return result;
}
function runner(options: Bound) {
  let pending = Promise.resolve();
  return function run<T>(
    auth: Authorized,
    write: boolean,
    work: () => Promise<Result<T>>,
  ): Promise<Result<T>> {
    const active = options.operations.getStore();
    if (active) return nestedRead(options, active, auth, write, work);
    const scope: Operation = { auth, reads: Promise.resolve(), open: true, readable: false };
    const result = pending.then(() =>
      options.operations.run(scope, async () => {
        try {
          return await execute(options, auth, write, () => drained(options, work));
        } finally {
          scope.open = false;
        }
      }),
    );
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
function nestedRead<T>(
  options: Bound,
  scope: Operation,
  auth: Authorized,
  write: boolean,
  work: () => Promise<Result<T>>,
): Promise<Result<T>> {
  if (
    !scope.open ||
    !scope.readable ||
    write ||
    !isDeepStrictEqual(scope.auth.actor, auth.actor) ||
    !isDeepStrictEqual(scope.auth.binding, auth.binding)
  )
    return Promise.resolve(failure("CONFLICT"));
  const result = scope.reads.then(() => execute(options, auth, false, work));
  scope.reads = result.then(
    () => undefined,
    (error: unknown) => {
      scope.fatal = error;
    },
  );
  return result;
}
async function drained<T>(options: Bound, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } finally {
    await drainReads(options);
  }
}
async function current(options: Bound, request: Identity): Promise<Result<void>> {
  const { event } = request.context;
  const result = await options.client.query(
    `SELECT e.*,v.payload AS "evidencePayload" FROM public.events e
    JOIN public.event_evidence v ON v.id=e."currentEvidenceId"
    WHERE ${keys.map((key, i) => `e."${key}"=$${i + 1}`).join(" AND ")}
    /* decision:event */ AND e.id=$6 FOR UPDATE OF e`,
    [...values(event.binding), event.id],
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !row ||
    row.id !== event.id ||
    !isDeepStrictEqual(binding(row), event.binding)
  )
    return failure("SCOPE_MISMATCH");
  if (
    integer(row.revision) !== event.revision ||
    row.currentEvidenceId !== event.currentEvidence.id ||
    row.currentEvidenceVersion !== event.currentEvidence.version ||
    row.fingerprint !== event.fingerprint ||
    !currentPolicy(event, row)
  )
    return failure("VERSION_MISMATCH");
  if (row.currentEvidenceHash !== event.currentEvidence.hash) return failure("HASH_MISMATCH");
  return currentEvidence(request.context, row.evidencePayload);
}
async function findLease(options: Bound, request: Identity): Promise<Lease | null> {
  const { event, evidence } = request.context;
  const result = await options.client.query(
    `SELECT * FROM public.decision_claims WHERE ${scoped} /* decision:lease */
    AND "eventId"=$6 AND "evidenceId"=$7 AND "decisionKey"=$8 FOR UPDATE`,
    [...values(event.binding), event.id, evidence.reference.id, request.decisionKey],
  );
  if (result.rows.length > 1) throw new TypeError("Duplicate claim");
  return result.rows[0] ? decodeLease(result.rows[0]) : null;
}
async function claimStored(
  options: Bound,
  request: DecisionClaimRequest,
): Promise<Result<DecisionClaim>> {
  if (!live(options, request.control)) return failure("CONFLICT");
  const authorized = await current(options, request);
  if (!authorized.ok) return authorized;
  const prior = await findLease(options, request);
  if (prior) return committed(options, request, prior);
  const token = randomUUID();
  const ref = request.context.evidence.reference;
  const result = await options.client.query(
    "SELECT * FROM public.decision_claim($1,$2,$3,$4,$5,$6,$7)",
    [
      request.context.event.id,
      ref.id,
      ref.version,
      ref.hash,
      request.decisionKey,
      token,
      request.control.deadlineAt,
    ],
  );
  if (result.rows.length !== 1 || !result.rows[0]) throw new TypeError("Missing claim");
  const lease = decodeLease(result.rows[0]);
  if (!matchesLease(lease, request)) throw new TypeError("Corrupt claim binding");
  if (
    !live(options, request.control) ||
    lease.claimToken !== token ||
    lease.winnerRunId !== null ||
    Date.parse(lease.expiresAt) <= Date.parse(time(options.clock.now()))
  )
    return failure("CONFLICT");
  return { ok: true, value: { status: "CLAIMED", commitToken: token } };
}
/** Uses one caller-owned transaction. Routing may await same-scope reads on this instance.
 * Only the claim winner grants authority; arbitrary historical effective labels do not.
 * The host supplies its stable-key policy and composes actual audit/outbox work in P04-029.
 */
export function createDecisionRunRepository(
  options: DecisionRepositoryOptions,
): DecisionRunRepository & DecisionReadPort & DecisionEvaluationAuthority {
  const actor = structuredClone(TenantContextSchema.parse(options?.actor));
  if (
    typeof options?.client?.query !== "function" ||
    options?.clock?.timeDomain !== "SECURITY_UTC" ||
    typeof options.clock.now !== "function" ||
    typeof options.decisionKey !== "function"
  )
    throw new TypeError("Invalid transaction, security clock or stable-key policy");
  const bound: Bound = { ...options, actor, operations: new AsyncLocalStorage<Operation>() };
  const run = runner(bound);
  return Object.freeze({
    commit: commitPort(bound, run),
    append: appendPort(bound, run),
    read: readPort(bound, run),
    history: historyPort(bound, run),
    claim(input: DecisionClaimRequest): Promise<Result<DecisionClaim>> {
      let request: DecisionClaimRequest;
      try {
        request = parseClaim(bound, input);
      } catch {
        return Promise.resolve(failure("INVALID_INPUT"));
      }
      return run(
        { actor: request.context.actor, binding: request.context.event.binding },
        true,
        () => claimStored(bound, request),
      );
    },
  });
}

function runData(row: Row) {
  return {
    schemaVersion: row.schemaVersion,
    id: row.id,
    eventId: row.eventId,
    decisionKey: row.decisionKey,
    requestId: row.requestId,
    provider: {
      key: row.providerKey,
      version: row.providerVersion,
      supportedInputVersions: row.supportedInputVersions,
    },
    rulesetVersion: row.rulesetVersion,
    mode: row.mode,
    fallbackOf: row.fallbackOf,
    result: row.result,
    effective: row.effective,
    overrideReason: row.overrideReason,
    latencyMs: nonnegative(row.latencyMs),
    createdAt: time(row.createdAt),
  };
}
function nonnegative(value: unknown): number {
  if (value === 0 || value === "0" || value === 0n) return 0;
  return integer(value);
}
function decodeRun(row: Row): DecisionRun {
  const payload = row.evidencePayload as EvaluationContext["evidence"]["evidence"];
  const evidence = EventEvidenceRecordSchema.parse({
    reference: {
      schemaVersion: 1,
      id: row.evidenceId,
      version: row.evidenceVersion,
      hash: row.evidenceHash,
      binding: binding(row),
      eventType: payload.eventType,
      entity: payload.entity,
      definitionVersion: payload.definitionVersion,
      baselineVersion: payload.baselineVersion,
    },
    evidence: payload,
  });
  const run = DecisionRunSchema.parse({ ...runData(row), evidence: evidence.reference });
  const lease = decodeLease(row.lease as Row);
  if (
    row.claimId !== lease.id ||
    row.claimToken !== lease.claimToken ||
    !isDeepStrictEqual(run.evidence.binding, lease.binding) ||
    run.eventId !== lease.eventId ||
    run.decisionKey !== lease.decisionKey ||
    run.evidence.id !== lease.evidenceId ||
    run.evidence.version !== lease.evidenceVersion ||
    run.evidence.hash !== lease.evidenceHash ||
    row.fingerprint !== lease.fingerprint ||
    createEventFingerprint(payload) !== row.fingerprint ||
    DecisionCorrelationIdSchema.parse(row.correlationId).toLowerCase() !==
      run.result.correlationId.toLowerCase() ||
    row.resultStatus !== run.result.status ||
    row.fallbackMode !== (run.fallbackOf === null ? null : "PRIMARY") ||
    row.fallbackStatus !== (run.fallbackOf === null ? null : "UNAVAILABLE")
  )
    throw new TypeError("Corrupt stored decision envelope");
  return run;
}
type Anchor = { readonly at: string; readonly id: string };
async function selectRuns(
  options: Bound,
  query: DecisionReadQuery,
  limit: number,
  anchor: Anchor | null,
): Promise<readonly DecisionRun[]> {
  const scope = keys.map((key, i) => `r."${key}"=$${i + 1}`).join(" AND ");
  const result = await options.client.query(
    `SELECT r.*,v.payload AS "evidencePayload",to_jsonb(c) AS lease
    FROM public.decision_runs r JOIN public.event_evidence v ON v.id=r."evidenceId"
    JOIN public.decision_claims c ON c.id=r."claimId"
    WHERE ${scope} /* decision:runs */ AND r."eventId"=$6 AND ($7::text IS NULL OR r.id=$7)
    AND ($9::timestamptz IS NULL OR (r."createdAt",r.id COLLATE "C")<($9::timestamptz,$10::text COLLATE "C"))
    ORDER BY r."createdAt" DESC,r.id COLLATE "C" DESC LIMIT $8`,
    [
      ...values(query.binding),
      query.eventId,
      query.decisionId,
      limit,
      anchor?.at ?? null,
      anchor?.id ?? null,
    ],
  );
  if (result.rows.length > limit) throw new TypeError("Unbounded decision history");
  const runs = result.rows.map(decodeRun);
  checkRuns(runs, query, anchor);
  return runs;
}
function checkRuns(
  runs: readonly DecisionRun[],
  query: DecisionReadQuery,
  anchor: Anchor | null,
): void {
  if (new Set(runs.map((run) => run.id)).size !== runs.length)
    throw new TypeError("Duplicate decision history");
  for (const [i, run] of runs.entries()) {
    if (
      run.eventId !== query.eventId ||
      !isDeepStrictEqual(run.evidence.binding, query.binding) ||
      (query.decisionId !== null && run.id !== query.decisionId) ||
      (anchor !== null && compareAnchor({ at: run.createdAt, id: run.id }, anchor) >= 0)
    )
      throw new TypeError("Unscoped decision history");
    const previous = runs[i - 1];
    if (
      previous &&
      compareAnchor(
        { at: previous.createdAt, id: previous.id },
        { at: run.createdAt, id: run.id },
      ) <= 0
    )
      throw new TypeError("Unstable decision history");
  }
}
function compareAnchor(left: Anchor, right: Anchor): number {
  return (
    Date.parse(left.at) - Date.parse(right.at) ||
    Buffer.compare(Buffer.from(left.id), Buffer.from(right.id))
  );
}
async function runsStored(
  options: Bound,
  query: DecisionReadQuery,
): Promise<readonly DecisionRun[]> {
  const maximum = query.decisionId === null ? 100 : 1;
  const runs = await selectRuns(options, query, maximum + 1, null);
  if (runs.length > maximum) throw new TypeError("Decision summary bound exceeded; use history");
  return runs;
}
async function committed(
  options: Bound,
  request: DecisionClaimRequest,
  lease: Lease,
): Promise<Result<DecisionClaim>> {
  if (!matchesLease(lease, request)) throw new TypeError("Corrupt claim binding");
  if (lease.winnerRunId === null) return failure("CONFLICT");
  const runs = await runsStored(options, {
    actor: request.context.actor,
    binding: request.context.event.binding,
    eventId: request.context.event.id,
    decisionId: lease.winnerRunId,
  });
  const run = runs[0];
  if (
    !run ||
    run.mode !== "PRIMARY" ||
    run.result.status !== "EVALUATED" ||
    run.decisionKey !== request.decisionKey ||
    !sameDecisionEvidence(run.evidence, request.context.evidence.reference)
  )
    throw new TypeError("Invalid claim winner");
  return live(options, request.control)
    ? { ok: true, value: { status: "COMMITTED", run } }
    : failure("CONFLICT");
}
function runBinding(context: EvaluationContext, run: DecisionRun): DecisionPortError | null {
  if (
    !isDeepStrictEqual(run.evidence.binding, context.event.binding) ||
    run.eventId !== context.event.id
  )
    return "SCOPE_MISMATCH";
  if (run.evidence.hash !== context.evidence.reference.hash) return "HASH_MISMATCH";
  if (!sameDecisionEvidence(run.evidence, context.evidence.reference)) return "VERSION_MISMATCH";
  if (run.requestId !== context.requestId || run.result.correlationId !== context.correlationId)
    return "INVALID_INPUT";
  return null;
}
function runRow(context: EvaluationContext, run: DecisionRun, lease: Lease): Row {
  return {
    id: run.id,
    ...run.evidence.binding,
    claimId: lease.id,
    claimToken: lease.claimToken,
    eventId: run.eventId,
    fingerprint: context.event.fingerprint,
    evidenceId: run.evidence.id,
    evidenceVersion: run.evidence.version,
    evidenceHash: run.evidence.hash,
    decisionKey: run.decisionKey,
    schemaVersion: run.schemaVersion,
    requestId: run.requestId,
    correlationId: run.result.correlationId,
    providerKey: run.provider.key,
    providerVersion: run.provider.version,
    supportedInputVersions: run.provider.supportedInputVersions,
    rulesetVersion: run.rulesetVersion,
    mode: run.mode,
    fallbackOf: run.fallbackOf,
    fallbackMode: run.fallbackOf === null ? null : "PRIMARY",
    fallbackStatus: run.fallbackOf === null ? null : "UNAVAILABLE",
    resultStatus: run.result.status,
    result: run.result,
    effective: run.effective,
    overrideReason: run.overrideReason,
    latencyMs: run.latencyMs,
    createdAt: run.createdAt,
  };
}
const jsonColumns = new Set(["supportedInputVersions", "result", "effective", "suggested"]);
async function insert(
  options: Bound,
  table: "decision_runs" | "decision_records",
  row: Row,
): Promise<Row> {
  const names = Object.keys(row);
  const result = await options.client.query(
    `INSERT INTO public.${table} (${names.map((key) => `"${key}"`).join(",")})
    VALUES (${names.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`,
    names.map((key) =>
      jsonColumns.has(key) && row[key] !== null ? JSON.stringify(row[key]) : row[key],
    ),
  );
  if (result.rows.length !== 1 || !result.rows[0]) throw new TypeError("Missing immutable insert");
  return result.rows[0];
}
const projections = {
  SEVERITY: "severity",
  NOTIFICATION_ROUTE: "notificationRoute",
  LLM_ESCALATION: "llmEscalation",
  EVIDENCE_SUFFICIENCY: "evidenceSufficiency",
  ATTENTION_PRIORITY: "attentionPriority",
  REASON_CODES: "reasonCodes",
} as const;
async function project(options: Bound, run: DecisionRun): Promise<void> {
  if (run.result.status !== "EVALUATED") return;
  for (const [decisionType, key] of Object.entries(projections)) {
    const row = {
      runId: run.id,
      ...run.evidence.binding,
      decisionType,
      suggested: run.result.labels[key],
      effective: run.effective === null ? null : run.effective[key],
    };
    const stored = await insert(options, "decision_records", row);
    if (!isDeepStrictEqual(stored, row)) throw new TypeError("Corrupt projection");
  }
}
async function fallbackValid(
  options: Bound,
  context: EvaluationContext,
  run: DecisionRun,
): Promise<boolean> {
  if (run.fallbackOf === null) return true;
  const runs = await runsStored(options, {
    actor: context.actor,
    binding: context.event.binding,
    eventId: context.event.id,
    decisionId: run.fallbackOf,
  });
  const parent = runs[0];
  return (
    parent !== undefined &&
    parent.mode === "PRIMARY" &&
    parent.result.status === "UNAVAILABLE" &&
    parent.decisionKey === run.decisionKey &&
    parent.result.correlationId.toLowerCase() === run.result.correlationId.toLowerCase() &&
    sameDecisionEvidence(parent.evidence, run.evidence)
  );
}
async function appendStored(
  options: Bound,
  context: EvaluationContext,
  run: DecisionRun,
): Promise<Result<DecisionRun>> {
  const request = { context, decisionKey: run.decisionKey };
  const authorized = await current(options, request);
  if (!authorized.ok) return authorized;
  const lease = await findLease(options, request);
  if (!lease || !matchesLease(lease, request)) return failure("VERSION_MISMATCH");
  const prior = await runsStored(options, {
    actor: context.actor,
    binding: context.event.binding,
    eventId: context.event.id,
    decisionId: run.id,
  });
  if (prior[0])
    return isDeepStrictEqual(prior[0], run) ? { ok: true, value: prior[0] } : failure("CONFLICT");
  if (
    Date.parse(lease.expiresAt) <= Date.parse(time(options.clock.now())) ||
    (run.mode === "PRIMARY" && lease.winnerRunId !== null)
  )
    return failure("CONFLICT");
  if (!(await fallbackValid(options, context, run))) return failure("VERSION_MISMATCH");
  const row = await insert(options, "decision_runs", runRow(context, run, lease));
  const saved = decodeRun({
    ...row,
    evidencePayload: context.evidence.evidence,
    lease: { ...lease, ...lease.binding },
  });
  if (!isDeepStrictEqual(saved, run)) throw new TypeError("Changed immutable result");
  await project(options, saved);
  return { ok: true, value: saved };
}
function parseRead(input: DecisionReadQuery): DecisionReadQuery {
  const row = object(input, ["actor", "binding", "eventId", "decisionId"]);
  const detail = EventDetailQuerySchema.parse({
    actor: row.actor,
    binding: row.binding,
    eventId: row.eventId,
  });
  return structuredClone({
    ...detail,
    decisionId: row.decisionId === null ? null : ExternalIdSchema.parse(row.decisionId),
  });
}
function appendPort(
  options: Bound,
  run: ReturnType<typeof runner>,
): DecisionRunRepository["append"] {
  return (input, value) => {
    let context: EvaluationContext;
    let decision: DecisionRun;
    try {
      context = structuredClone(EvaluationContextSchema.parse(input));
      decision = normalizeRun(structuredClone(DecisionRunSchema.parse(value)));
      if (
        decision.decisionKey !==
        ExternalIdSchema.parse(options.decisionKey(structuredClone(context)))
      )
        return Promise.resolve(failure("INVALID_INPUT"));
    } catch {
      return Promise.resolve(failure("INVALID_INPUT"));
    }
    const code = runBinding(context, decision);
    if (code) return Promise.resolve(failure(code));
    return run({ actor: context.actor, binding: context.event.binding }, true, () =>
      appendStored(options, context, decision),
    );
  };
}
function readPort(options: Bound, run: ReturnType<typeof runner>): DecisionReadPort["read"] {
  return (input) => {
    let query: DecisionReadQuery;
    try {
      query = parseRead(input);
    } catch {
      return Promise.resolve(failure("INVALID_INPUT"));
    }
    return run(query, false, async () => ({ ok: true, value: await runsStored(options, query) }));
  };
}

function parseCommit(options: Bound, input: DecisionCommitRequest): DecisionCommitRequest {
  const request = parseClaim(options, input, [
    "context",
    "decisionKey",
    "control",
    "commitToken",
    "runs",
  ]);
  const row = input as unknown as Row;
  const commitToken = ExternalIdSchema.parse(row.commitToken);
  if (!Array.isArray(row.runs) || row.runs.length < 1 || row.runs.length > 2)
    throw new TypeError("Expected bounded primary attempt chain");
  const runs = row.runs.map((run: unknown) =>
    normalizeRun(structuredClone(PrimaryDecisionRunSchema.parse(run))),
  );
  for (const [i, run] of runs.entries()) {
    if (
      runBinding(request.context, run) ||
      run.decisionKey !== request.decisionKey ||
      run.fallbackOf !== (i === 0 ? null : runs[i - 1]?.id) ||
      (i > 0 &&
        (runs[i - 1]?.result.status !== "UNAVAILABLE" ||
          run.rulesetVersion !== runs[0]?.rulesetVersion))
    )
      throw new TypeError("Invalid primary failure/fallback chain");
  }
  if (new Set(runs.map((run) => run.id)).size !== runs.length)
    throw new TypeError("Duplicate attempt");
  return { ...request, commitToken, runs };
}
function commitPort(
  options: Bound,
  run: ReturnType<typeof runner>,
): DecisionEvaluationAuthority["commit"] {
  return (input, route) => {
    let request: DecisionCommitRequest;
    try {
      request = parseCommit(options, input);
      if (typeof route !== "function") throw new TypeError("Routing callback required");
    } catch {
      return Promise.resolve(failure("INVALID_INPUT"));
    }
    return run({ actor: request.context.actor, binding: request.context.event.binding }, true, () =>
      commitStored(options, request, route),
    );
  };
}
async function commitLease(options: Bound, request: DecisionCommitRequest): Promise<Result<Lease>> {
  if (!live(options, request.control)) return failure("CONFLICT");
  const result = await current(options, request);
  if (!result.ok) return result;
  const lease = await findLease(options, request);
  if (!lease || !matchesLease(lease, request)) return failure("VERSION_MISMATCH");
  if (lease.claimToken !== request.commitToken) return failure("CONFLICT");
  if (
    !live(options, request.control) ||
    (lease.winnerRunId === null &&
      Date.parse(lease.expiresAt) <= Date.parse(time(options.clock.now())))
  )
    return failure("CONFLICT");
  return { ok: true, value: lease };
}
function routeOutput(value: unknown, terminal: PrimaryDecisionRun): Result<PrimaryDecisionRun> {
  if (value === null || typeof value !== "object" || !("ok" in value))
    return failure("UNAVAILABLE");
  if (value.ok === false) {
    const row = object(value, ["ok", "code"]);
    const codes: readonly unknown[] = [
      "INVALID_INPUT",
      "FORBIDDEN",
      "SCOPE_MISMATCH",
      "VERSION_MISMATCH",
      "HASH_MISMATCH",
      "CONFLICT",
      "UNAVAILABLE",
    ];
    return codes.includes(row.code)
      ? failure(row.code as DecisionPortError)
      : failure("UNAVAILABLE");
  }
  const row = object(value, ["ok", "value"]);
  if (row.ok !== true) return failure("UNAVAILABLE");
  const parsed = PrimaryDecisionRunSchema.safeParse(row.value);
  if (!parsed.success) return failure("UNAVAILABLE");
  const expected = {
    ...terminal,
    effective: parsed.data.effective,
    overrideReason: parsed.data.overrideReason,
  };
  return isDeepStrictEqual(parsed.data, expected)
    ? { ok: true, value: parsed.data }
    : failure("UNAVAILABLE");
}
async function appendAttempts(
  options: Bound,
  context: EvaluationContext,
  runs: readonly PrimaryDecisionRun[],
): Promise<Result<void>> {
  for (const attempt of runs) {
    const result = await appendStored(options, context, attempt);
    if (!result.ok) return result;
  }
  return { ok: true, value: undefined };
}
async function chooseWinner(
  options: Bound,
  request: DecisionCommitRequest,
  lease: Lease,
  run: PrimaryDecisionRun,
): Promise<Result<PrimaryDecisionRun>> {
  if (!live(options, request.control)) return failure("CONFLICT");
  const result = await options.client.query("SELECT public.decision_commit($1,$2,$3) AS won", [
    lease.id,
    request.commitToken,
    run.id,
  ]);
  if (result.rows.length !== 1 || result.rows[0]?.won !== true || !live(options, request.control))
    return failure("CONFLICT");
  return { ok: true, value: run };
}
async function commitStored(
  options: Bound,
  request: DecisionCommitRequest,
  route: Parameters<DecisionEvaluationAuthority["commit"]>[1],
): Promise<Result<PrimaryDecisionRun>> {
  const found = await commitLease(options, request);
  if (!found.ok) return found;
  const lease = found.value;
  if (lease.winnerRunId !== null) {
    const prior = await committed(options, request, lease);
    return prior.ok && prior.value.status === "COMMITTED"
      ? { ok: true, value: prior.value.run }
      : failure("CONFLICT");
  }
  const terminal = request.runs.at(-1);
  if (!terminal) return failure("INVALID_INPUT");
  if (terminal.result.status === "UNAVAILABLE") {
    const saved = await appendAttempts(options, request.context, request.runs);
    return saved.ok && live(options, request.control)
      ? { ok: true, value: terminal }
      : saved.ok
        ? failure("CONFLICT")
        : saved;
  }
  return commitEvaluated(options, request, lease, terminal, route);
}
async function commitEvaluated(
  options: Bound,
  request: DecisionCommitRequest,
  lease: Lease,
  terminal: PrimaryDecisionRun,
  route: Parameters<DecisionEvaluationAuthority["commit"]>[1],
): Promise<Result<PrimaryDecisionRun>> {
  const failures = await appendAttempts(options, request.context, request.runs.slice(0, -1));
  if (!failures.ok) return failures;
  if (!live(options, request.control)) return failure("CONFLICT");
  const routed = routeOutput(
    await routeWithReads(options, () => route(structuredClone(terminal))),
    terminal,
  );
  if (!routed.ok) return routed;
  if (!live(options, request.control)) return failure("CONFLICT");
  if (
    !(await authorize(
      options,
      { actor: request.context.actor, binding: request.context.event.binding },
      true,
    ))
  )
    return failure("FORBIDDEN");
  const saved = await appendStored(options, request.context, routed.value);
  if (!saved.ok) return saved;
  return chooseWinner(options, request, lease, routed.value);
}

function normalizeRun<T extends DecisionRun>(run: T): T {
  return { ...run, createdAt: new Date(run.createdAt).toISOString() };
}

async function drainReads(options: Bound): Promise<void> {
  const scope = options.operations.getStore();
  if (!scope) return;
  let observed: Promise<void>;
  do {
    observed = scope.reads;
    await observed;
  } while (observed !== scope.reads);
  if ("fatal" in scope) throw scope.fatal;
}
async function routeWithReads<T>(options: Bound, work: () => Promise<T>): Promise<T> {
  const scope = options.operations.getStore();
  if (!scope) throw new TypeError("Missing transaction operation");
  scope.readable = true;
  try {
    return await drained(options, work);
  } finally {
    scope.readable = false;
  }
}

function storedTime(value: unknown): string {
  if (value instanceof Date) return time(value);
  const timestamp = ConnectorTimestampSchema.parse(value);
  // PostgreSQL to_jsonb(timestamptz) uses an explicit offset rather than the DTO's UTC spelling.
  time(timestamp.replace(/(?:Z|[+-]\d{2}:\d{2})$/u, "Z"));
  return new Date(timestamp).toISOString();
}

function currentEvidence(context: EvaluationContext, payload: unknown): Result<void> {
  const evidence = EventEvidenceRecordSchema.parse({
    reference: context.evidence.reference,
    evidence: payload,
  });
  return isDeepStrictEqual(evidence.evidence, context.evidence.evidence)
    ? { ok: true, value: undefined }
    : failure("HASH_MISMATCH");
}

function cursorScope(query: EventDetailQuery): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        query.actor.userId,
        query.actor.merchantId,
        ...values(query.binding),
        query.eventId,
      ]),
    )
    .digest("hex");
}
function parseAnchor(query: EventHistoryQuery): Anchor | null {
  if (query.cursor === null) return null;
  const row = object(JSON.parse(query.cursor) as unknown, ["version", "scope", "at", "id"]);
  if (row.version !== 1 || row.scope !== cursorScope(query))
    throw new TypeError("Invalid cursor scope");
  return { at: time(row.at), id: ExternalIdSchema.parse(row.id) };
}
function historyPort(options: Bound, run: ReturnType<typeof runner>): DecisionReadPort["history"] {
  return (input) => {
    let query: EventHistoryQuery;
    let anchor: Anchor | null;
    try {
      query = structuredClone(EventHistoryQuerySchema.parse(input));
      anchor = parseAnchor(query);
    } catch {
      return Promise.resolve(failure("INVALID_INPUT"));
    }
    return run(query, false, () => historyStored(options, query, anchor));
  };
}
async function historyStored(
  options: Bound,
  query: EventHistoryQuery,
  anchor: Anchor | null,
): Promise<Result<EventPage<DecisionRun>>> {
  const runs = await selectRuns(options, { ...query, decisionId: null }, query.limit + 1, anchor);
  const items = runs.slice(0, query.limit);
  const last = items.at(-1);
  // Raw JSON keeps maximum-width Unicode IDs below the shared 1024-unit cursor bound.
  const nextCursor =
    runs.length > query.limit && last
      ? JSON.stringify({
          version: 1,
          scope: cursorScope(query),
          at: last.createdAt,
          id: last.id,
        })
      : null;
  return { ok: true, value: { items, nextCursor } };
}

function currentPolicy(event: EvaluationContext["event"], row: Row): boolean {
  const expected: Row = {
    schemaVersion: event.schemaVersion,
    eventType: event.eventType,
    entityKind: event.entity.kind,
    entityId: eventEntityId(event),
    severityFloor: event.severityFloor,
    rulePolicyVersion: event.rulePolicyVersion,
    state: event.state,
    baselineVersion: event.currentEvidence.baselineVersion,
  };
  return Object.entries(expected).every(([key, value]) => row[key] === value);
}
function eventEntityId(event: EvaluationContext["event"]): string {
  switch (event.entity.kind) {
    case "SKU":
      return event.entity.externalSkuId;
    case "CAMPAIGN":
      return event.entity.externalCampaignId;
    case "CONNECTION":
      return event.entity.connectionId;
    case "STORE":
      return event.binding.storeId;
  }
}

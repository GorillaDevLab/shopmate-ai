import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  ConnectorBindingSchema,
  DecisionControlSchema,
  DecisionCorrelationIdSchema,
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
  EvaluationContext,
  PrimaryDecisionRun,
  SecurityClock,
  TenantContext,
} from "@shopmate/contracts";
import type { EventTransactionClient } from "./event.repository.js";

type Row = Record<string, unknown>;
type Result<T> = DecisionPortResult<T>;
type Authorized = { readonly actor: TenantContext; readonly binding: ConnectorBinding };
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
export interface DecisionRepositoryOptions {
  readonly actor: TenantContext;
  /** Already-open READ COMMITTED transaction; the host owns commit/rollback. */
  readonly client: EventTransactionClient;
  readonly clock: SecurityClock;
  /** Trusted server policy, identical to the evaluation host's stable-key policy. */
  readonly decisionKey: (context: EvaluationContext) => string;
}
type Bound = DecisionRepositoryOptions;
type Lease = ReturnType<typeof decodeLease>;
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
  const createdAt = time(row.createdAt);
  const expiresAt = time(row.expiresAt);
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
    createdAt,
    expiresAt,
  };
}
function matchesLease(lease: Lease, request: DecisionClaimRequest): boolean {
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
  try {
    const result = (await authorize(options, auth, write)) ? await work() : failure<T>("FORBIDDEN");
    if (!result.ok) {
      await recover(options.client);
      return result;
    }
    await options.client.query("RELEASE SAVEPOINT decision_repository_operation");
    return result;
  } catch (error) {
    await recover(options.client);
    return sqlFailure(error);
  }
}
function runner(options: Bound) {
  let pending = Promise.resolve();
  return function run<T>(
    auth: Authorized,
    write: boolean,
    work: () => Promise<Result<T>>,
  ): Promise<Result<T>> {
    const result = pending.then(() => execute(options, auth, write, work));
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
async function current(options: Bound, request: DecisionClaimRequest): Promise<Result<void>> {
  const { event } = request.context;
  const result = await options.client.query(
    `SELECT * FROM public.events WHERE ${scoped} /* decision:event */ AND id=$6 FOR UPDATE`,
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
    row.fingerprint !== event.fingerprint
  )
    return failure("VERSION_MISMATCH");
  if (row.currentEvidenceHash !== event.currentEvidence.hash) return failure("HASH_MISMATCH");
  return { ok: true, value: undefined };
}
async function findLease(options: Bound, request: DecisionClaimRequest): Promise<Lease | null> {
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
  if (prior) return failure("CONFLICT");
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
export function createDecisionRunRepository(options: DecisionRepositoryOptions) {
  const actor = structuredClone(TenantContextSchema.parse(options?.actor));
  if (
    typeof options?.client?.query !== "function" ||
    options?.clock?.timeDomain !== "SECURITY_UTC" ||
    typeof options.clock.now !== "function" ||
    typeof options.decisionKey !== "function"
  )
    throw new TypeError("Invalid transaction, security clock or stable-key policy");
  const bound = { ...options, actor };
  const run = runner(bound);
  return Object.freeze({
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

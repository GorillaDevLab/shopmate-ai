import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  AnonymousAuthSecurityEntrySchema,
  AuditActorSchema,
  AuditTenantScopeSchema,
  TenantAuditEntrySchema,
  TenantAuditEventSchema,
  TenantIdSchema,
  type AnonymousAuthSecurityEvent,
  type AnonymousAuthSecurityEntry,
  type AuditAppendPort,
  type TenantAuditEntry,
  type TenantAuditEvent,
} from "@shopmate/contracts";
import { AuditRedactor } from "./audit-redactor.js";
import { hashAuditEntry } from "./audit-hash.js";

type AuditTenantScope = Readonly<TenantAuditEvent["scope"]>;
type AuditActor = Readonly<TenantAuditEvent["actor"]>;
export interface AuditTransactionClient {
  readonly query: (
    sql: string,
    parameters?: unknown[],
  ) => Promise<{
    readonly rows: readonly Record<string, unknown>[];
    readonly rowCount: number | null;
  }>;
}
/** Server-owned handles only: the owner opens READ COMMITTED, binds authority and rolls back failures. */
export interface BoundTenantTransaction {
  readonly kind: "TENANT";
  readonly client: AuditTransactionClient;
  readonly scope: AuditTenantScope;
  readonly actor: AuditActor;
  readonly isActive: () => boolean;
}
export interface BoundAuthSecuritySink {
  readonly kind: "ANONYMOUS_AUTH_SECURITY";
  readonly client: AuditTransactionClient;
  readonly isActive: () => boolean;
}
type ErrorCode =
  | "INVALID_INPUT"
  | "INVALID_HANDLE"
  | "INVALID_ID"
  | "INVALID_STORAGE"
  | "OCCURRENCE_CONFLICT"
  | "SEQUENCE_EXHAUSTED"
  | "STORAGE_FAILED";
export class AuditAppendError extends Error {
  constructor(readonly code: ErrorCode) {
    super("Audit append failed");
    this.name = "AuditAppendError";
  }
}
type ClientBinding = Pick<BoundTenantTransaction, "client" | "isActive">;
// Coordinate complete protocols even when separate repositories share one transaction client.
// Gate promises only resolve: an append rejection cannot leak or poison the next transaction.
const appendTails = new WeakMap<AuditTransactionClient, Promise<void>>();

async function serializeTenant(
  binding: ClientBinding,
  operation: () => Promise<TenantAuditEntry>,
): Promise<TenantAuditEntry> {
  const previous = appendTails.get(binding.client);
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  appendTails.set(binding.client, tail);
  try {
    if (previous) await previous;
    active(binding);
    return await operation();
  } finally {
    release();
    if (appendTails.get(binding.client) === tail) appendTails.delete(binding.client);
  }
}

type Head = Readonly<{ sequence: number; entryHash: string | null }>;
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const headSchema = z.strictObject({ sequence: z.unknown(), entryHash: hash.nullable() });
const rowSchema = z.strictObject({
  auditId: TenantIdSchema,
  organizationId: TenantIdSchema,
  workspaceId: TenantIdSchema,
  storeId: TenantIdSchema,
  actorId: TenantIdSchema,
  actorKind: AuditActorSchema.shape.actorKind,
  requestId: TenantIdSchema,
  occurrenceId: TenantIdSchema,
  sequence: z.unknown(),
  prevHash: hash.nullable(),
  entryHash: hash,
  hashVersion: z.literal(1),
  redactionVersion: z.literal(1),
  payload: z.unknown(),
});
const columns = `"auditId","organizationId","workspaceId","storeId","actorId","actorKind",
  "requestId","occurrenceId",sequence,"prevHash","entryHash","hashVersion","redactionVersion",payload`;
const lookupSql = `SELECT ${columns}, public.audit_actor_access(audit_row) AS "actorAllowed"
  FROM public.audit_logs AS audit_row
  WHERE "organizationId"=$1 AND "workspaceId"=$2 AND "storeId"=$3
  AND "requestId"=$4 AND "occurrenceId"=$5`;
const insertSql = `INSERT INTO public.audit_logs (${columns})
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb) RETURNING ${columns}`;

function fail(code: ErrorCode): never {
  throw new AuditAppendError(code);
}
function active(binding: ClientBinding): void {
  try {
    if (binding.isActive() !== true) fail("INVALID_HANDLE");
  } catch {
    fail("INVALID_HANDLE");
  }
}
function bind(handle: ClientBinding): ClientBinding {
  if (
    !handle?.client ||
    typeof handle.client.query !== "function" ||
    typeof handle.isActive !== "function"
  )
    fail("INVALID_HANDLE");
  const binding = { client: handle.client, isActive: handle.isActive.bind(handle) };
  active(binding);
  return binding;
}
function tenantBinding(handle: BoundTenantTransaction, event: TenantAuditEvent): ClientBinding {
  try {
    if (handle?.kind !== "TENANT") fail("INVALID_HANDLE");
    const scope = AuditTenantScopeSchema.parse(handle.scope);
    const actor = AuditActorSchema.parse(handle.actor);
    if (!isDeepStrictEqual(scope, event.scope) || !isDeepStrictEqual(actor, event.actor))
      fail("INVALID_HANDLE");
    return bind(handle);
  } catch {
    return fail("INVALID_HANDLE");
  }
}
function tenantInput(input: unknown): TenantAuditEvent {
  try {
    const event = new AuditRedactor().redact(input).event;
    if (event.scopeKind !== "TENANT") return fail("INVALID_INPUT");
    // Normalize only validated plain JSON to the same numeric representation as jsonb and v1 hash.
    return TenantAuditEventSchema.parse(JSON.parse(JSON.stringify(event)));
  } catch {
    return fail("INVALID_INPUT");
  }
}
function anonymousInput(input: unknown): AnonymousAuthSecurityEvent {
  try {
    const event = new AuditRedactor().redact(input).event;
    return event.scopeKind === "ANONYMOUS_AUTH_SECURITY" ? event : fail("INVALID_INPUT");
  } catch {
    return fail("INVALID_INPUT");
  }
}
function anonymousBinding(handle: BoundAuthSecuritySink): ClientBinding {
  try {
    if (handle?.kind !== "ANONYMOUS_AUTH_SECURITY") fail("INVALID_HANDLE");
    return bind(handle);
  } catch {
    return fail("INVALID_HANDLE");
  }
}
async function query(binding: ClientBinding, sql: string, parameters: unknown[]) {
  active(binding);
  let result: Awaited<ReturnType<AuditTransactionClient["query"]>>;
  try {
    result = await binding.client.query(sql, parameters);
  } catch {
    return fail("STORAGE_FAILED");
  }
  active(binding);
  return result;
}
function decodeSequence(value: unknown): number {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0 ? value : fail("INVALID_STORAGE");
  if (typeof value !== "bigint" && typeof value !== "string") return fail("INVALID_STORAGE");
  const text = String(value);
  if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(text)) return fail("INVALID_STORAGE");
  const sequence = Number(text);
  return Number.isSafeInteger(sequence) ? sequence : fail("INVALID_STORAGE");
}
function scopeParameters(event: TenantAuditEvent): unknown[] {
  const { organizationId, workspaceId, storeId } = event.scope;
  return [organizationId, workspaceId, storeId];
}
async function lockHead(binding: ClientBinding, event: TenantAuditEvent): Promise<Head> {
  const result = await query(
    binding,
    "SELECT * FROM public.audit_chain_head($1,$2,$3)",
    scopeParameters(event),
  );
  if (result.rowCount !== 1 || result.rows.length !== 1) fail("INVALID_STORAGE");
  const parsed = headSchema.safeParse(result.rows[0]);
  if (!parsed.success) return fail("INVALID_STORAGE");
  const sequence = decodeSequence(parsed.data.sequence);
  if ((sequence === 0) !== (parsed.data.entryHash === null)) fail("INVALID_STORAGE");
  return { sequence, entryHash: parsed.data.entryHash };
}
function decodeRow(raw: unknown): TenantAuditEntry {
  try {
    const row = rowSchema.parse(raw);
    const payload = tenantInput(row.payload);
    const unsigned = {
      ...payload,
      auditId: row.auditId,
      sequence: decodeSequence(row.sequence),
      prevHash: row.prevHash,
      hashVersion: row.hashVersion,
    };
    const entry = TenantAuditEntrySchema.parse({ ...unsigned, entryHash: row.entryHash });
    if (
      !isDeepStrictEqual(scopeParameters(payload), [
        row.organizationId,
        row.workspaceId,
        row.storeId,
      ]) ||
      payload.actor.actorId !== row.actorId ||
      payload.actor.actorKind !== row.actorKind ||
      payload.links.requestId !== row.requestId ||
      payload.links.occurrenceId !== row.occurrenceId ||
      (entry.sequence === 1) !== (entry.prevHash === null) ||
      hashAuditEntry(unsigned) !== entry.entryHash
    )
      fail("INVALID_STORAGE");
    return entry;
  } catch {
    return fail("INVALID_STORAGE");
  }
}
async function replay(binding: ClientBinding, event: TenantAuditEvent, head: Head) {
  const parameters = [...scopeParameters(event), event.links.requestId, event.links.occurrenceId];
  const result = await query(binding, lookupSql, parameters);
  if (result.rowCount !== result.rows.length || result.rows.length > 1) fail("INVALID_STORAGE");
  if (!result.rows.length) return null;
  const { actorAllowed, ...persistedRow } = result.rows[0]!;
  // Scope access alone does not prove a service actor's grant survived rotation.
  if (actorAllowed !== true) fail("INVALID_HANDLE");
  const entry = decodeRow(persistedRow);
  if (
    entry.sequence > head.sequence ||
    (entry.sequence === head.sequence && entry.entryHash !== head.entryHash)
  )
    fail("INVALID_STORAGE");
  const { auditId, sequence, prevHash, entryHash, hashVersion, ...persisted } = entry;
  void [auditId, sequence, prevHash, entryHash, hashVersion];
  if (!isDeepStrictEqual(persisted, event)) fail("OCCURRENCE_CONFLICT");
  return entry;
}
function generateId(factory: () => string): string {
  try {
    return TenantIdSchema.parse(factory());
  } catch {
    return fail("INVALID_ID");
  }
}
function newEntry(event: TenantAuditEvent, head: Head, factory: () => string): TenantAuditEntry {
  if (head.sequence === Number.MAX_SAFE_INTEGER) fail("SEQUENCE_EXHAUSTED");
  const unsigned = {
    ...event,
    auditId: generateId(factory),
    sequence: head.sequence + 1,
    prevHash: head.entryHash,
    hashVersion: 1 as const,
  };
  return TenantAuditEntrySchema.parse({ ...unsigned, entryHash: hashAuditEntry(unsigned) });
}
function insertParameters(entry: TenantAuditEntry): unknown[] {
  const { auditId, sequence, prevHash, entryHash, hashVersion, ...payload } = entry;
  return [
    auditId,
    ...scopeParameters(payload),
    payload.actor.actorId,
    payload.actor.actorKind,
    payload.links.requestId,
    payload.links.occurrenceId,
    sequence,
    prevHash,
    entryHash,
    hashVersion,
    1,
    JSON.stringify(payload),
  ];
}
async function insert(binding: ClientBinding, intended: TenantAuditEntry) {
  const result = await query(binding, insertSql, insertParameters(intended));
  if (result.rowCount !== 1 || result.rows.length !== 1) fail("INVALID_STORAGE");
  const persisted = decodeRow(result.rows[0]);
  if (!isDeepStrictEqual(persisted, intended)) fail("INVALID_STORAGE");
  return persisted;
}

/** Never opens/commits a transaction. Any rejection requires owner rollback of the entire unit. */
export class AuditAppendRepository
  implements AuditAppendPort<BoundTenantTransaction, BoundAuthSecuritySink>
{
  constructor(private readonly auditId: () => string = randomUUID) {}

  async appendTenant(
    transaction: BoundTenantTransaction,
    input: TenantAuditEvent,
  ): Promise<TenantAuditEntry> {
    try {
      const event = tenantInput(input);
      const binding = tenantBinding(transaction, event);
      return await serializeTenant(binding, async () => {
        const head = await lockHead(binding, event);
        const existing = await replay(binding, event, head);
        if (existing) return existing;
        return insert(binding, newEntry(event, head, this.auditId));
      });
    } catch (error) {
      if (error instanceof AuditAppendError) throw error;
      return fail("STORAGE_FAILED");
    }
  }

  async appendAnonymousSecurity(
    securitySink: BoundAuthSecuritySink,
    input: AnonymousAuthSecurityEvent,
  ): Promise<AnonymousAuthSecurityEntry> {
    try {
      const event = anonymousInput(input);
      const binding = anonymousBinding(securitySink);
      const entry = AnonymousAuthSecurityEntrySchema.parse({
        ...event,
        auditId: generateId(this.auditId),
      });
      // This role has INSERT only; RETURNING would require SELECT privileges.
      const result = await query(
        binding,
        'INSERT INTO public.auth_security_events ("auditId",payload) VALUES ($1,$2::jsonb)',
        [entry.auditId, JSON.stringify(event)],
      );
      if (result.rowCount !== 1 || result.rows.length !== 0) fail("INVALID_STORAGE");
      return entry;
    } catch (error) {
      if (error instanceof AuditAppendError) throw error;
      return fail("STORAGE_FAILED");
    }
  }
}

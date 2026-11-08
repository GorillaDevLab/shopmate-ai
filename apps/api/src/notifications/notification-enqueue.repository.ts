import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import {
  AuditActorSchema,
  AuditTenantScopeSchema,
  ConnectorBindingSchema,
  EventTimestampSchema,
  EventEvidenceRecordSchema,
  EventRecordSchema,
  RoutedPrimaryDecisionRunSchema,
  DecisionCorrelationIdSchema,
  createEventFingerprint,
  ExternalIdSchema,
  NotificationEnqueueRequestSchema,
  NotificationIntentSchema,
  NotificationIntentIdentitySchema,
  createNotificationIntentKey,
  DeliveryReceiptSchema,
  TenantIdSchema,
  type ConnectorBinding,
  type EvaluationContext,
  type EventEvidenceReference,
  type NotificationEnqueueRequest,
  type NotificationIntent,
  type NotificationEnqueueOutcome,
  type EventEntity,
  type TenantAuditEvent,
  type NotificationPortError,
  type SecurityClock,
  type TransactionalEnqueuePort,
} from "@shopmate/contracts";
import {
  AuditAppendRepository,
  type BoundTenantTransaction,
} from "../audit/audit-append.repository.js";

/** Construct only on the server, using the owner's already-open transaction. */
export interface BoundNotificationTransaction extends BoundTenantTransaction {
  readonly binding: ConnectorBinding;
  readonly connectionGeneration: number;
  readonly auditRequestId: string;
}
export interface NotificationEnqueueOptions {
  readonly decisionKey: (context: EvaluationContext) => string;
  readonly audit?: AuditAppendRepository;
}
export class NotificationEnqueueError extends Error {
  constructor(readonly code: NotificationPortError) {
    super("Notification enqueue failed");
    this.name = "NotificationEnqueueError";
  }
}
type Operation = {
  transaction: BoundNotificationTransaction;
  request: NotificationEnqueueRequest;
  clock: SecurityClock;
  decisionKey: string;
  sqlStarted: boolean;
};
const bindingKeys = [
  "organizationId",
  "workspaceId",
  "storeId",
  "connectionId",
  "externalStoreId",
] as const;
function fail(code: NotificationPortError): never {
  throw new NotificationEnqueueError(code);
}
function values(binding: ConnectorBinding): string[] {
  return bindingKeys.map((key) => binding[key]);
}
function validUnicode(value: string): void {
  if (
    value.includes(String.fromCharCode(0)) ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
  )
    fail("INVALID_INPUT");
}
function plainJson(value: unknown, ancestors = new Set<object>()): void {
  if (typeof value === "string") return validUnicode(value);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || value === null || ancestors.has(value)) fail("INVALID_INPUT");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
    fail("INVALID_INPUT");
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    if (typeof key !== "string") fail("INVALID_INPUT");
    validUnicode(key);
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property?.enumerable || !("value" in property)) fail("INVALID_INPUT");
    plainJson(property.value, ancestors);
  }
  if (Array.isArray(value) && Object.keys(value).length !== value.length) fail("INVALID_INPUT");
  ancestors.delete(value);
}
function normalized<T>(value: T): T {
  plainJson(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
function preciseTime(value: unknown): string {
  const time = EventTimestampSchema.parse(value);
  const fraction = /\.(\d+)Z$/u.exec(time)?.[1] ?? "";
  if (/[1-9]/u.test(fraction.slice(3))) fail("INVALID_INPUT");
  return new Date(Date.parse(time)).toISOString();
}
function literal(value: string): void {
  ExternalIdSchema.parse(value);
  validUnicode(value);
  if (value.length > 256 || Buffer.byteLength(value, "utf8") > 768) fail("INVALID_INPUT");
}
function parseRequest(input: NotificationEnqueueRequest): NotificationEnqueueRequest {
  plainJson(input.intent);
  plainJson(input.decision.context);
  plainJson(input.decision.run);
  const parsed = NotificationEnqueueRequestSchema.parse(input);
  const request = {
    intent: normalized(parsed.intent),
    decision: {
      context: normalized(parsed.decision.context),
      run: normalized(parsed.decision.run),
      control: {
        ...parsed.decision.control,
        deadlineAt: preciseTime(parsed.decision.control.deadlineAt),
      },
    },
  };
  preciseTime(request.intent.createdAt);
  preciseTime(request.intent.notBefore);
  for (const value of [
    request.intent.id,
    request.intent.eventId,
    request.intent.decisionRunId,
    request.intent.evidence.id,
    request.intent.evidence.version,
    request.intent.evidence.hash,
    request.intent.evidence.definitionVersion,
    request.intent.recipient.binding.externalStoreId,
  ])
    literal(value);
  return request;
}
function bind(handle: BoundNotificationTransaction): BoundNotificationTransaction {
  if (
    handle?.kind !== "TENANT" ||
    typeof handle.client?.query !== "function" ||
    typeof handle.isActive !== "function"
  )
    fail("FORBIDDEN");
  const binding = ConnectorBindingSchema.parse(handle.binding);
  const scope = AuditTenantScopeSchema.parse(handle.scope);
  const actor = AuditActorSchema.parse(handle.actor);
  const generation = handle.connectionGeneration;
  if (!Number.isInteger(generation) || generation < 0 || generation > 2147483647) fail("FORBIDDEN");
  const expectedScope = {
    organizationId: binding.organizationId,
    workspaceId: binding.workspaceId,
    storeId: binding.storeId,
  };
  if (!isDeepStrictEqual(scope, expectedScope)) fail("FORBIDDEN");
  return {
    kind: "TENANT",
    client: handle.client,
    scope,
    actor,
    binding,
    connectionGeneration: generation,
    auditRequestId: TenantIdSchema.parse(handle.auditRequestId),
    isActive: handle.isActive.bind(handle),
  };
}
function live(operation: Operation): string {
  const { transaction, request, clock } = operation;
  if (transaction.isActive() !== true || request.decision.control.signal.aborted) fail("CONFLICT");
  if (clock.timeDomain !== "SECURITY_UTC") fail("INVALID_INPUT");
  const now = preciseTime(clock.now());
  if (Date.parse(now) >= Date.parse(request.decision.control.deadlineAt)) fail("CONFLICT");
  return now;
}
function prepare(
  handle: BoundNotificationTransaction,
  input: NotificationEnqueueRequest,
  clock: SecurityClock,
  options: NotificationEnqueueOptions,
): Operation {
  const request = parseRequest(input);
  const transaction = bind(handle);
  if (
    transaction.actor.actorKind !== "USER" ||
    transaction.actor.actorId !== request.decision.context.actor.userId ||
    !isDeepStrictEqual(transaction.binding, request.intent.recipient.binding)
  )
    fail("FORBIDDEN");
  const decisionKey = ExternalIdSchema.parse(
    options.decisionKey(structuredClone(request.decision.context)),
  );
  if (decisionKey !== request.decision.run.decisionKey) fail("FORBIDDEN");
  const operation = {
    transaction,
    request,
    clock: { timeDomain: clock.timeDomain, now: clock.now.bind(clock) },
    decisionKey,
    sqlStarted: false,
  };
  live(operation);
  return operation;
}
async function query(operation: Operation, sql: string, parameters: unknown[]) {
  live(operation);
  operation.sqlStarted = true;
  const result = await operation.transaction.client
    .query(sql, parameters)
    .catch((error: unknown) => {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "23505")
        fail("CONFLICT");
      return fail("UNAVAILABLE");
    });
  live(operation);
  if (result.rowCount !== result.rows.length || result.rows.length > 1) fail("UNAVAILABLE");
  return result.rows[0];
}
async function authorize(operation: Operation): Promise<boolean> {
  const { transaction, request } = operation;
  const row = await query(
    operation,
    `SELECT public.notification_scope_access($1,$2,$3,$4,$5,$6,$7,'ENQUEUE') AS allowed,
    current_setting('app.user_id',true) AS "currentUser"`,
    [
      ...values(transaction.binding),
      request.intent.recipient.userId,
      transaction.connectionGeneration,
    ],
  );
  return row?.allowed === true && row.currentUser === request.decision.context.actor.userId;
}

type Row = Record<string, unknown>;
const scoped = bindingKeys.map((key, index) => `e."${key}"=$${index + 1}`).join(" AND ");
function millisecondsSql(column: string, alias: string): string {
  // The integer cast makes PostgreSQL's numeric scale irrelevant to the strict decoder.
  return `(extract(epoch FROM ${column})*1000)::bigint::text AS "${alias}"`;
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" && typeof value !== "string" && typeof value !== "bigint")
    fail("UNAVAILABLE");
  if (typeof value !== "number" && !/^(?:0|-?[1-9][0-9]*)$/u.test(String(value)))
    fail("UNAVAILABLE");
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) fail("UNAVAILABLE");
  return number;
}
function storedTime(value: unknown): string {
  return new Date(integer(value, -62167219200000, 253402300799999)).toISOString();
}
function storedBinding(row: Row, prefix = ""): ConnectorBinding {
  return ConnectorBindingSchema.parse(
    Object.fromEntries(
      bindingKeys.map((key) => [
        key,
        row[prefix ? `${prefix}${key[0]!.toUpperCase()}${key.slice(1)}` : key],
      ]),
    ),
  );
}
function storedEntity(kind: unknown, id: unknown) {
  if (kind === "STORE" && id === null) return { kind: "STORE" } as const;
  if (kind === "SKU") return { kind, externalSkuId: ExternalIdSchema.parse(id) } as const;
  if (kind === "CAMPAIGN") return { kind, externalCampaignId: ExternalIdSchema.parse(id) } as const;
  if (kind === "CONNECTION") return { kind, connectionId: TenantIdSchema.parse(id) } as const;
  return fail("UNAVAILABLE");
}
const evidenceAliases = [
  "id",
  "eventId",
  ...bindingKeys,
  "schemaVersion",
  "evidenceRevision",
  "fingerprint",
  "version",
  "hash",
  "definitionVersion",
];
const eventSql = `SELECT e.*, ${evidenceAliases.map((key) => `v."${key}" AS "v${key[0]!.toUpperCase()}${key.slice(1)}"`).join(",")},
  v.payload AS "evidencePayload",${millisecondsSql('e."firstSeenAt"', "firstSeenAtMs")},
  ${millisecondsSql('e."lastSeenAt"', "lastSeenAtMs")}
  FROM public.events e JOIN public.event_evidence v ON v.id=e."currentEvidenceId"
  WHERE ${scoped} AND e.id=$6 FOR UPDATE OF e`;
function decodeEvent(row: Row, ref: EventEvidenceReference) {
  const entityId = row.entityKind === "STORE" && row.entityId === row.storeId ? null : row.entityId;
  return EventRecordSchema.parse({
    schemaVersion: row.schemaVersion,
    id: row.id,
    binding: storedBinding(row),
    eventType: row.eventType,
    entity: storedEntity(row.entityKind, entityId),
    fingerprint: row.fingerprint,
    severityFloor: row.severityFloor,
    rulePolicyVersion: row.rulePolicyVersion,
    state: row.state,
    revision: integer(row.revision, 1),
    firstSeenAt: storedTime(row.firstSeenAtMs),
    lastSeenAt: storedTime(row.lastSeenAtMs),
    currentEvidence: ref,
  });
}
function eventMatches(row: Row, operation: Operation): boolean {
  const { context } = operation.request.decision;
  const ref = context.evidence.reference;
  const event = decodeEvent(row, ref);
  const evidence = EventEvidenceRecordSchema.parse({
    reference: ref,
    evidence: normalized(row.evidencePayload),
  });
  const expected = {
    ...context.event,
    firstSeenAt: preciseTime(context.event.firstSeenAt),
    lastSeenAt: preciseTime(context.event.lastSeenAt),
  };
  return (
    isDeepStrictEqual(event, expected) &&
    isDeepStrictEqual(evidence, context.evidence) &&
    isDeepStrictEqual(storedBinding(row, "v"), operation.transaction.binding) &&
    row.currentEvidenceId === ref.id &&
    row.currentEvidenceVersion === ref.version &&
    row.currentEvidenceHash === ref.hash &&
    row.vId === ref.id &&
    row.vEventId === event.id &&
    row.vSchemaVersion === 1 &&
    integer(row.vEvidenceRevision, 1) <= event.revision &&
    row.vFingerprint === event.fingerprint &&
    row.vVersion === ref.version &&
    row.vHash === ref.hash &&
    row.vDefinitionVersion === ref.definitionVersion &&
    row.baselineVersion === ref.baselineVersion &&
    createEventFingerprint(ref) === event.fingerprint
  );
}
async function currentEvent(operation: Operation): Promise<boolean> {
  const row = await query(operation, eventSql, [
    ...values(operation.transaction.binding),
    operation.request.intent.eventId,
  ]);
  if (!row) return false;
  try {
    return eventMatches(row, operation);
  } catch {
    return false;
  }
}
const claimAliases = [
  ...bindingKeys,
  "eventId",
  "eventRevision",
  "fingerprint",
  "evidenceId",
  "evidenceVersion",
  "evidenceHash",
  "decisionKey",
  "claimToken",
  "winnerRunId",
  "winnerMode",
  "winnerStatus",
];
const runScope = bindingKeys
  .map((key, index) => `r."${key}"=$${index + 1} AND c."${key}"=$${index + 1}`)
  .join(" AND ");
const winnerSql = `SELECT r.*, ${claimAliases.map((key) => `c."${key}" AS "claim${key[0]!.toUpperCase()}${key.slice(1)}"`).join(",")},
  c.id AS "claimRowId", ${millisecondsSql('r."createdAt"', "createdAtMs")},
  ${millisecondsSql('c."createdAt"', "claimCreatedAtMs")},${millisecondsSql('c."expiresAt"', "claimExpiresAtMs")}
  FROM public.decision_runs r JOIN public.decision_claims c ON c.id=r."claimId"
  WHERE ${runScope} AND r."eventId"=$6 AND c."eventId"=$6 AND c."winnerRunId"=r.id AND r.id=$7
  AND c."eventRevision"=$8 AND c.fingerprint=$9 AND r.fingerprint=$9
  AND c."evidenceId"=$10 AND r."evidenceId"=$10 AND c."evidenceVersion"=$11 AND r."evidenceVersion"=$11
  AND c."evidenceHash"=$12 AND r."evidenceHash"=$12 AND c."decisionKey"=$13 AND r."decisionKey"=$13
  AND c."claimToken"=r."claimToken" AND c."winnerMode"='PRIMARY' AND r.mode='PRIMARY'
  AND c."winnerStatus"='EVALUATED' AND r."resultStatus"='EVALUATED'`;
function decodeRun(row: Row, operation: Operation) {
  const ref = operation.request.decision.context.evidence.reference;
  return RoutedPrimaryDecisionRunSchema.parse({
    schemaVersion: row.schemaVersion,
    id: row.id,
    eventId: row.eventId,
    decisionKey: row.decisionKey,
    requestId: row.requestId,
    evidence: ref,
    provider: {
      key: row.providerKey,
      version: row.providerVersion,
      supportedInputVersions: normalized(row.supportedInputVersions),
    },
    rulesetVersion: row.rulesetVersion,
    mode: row.mode,
    fallbackOf: row.fallbackOf,
    result: normalized(row.result),
    effective: normalized(row.effective),
    overrideReason: row.overrideReason,
    latencyMs: integer(row.latencyMs),
    createdAt: storedTime(row.createdAtMs),
  });
}
function winnerMatches(row: Row, operation: Operation): boolean {
  const { context, run } = operation.request.decision;
  const ref = context.evidence.reference;
  const persisted = decodeRun(row, operation);
  DecisionCorrelationIdSchema.parse(row.claimRowId);
  ExternalIdSchema.parse(row.claimToken);
  const common = {
    eventId: context.event.id,
    fingerprint: context.event.fingerprint,
    evidenceId: ref.id,
    evidenceVersion: ref.version,
    evidenceHash: ref.hash,
    decisionKey: operation.decisionKey,
  };
  return (
    isDeepStrictEqual(persisted, { ...run, createdAt: preciseTime(run.createdAt) }) &&
    isDeepStrictEqual(storedBinding(row), operation.transaction.binding) &&
    isDeepStrictEqual(storedBinding(row, "claim"), operation.transaction.binding) &&
    Object.entries(common).every(
      ([key, value]) =>
        row[key] === value && row[`claim${key[0]!.toUpperCase()}${key.slice(1)}`] === value,
    ) &&
    row.claimId === row.claimRowId &&
    row.claimToken === row.claimClaimToken &&
    row.claimWinnerRunId === run.id &&
    row.claimWinnerMode === "PRIMARY" &&
    row.claimWinnerStatus === "EVALUATED" &&
    integer(row.claimEventRevision, 1) === context.event.revision &&
    row.resultStatus === "EVALUATED" &&
    DecisionCorrelationIdSchema.parse(row.correlationId).toLowerCase() ===
      context.correlationId.toLowerCase() &&
    persisted.result.correlationId === context.correlationId &&
    Date.parse(storedTime(row.claimExpiresAtMs)) > Date.parse(storedTime(row.claimCreatedAtMs)) &&
    (row.fallbackOf === null
      ? row.fallbackMode === null && row.fallbackStatus === null
      : row.fallbackMode === "PRIMARY" && row.fallbackStatus === "UNAVAILABLE")
  );
}
async function currentWinner(operation: Operation): Promise<boolean> {
  const { context, run } = operation.request.decision;
  const ref = context.evidence.reference;
  const parameters = [
    ...values(operation.transaction.binding),
    context.event.id,
    run.id,
    context.event.revision,
    context.event.fingerprint,
    ref.id,
    ref.version,
    ref.hash,
    operation.decisionKey,
  ];
  const row = await query(operation, winnerSql, parameters);
  if (!row) return false;
  try {
    return winnerMatches(row, operation);
  } catch {
    return false;
  }
}

const immutableColumns = [
  "intentId",
  ...bindingKeys,
  "recipientUserId",
  "eventId",
  "eventState",
  "eventRevision",
  "channel",
  "decisionRunId",
  "route",
  "eventType",
  "severity",
  "createdAt",
  "notBefore",
  "evidenceId",
  "evidenceVersion",
  "evidenceHash",
  "entityKind",
  "entityId",
  "definitionVersion",
  "baselineVersion",
];
const insertColumns = [...immutableColumns, "connectionGeneration", "nextAttemptAt"];
const receiptColumns = [
  "rowId",
  "connectionGeneration",
  "status",
  "attempt",
  "leaseToken",
  "nextAttemptAt",
  "leaseUntil",
  "deliveredAt",
];
const timeColumns = new Set([
  "createdAt",
  "notBefore",
  "nextAttemptAt",
  "leaseUntil",
  "deliveredAt",
  "readAt",
]);
function projection(table: string, columns: readonly string[], prefix = ""): string {
  return columns
    .map((key) => {
      const alias = prefix ? `${prefix}${key[0]!.toUpperCase()}${key.slice(1)}` : key;
      return timeColumns.has(key)
        ? millisecondsSql(`${table}."${key}"`, `${alias}Ms`)
        : `${table}."${key}" AS "${alias}"`;
    })
    .join(",");
}
const returning = projection("o", [...immutableColumns, ...receiptColumns]);
const naturalColumns = [
  ...bindingKeys,
  "eventId",
  "eventState",
  "eventRevision",
  "recipientUserId",
  "channel",
];
const lookupSql = `SELECT ${returning},i."outboxId" AS "inboxOutboxId",
  ${projection("i", [...immutableColumns, "deliveredAt", "readAt"], "inbox")}
  FROM public.notification_outbox o LEFT JOIN public.recipient_inbox i ON i."outboxId"=o."rowId"
  AND ${[...bindingKeys, "recipientUserId"].map((key) => `i."${key}"=o."${key}"`).join(" AND ")}
  WHERE ${naturalColumns.map((key, index) => `o."${key}"=$${index + 1}`).join(" AND ")}
  AND o."connectionGeneration"=$11
  AND public.notification_scope_access($1,$2,$3,$4,$5,$9,$11,'ENQUEUE')`;
const insertSql = `INSERT INTO public.notification_outbox AS o (${insertColumns.map((key) => `"${key}"`).join(",")})
  VALUES (${insertColumns.map((_, index) => `$${index + 1}`).join(",")})
  ON CONFLICT ON CONSTRAINT notification_outbox_natural_key DO NOTHING RETURNING ${returning}`;
function entityId(entity: EventEntity): string | null {
  switch (entity.kind) {
    case "STORE":
      return null;
    case "SKU":
      return entity.externalSkuId;
    case "CAMPAIGN":
      return entity.externalCampaignId;
    case "CONNECTION":
      return entity.connectionId;
  }
}
function postgresTime(value: string): string {
  const canonical = preciseTime(value);
  return canonical.startsWith("0000-")
    ? canonical.replace(/^0000/u, "0001").replace("T", " ").replace("Z", "+00 BC")
    : canonical;
}
function toPendingColumns(intent: NotificationIntent, generation: number): unknown[] {
  const ref = intent.evidence;
  return [
    intent.id,
    ...values(intent.recipient.binding),
    intent.recipient.userId,
    intent.eventId,
    intent.eventState,
    intent.eventRevision,
    intent.channel,
    intent.decisionRunId,
    intent.route,
    intent.summary.eventType,
    intent.summary.severity,
    postgresTime(intent.createdAt),
    postgresTime(intent.notBefore),
    ref.id,
    ref.version,
    ref.hash,
    ref.entity.kind,
    entityId(ref.entity),
    ref.definitionVersion,
    ref.baselineVersion,
    generation,
    postgresTime(intent.notBefore),
  ];
}
function validateStoredLiterals(row: Row): void {
  for (const key of immutableColumns) {
    const value = row[key];
    if (typeof value === "string" && !timeColumns.has(key) && key !== "eventRevision")
      literal(value);
  }
}
function toIntent(row: Row): NotificationIntent {
  const binding = storedBinding(row);
  validateStoredLiterals(row);
  const identity = {
    recipient: { binding, userId: row.recipientUserId },
    eventId: row.eventId,
    eventState: row.eventState,
    eventRevision: integer(row.eventRevision, 1),
    channel: row.channel,
  };
  const intent = {
    schemaVersion: 1,
    id: row.intentId,
    ...identity,
    evidence: {
      schemaVersion: 1,
      id: row.evidenceId,
      version: row.evidenceVersion,
      hash: row.evidenceHash,
      binding,
      eventType: row.eventType,
      entity: storedEntity(row.entityKind, row.entityId),
      definitionVersion: row.definitionVersion,
      baselineVersion: row.baselineVersion,
    },
    decisionRunId: row.decisionRunId,
    route: row.route,
    createdAt: storedTime(row.createdAtMs),
    notBefore: storedTime(row.notBeforeMs),
    summary: { eventType: row.eventType, severity: row.severity },
  };
  const parsedIdentity = NotificationIntentIdentitySchema.parse(identity);
  return NotificationIntentSchema.parse({
    ...intent,
    dedupKey: createNotificationIntentKey(parsedIdentity),
  });
}
function nullableTime(value: unknown): string | null {
  return value === null ? null : storedTime(value);
}
function inboxRow(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([key]) => key.startsWith("inbox") && key !== "inboxOutboxId")
      .map(([key, value]) => [key[5]!.toLowerCase() + key.slice(6), value]),
  );
}
function projectionReadAt(row: Row, intent: NotificationIntent): string | null {
  const inboxPresent = row.inboxOutboxId !== null && row.inboxOutboxId !== undefined;
  const deliveredAt = nullableTime(row.deliveredAtMs);
  if (row.status === "DELIVERED") {
    if (
      !inboxPresent ||
      row.inboxOutboxId !== row.rowId ||
      !isDeepStrictEqual(toIntent(inboxRow(row)), intent) ||
      nullableTime(row.inboxDeliveredAtMs) !== deliveredAt
    )
      fail("UNAVAILABLE");
  } else if (inboxPresent) fail("UNAVAILABLE");
  return row.status === "DELIVERED" ? nullableTime(row.inboxReadAtMs) : null;
}
function toReceipt(row: Row, operation: Operation, inserted = false) {
  DecisionCorrelationIdSchema.parse(row.rowId);
  if (
    integer(row.connectionGeneration, 0, 2147483647) !== operation.transaction.connectionGeneration
  )
    fail("CONFLICT");
  const intent = toIntent(row);
  if (!inserted && row.inboxOutboxId === undefined) fail("UNAVAILABLE");
  if (intent.dedupKey !== operation.request.intent.dedupKey) fail("CONFLICT");
  const readAt = projectionReadAt(row, intent);
  const receipt = DeliveryReceiptSchema.parse({
    schemaVersion: 1,
    intent,
    status: row.status,
    attempt: integer(row.attempt),
    nextAttemptAt: nullableTime(row.nextAttemptAtMs),
    leaseToken: row.leaseToken,
    leaseUntil: nullableTime(row.leaseUntilMs),
    deliveredAt: nullableTime(row.deliveredAtMs),
    readAt,
    readState: row.status === "UNKNOWN" ? "UNKNOWN" : readAt === null ? "UNREAD" : "READ",
  });
  if (
    inserted &&
    (receipt.status !== "PENDING" ||
      receipt.attempt !== 0 ||
      receipt.nextAttemptAt !== receipt.intent.notBefore)
  )
    fail("UNAVAILABLE");
  return receipt;
}
function insertedIntentMatches(intent: NotificationIntent, operation: Operation): void {
  const expected = operation.request.intent;
  if (
    !isDeepStrictEqual(intent, {
      ...expected,
      createdAt: preciseTime(expected.createdAt),
      notBefore: preciseTime(expected.notBefore),
    })
  )
    fail("UNAVAILABLE");
}
async function lookup(operation: Operation) {
  const intent = operation.request.intent;
  return query(operation, lookupSql, [
    ...values(operation.transaction.binding),
    intent.eventId,
    intent.eventState,
    intent.eventRevision,
    intent.recipient.userId,
    intent.channel,
    operation.transaction.connectionGeneration,
  ]);
}
function auditEvent(operation: Operation, rowId: string): TenantAuditEvent {
  const transaction = operation.transaction;
  return {
    scopeKind: "TENANT",
    scope: transaction.scope,
    actor: transaction.actor,
    resource: { type: "NOTIFICATION", id: rowId },
    result: "SUCCESS",
    occurredAt: live(operation),
    sourceOccurredAt: null,
    links: {
      requestId: transaction.auditRequestId,
      occurrenceId: rowId,
      runId: null,
      evidenceId: null,
      actionId: null,
      revisionId: null,
      approvalId: null,
      executionId: null,
    },
    event: {
      eventType: "NOTIFICATION_INTENT",
      redactedMetadata: { channel: "IN_APP", deliveryStatus: "PENDING" },
    },
  };
}
async function store(
  operation: Operation,
  audit: AuditAppendRepository,
): Promise<NotificationEnqueueOutcome> {
  const existing = await lookup(operation);
  if (existing) return { outcome: "DEDUPLICATED", receipt: toReceipt(existing, operation) };
  const row = await query(
    operation,
    insertSql,
    toPendingColumns(operation.request.intent, operation.transaction.connectionGeneration),
  );
  if (!row) {
    const winner = await lookup(operation);
    if (!winner) fail("CONFLICT");
    return { outcome: "DEDUPLICATED", receipt: toReceipt(winner, operation) };
  }
  const receipt = toReceipt(row, operation, true);
  insertedIntentMatches(receipt.intent, operation);
  // Audit retains the same client/queue while its own query guards also enforce request lifetime.
  const auditHandle = {
    ...operation.transaction,
    isActive: () => {
      live(operation);
      return true;
    },
  };
  await audit.appendTenant(auditHandle, auditEvent(operation, TenantIdSchema.parse(row.rowId)));
  live(operation);
  return { outcome: "ENQUEUED", receipt };
}

/** Never owns transaction boundaries. The owner must roll back typed denials and rejections. */
export class NotificationEnqueueRepository
  implements TransactionalEnqueuePort<BoundNotificationTransaction>
{
  private readonly audit: AuditAppendRepository;
  constructor(private readonly options: NotificationEnqueueOptions) {
    this.audit = options.audit ?? new AuditAppendRepository();
  }

  readonly enqueue: TransactionalEnqueuePort<BoundNotificationTransaction>["enqueue"] = async (
    handle,
    input,
    clock,
  ) => {
    let operation: Operation | undefined;
    try {
      operation = prepare(handle, input, clock, this.options);
      if (!(await authorize(operation))) return { ok: false, code: "FORBIDDEN" };
      if (!(await currentEvent(operation)) || !(await currentWinner(operation)))
        return { ok: false, code: "CONFLICT" };
      return { ok: true, value: await store(operation, this.audit) };
    } catch (error) {
      const code = error instanceof NotificationEnqueueError ? error.code : "INVALID_INPUT";
      if (operation?.sqlStarted)
        throw new NotificationEnqueueError(
          error instanceof NotificationEnqueueError ? code : "UNAVAILABLE",
        );
      return { ok: false, code };
    }
  };
}

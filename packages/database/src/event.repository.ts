import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  createEventFingerprint,
  EventAppendEvidenceRequestSchema,
  EventCurrentQuerySchema,
  EventDetailQuerySchema,
  EventEvidenceQuerySchema,
  EventEvidenceRecordSchema,
  EventHistoryQuerySchema,
  EventListQuerySchema,
  EventRecordSchema,
  EventStateTransitionSchema,
  EventTimestampSchema,
  ExternalIdSchema,
  TenantContextSchema,
} from "@shopmate/contracts";
import type {
  ConnectorBinding,
  EventAppendEvidenceRequest,
  EventCurrentQuery,
  EventDetailQuery,
  EventEvidenceQuery,
  EventEvidenceRecord,
  EventEvidenceReference,
  EventHistoryQuery,
  EventListQuery,
  EventPage,
  EventQueryPort,
  EventRecord,
  EventRepository,
  EventResult,
  EventStateTransition,
  EventErrorCode,
  EventEvidenceV1,
  EventSourceReference,
  EventEntity,
  TenantContext,
} from "@shopmate/contracts";

type Row = Record<string, unknown>;
export interface EventTransactionClient {
  readonly query: (sql: string, parameters?: unknown[]) => Promise<{ rows: Row[] }>;
}
/** The host supplies an already-open READ COMMITTED transaction and owns its final outcome. */
export interface EventRepositoryOptions {
  readonly actor: TenantContext;
  readonly client: EventTransactionClient;
  /** Host-owned observation clock; immutable evidence.observedAt remains hash-bound. */
  readonly now: () => string;
}
type Authorized = { readonly actor: TenantContext; readonly binding: ConnectorBinding };
type Parser<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };
const keys = [
  "organizationId",
  "workspaceId",
  "storeId",
  "connectionId",
  "externalStoreId",
] as const;
const scoped = keys.map((key, i) => `"${key}"=$${i + 1}`).join(" AND ");
const eventScope = keys.map((key, i) => `e."${key}"=$${i + 1}`).join(" AND ");
const eventSelect = `SELECT e.*, v.payload AS "currentPayload" FROM public.events e
  JOIN public.event_evidence v ON v.id=e."currentEvidenceId" WHERE ${eventScope}`;
const timestampKeys = new Set([
  "periodStart",
  "periodEnd",
  "observedAt",
  "sourceWatermark",
  "lastSuccessAt",
  "inventoryObservedAt",
  "listedAt",
  "priceEffectiveAt",
  "observedThrough",
]);
function failure<T>(code: EventErrorCode): EventResult<T> {
  return { ok: false, error: { code, evidenceIds: [] } };
}
function values(binding: ConnectorBinding): string[] {
  return keys.map((key) => binding[key]);
}
function canonical(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => canonical(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, item]) => [name, canonical(item, name)]),
    );
  }
  return typeof value === "string" &&
    timestampKeys.has(key) &&
    EventTimestampSchema.safeParse(value).success
    ? new Date(value).toISOString()
    : value;
}
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
function time(value: unknown): string {
  return EventTimestampSchema.parse(value instanceof Date ? value.toISOString() : value);
}
function integer(value: unknown): number {
  const number = typeof value === "bigint" || typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1)
    throw new TypeError("Invalid event revision");
  return number;
}
function rowBinding(row: Row): ConnectorBinding {
  return Object.fromEntries(keys.map((key) => [key, row[key]])) as ConnectorBinding;
}
function entityId(entity: EventEntity, binding: ConnectorBinding): string {
  switch (entity.kind) {
    case "SKU":
      return entity.externalSkuId;
    case "CAMPAIGN":
      return entity.externalCampaignId;
    case "CONNECTION":
      return entity.connectionId;
    case "STORE":
      return binding.storeId;
  }
}
function reference(row: Row, evidence: EventEvidenceV1): EventEvidenceReference {
  return {
    schemaVersion: 1,
    id: String(row.id),
    version: String(row.version),
    hash: String(row.hash),
    binding: evidence.binding,
    eventType: evidence.eventType,
    entity: evidence.entity,
    definitionVersion: evidence.definitionVersion,
    baselineVersion: evidence.baselineVersion,
  };
}
function decodeEvidence(row: Row): EventEvidenceRecord {
  const parsed = EventEvidenceRecordSchema.parse({
    reference: reference(row, row.payload as EventEvidenceV1),
    evidence: row.payload,
  });
  const evidence = parsed.evidence;
  const expected = {
    ...evidence.binding,
    schemaVersion: evidence.schemaVersion,
    fingerprint: createEventFingerprint(evidence),
    definitionVersion: evidence.definitionVersion,
    periodStart: evidence.periodStart,
    periodEnd: evidence.periodEnd,
    observedAt: evidence.observedAt,
    sourceWatermark: evidence.sourceWatermark,
    timezone: evidence.timezone,
    currency: evidence.currency,
    dataStatus: evidence.dataStatus,
    sampleSize: evidence.sampleSize,
    coverageBasisPoints: evidence.coverageBasisPoints,
    issues: evidence.issues,
  };
  const actual = Object.fromEntries(
    Object.keys(expected).map((key) => [
      key,
      key === "sampleSize"
        ? Number(row[key])
        : row[key] instanceof Date
          ? time(row[key])
          : row[key],
    ]),
  );
  if (!same(actual, expected)) throw new TypeError("Invalid stored evidence envelope");
  integer(row.evidenceRevision);
  return parsed;
}
function decodeEvent(row: Row): EventRecord {
  const evidence = row.currentPayload as EventEvidenceV1;
  const current = reference(
    {
      id: row.currentEvidenceId,
      version: row.currentEvidenceVersion,
      hash: row.currentEvidenceHash,
    },
    evidence,
  );
  const record = EventRecordSchema.parse({
    schemaVersion: row.schemaVersion,
    id: row.id,
    binding: rowBinding(row),
    eventType: row.eventType,
    entity: evidence.entity,
    fingerprint: row.fingerprint,
    severityFloor: row.severityFloor,
    rulePolicyVersion: row.rulePolicyVersion,
    state: row.state,
    revision: integer(row.revision),
    firstSeenAt: time(row.firstSeenAt),
    lastSeenAt: time(row.lastSeenAt),
    currentEvidence: current,
  });
  EventEvidenceRecordSchema.parse({ reference: current, evidence });
  if (
    row.entityKind !== record.entity.kind ||
    row.entityId !== entityId(record.entity, record.binding) ||
    row.baselineVersion !== current.baselineVersion
  )
    throw new TypeError("Invalid stored event identity");
  return record;
}
async function authorize(
  options: EventRepositoryOptions,
  request: Authorized,
  write: boolean,
): Promise<boolean> {
  await options.client.query(
    `SELECT set_config('app.user_id',$1,true),
    set_config('app.organization_id',$2,true),set_config('app.workspace_id',$3,true),
    set_config('app.store_id',$4,true),set_config('app.connection_id',$5,true),
    set_config('app.external_store_id',$6,true),set_config('app.merchant_id',$7,true)`,
    [options.actor.userId, ...values(request.binding), options.actor.merchantId],
  );
  const result = await options.client.query(
    `SELECT public.event_scope_access($1,$2,$3,$4,$5,$6) AS allowed`,
    [...values(request.binding), write],
  );
  return result.rows[0]?.allowed === true;
}
function sqlFailure<T>(error: unknown): EventResult<T> {
  const code = error !== null && typeof error === "object" && "code" in error ? error.code : null;
  return failure(
    code === "23505" ? "CONFLICT" : code === "23503" ? "VERSION_MISMATCH" : "SOURCE_UNAVAILABLE",
  );
}
async function recover(client: EventTransactionClient): Promise<void> {
  // Failure to restore the savepoint must escape: the host must abort the whole unit of work.
  await client.query("ROLLBACK TO SAVEPOINT event_repository_operation");
  await client.query("RELEASE SAVEPOINT event_repository_operation");
}
async function execute<T, R extends Authorized>(
  options: EventRepositoryOptions,
  schema: Parser<R>,
  input: R,
  write: boolean,
  work: (request: R) => Promise<EventResult<T>>,
): Promise<EventResult<T>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return failure("INVALID_INPUT");
  const request = parsed.data;
  if (!same(request.actor, options.actor)) return failure("FORBIDDEN");
  if (
    request.binding.organizationId !== options.actor.organizationId ||
    request.binding.workspaceId !== options.actor.workspaceId
  )
    return failure(write ? "FORBIDDEN" : "NOT_FOUND");
  await options.client.query("SAVEPOINT event_repository_operation");
  try {
    const result = (await authorize(options, request, write))
      ? await work(request)
      : failure<T>(write ? "FORBIDDEN" : "NOT_FOUND");
    if (!result.ok) {
      await recover(options.client);
      return result;
    }
    await options.client.query("RELEASE SAVEPOINT event_repository_operation");
    return result;
  } catch (error) {
    await recover(options.client);
    return sqlFailure(error);
  }
}
async function active(
  client: EventTransactionClient,
  binding: ConnectorBinding,
  fingerprint: string,
  lock = false,
): Promise<Row | undefined> {
  const result = await client.query(
    `${eventSelect} /* event:active */ AND e.fingerprint=$6
    AND e.state IN ('OPEN','ACKNOWLEDGED','SUPPRESSED')${lock ? " FOR UPDATE OF e" : ""}`,
    [...values(binding), fingerprint],
  );
  if (result.rows.length > 1) throw new TypeError("Duplicate active event");
  return result.rows[0];
}
async function detailRow(
  client: EventTransactionClient,
  request: EventDetailQuery,
  lock = false,
): Promise<Row | undefined> {
  const result = await client.query(
    `${eventSelect} /* event:detail */ AND e.id=$6${lock ? " FOR UPDATE OF e" : ""}`,
    [...values(request.binding), request.eventId],
  );
  return result.rows[0];
}
async function duplicate(
  client: EventTransactionClient,
  request: EventAppendEvidenceRequest,
  row: Row,
  seenAt: string,
): Promise<EventResult<EventRecord> | null> {
  const event = decodeEvent(row);
  const found = await client.query(
    `SELECT * FROM public.event_evidence WHERE ${scoped}
    /* event:duplicates */ AND "eventId"=$6 AND (id=$7 OR hash=$8 OR version=$9)`,
    [
      ...values(request.binding),
      event.id,
      request.reference.id,
      request.reference.hash,
      request.reference.version,
    ],
  );
  if (!found.rows.length) return null;
  const prior = found.rows.map(decodeEvidence);
  if (
    prior.some(
      (item) =>
        !same(item.reference, request.reference) ||
        !same(item.evidence, request.candidate.evidence),
    )
  )
    return failure("CONFLICT");
  if (request.reference.id !== event.currentEvidence.id) return { ok: true, value: event };
  const updated = await client.query(
    `UPDATE public.events SET "lastSeenAt"=GREATEST("lastSeenAt",$7::timestamptz)
    WHERE ${scoped} /* event:touch */ AND id=$6 RETURNING *`,
    [...values(request.binding), event.id, seenAt],
  );
  return {
    ok: true,
    value: decodeEvent({ ...updated.rows[0], currentPayload: row.currentPayload }),
  };
}
async function sourceReplay(
  client: EventTransactionClient,
  request: EventAppendEvidenceRequest,
  eventId: string,
): Promise<boolean> {
  const refs = [
    ...request.candidate.evidence.sourceReferences,
    ...(request.candidate.evidence.baseline?.sourceReferences ?? []),
  ];
  const result = await client.query(
    `SELECT id FROM public.event_evidence WHERE ${scoped}
    /* event:sources */ AND "eventId"=$6 AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements($7::jsonb) incoming WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements((payload->'sourceReferences') ||
          COALESCE(payload->'baseline'->'sourceReferences','[]'::jsonb)) prior
        WHERE prior->>'kind'=incoming->>'kind' AND prior->>'id'=incoming->>'id'
          AND prior->>'version'=incoming->>'version')) LIMIT 1`,
    [...values(request.binding), eventId, JSON.stringify(refs)],
  );
  return result.rows.length > 0 || (await sourceConflict(client, request.binding, eventId, refs));
}
async function validateMetrics(
  client: EventTransactionClient,
  evidence: EventEvidenceV1,
): Promise<boolean> {
  const refs = [...evidence.sourceReferences, ...(evidence.baseline?.sourceReferences ?? [])];
  for (const ref of refs.filter((item) => item.kind === "METRIC_SNAPSHOT")) {
    const result = await client.query(
      `SELECT id FROM public.metric_snapshots WHERE ${scoped}
      AND id::text=$6 AND "inputRevision"=$7 AND "inputHash"=$8 AND "definitionVersion"=$9
      AND "periodStart"=$10 AND "periodEnd"=$11 AND "key"=$12
      AND timezone=$13 AND currency=$14 AND "computedAt" <= $15 AND "visibleAt" <= $15`,
      [
        ...values(evidence.binding),
        ref.id,
        ref.version,
        ref.hash,
        ref.definitionVersion,
        ref.period.periodStart,
        ref.period.periodEnd,
        ref.measure?.kind,
        ref.period.timezone,
        ref.period.currency,
        ref.observedAt,
      ],
    );
    if (result.rows.length !== 1) return false;
  }
  return true;
}
async function sourceConflict(
  client: EventTransactionClient,
  binding: ConnectorBinding,
  eventId: string,
  refs: readonly EventSourceReference[],
): Promise<boolean> {
  const result = await client.query(
    `SELECT DISTINCT prior AS reference FROM public.event_evidence,
    LATERAL jsonb_array_elements((payload->'sourceReferences') ||
      COALESCE(payload->'baseline'->'sourceReferences','[]'::jsonb)) prior WHERE ${scoped}
    /* event:source-conflicts */ AND "eventId"=$6 AND EXISTS (
      SELECT 1 FROM jsonb_array_elements($7::jsonb) incoming
      WHERE prior->>'kind'=incoming->>'kind' AND prior->>'id'=incoming->>'id'
        AND prior->>'version'=incoming->>'version')`,
    [...values(binding), eventId, JSON.stringify(refs)],
  );
  return result.rows.some((row) =>
    refs.some((ref) => {
      const prior = row.reference as EventSourceReference;
      return (
        prior.kind === ref.kind &&
        prior.id === ref.id &&
        prior.version === ref.version &&
        !same(prior, ref)
      );
    }),
  );
}
function appendObserved(
  options: EventRepositoryOptions,
  request: EventAppendEvidenceRequest,
): Promise<EventResult<EventRecord>> {
  const seenAt = EventTimestampSchema.parse(options.now());
  if (Date.parse(seenAt) < Date.parse(request.candidate.evidence.observedAt))
    return Promise.resolve(failure("INVALID_INPUT"));
  return appendStored(options.client, request, seenAt);
}
const eventColumns = `id,"organizationId","workspaceId","storeId","connectionId","externalStoreId",
  "schemaVersion","eventType","entityKind","entityId","baselineVersion",fingerprint,"severityFloor",
  "rulePolicyVersion",state,revision,"firstSeenAt","lastSeenAt","currentEvidenceId","currentEvidenceVersion","currentEvidenceHash"`;
function placeholders(count: number): string {
  return Array.from({ length: count }, (_, i) => `$${i + 1}`).join(",");
}
async function createEvent(
  client: EventTransactionClient,
  request: EventAppendEvidenceRequest,
  seenAt: string,
): Promise<Row> {
  const { candidate, reference: ref } = request;
  const evidence = candidate.evidence;
  const result = await client.query(
    `INSERT INTO public.events (${eventColumns}) VALUES (${placeholders(21)}) RETURNING *`,
    [
      randomUUID(),
      ...values(request.binding),
      1,
      evidence.eventType,
      evidence.entity.kind,
      entityId(evidence.entity, evidence.binding),
      evidence.baselineVersion,
      candidate.fingerprint,
      candidate.severityFloor,
      candidate.rulePolicyVersion,
      "OPEN",
      1,
      seenAt,
      seenAt,
      ref.id,
      ref.version,
      ref.hash,
    ],
  );
  if (result.rows.length !== 1) throw new TypeError("Missing inserted event");
  return { ...result.rows[0], currentPayload: evidence };
}
const evidenceColumns = `id,"eventId","organizationId","workspaceId","storeId","connectionId","externalStoreId",
  "evidenceRevision","schemaVersion",fingerprint,version,hash,"definitionVersion","periodStart","periodEnd",
  "observedAt","sourceWatermark",timezone,currency,"dataStatus","sampleSize","coverageBasisPoints",issues,payload`;
async function insertEvidence(
  client: EventTransactionClient,
  request: EventAppendEvidenceRequest,
  event: EventRecord,
  revision: number,
): Promise<void> {
  await client.query(
    `INSERT INTO public.event_evidence (${evidenceColumns}) VALUES (${placeholders(24)})`,
    evidenceValues(request, event.id, revision),
  );
  await insertMetricLinks(client, request);
}
function evidenceValues(
  request: EventAppendEvidenceRequest,
  eventId: string,
  revision: number,
): unknown[] {
  const { candidate, reference: ref } = request;
  const e = candidate.evidence;
  return [
    ref.id,
    eventId,
    ...values(request.binding),
    revision,
    1,
    candidate.fingerprint,
    ref.version,
    ref.hash,
    e.definitionVersion,
    e.periodStart,
    e.periodEnd,
    e.observedAt,
    e.sourceWatermark,
    e.timezone,
    e.currency,
    e.dataStatus,
    e.sampleSize,
    e.coverageBasisPoints,
    JSON.stringify(e.issues),
    JSON.stringify(e),
  ];
}
async function insertMetricLinks(
  client: EventTransactionClient,
  request: EventAppendEvidenceRequest,
): Promise<void> {
  const {
    candidate: { evidence: e },
    reference: ref,
  } = request;
  const refs = [...e.sourceReferences, ...(e.baseline?.sourceReferences ?? [])];
  const metricIds = new Set(
    refs.filter((item) => item.kind === "METRIC_SNAPSHOT").map((item) => item.id),
  );
  for (const id of metricIds)
    await client.query(
      `INSERT INTO public.event_evidence_metrics
    ("evidenceId","metricSnapshotId","organizationId","workspaceId","storeId","connectionId","externalStoreId")
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [ref.id, id, ...values(request.binding)],
    );
}
async function advance(
  client: EventTransactionClient,
  request: EventAppendEvidenceRequest,
  event: EventRecord,
  seenAt: string,
): Promise<EventResult<EventRecord>> {
  const ref = request.reference;
  const result = await client.query(
    `UPDATE public.events SET revision=revision+1,"currentEvidenceId"=$8,
    "currentEvidenceVersion"=$9,"currentEvidenceHash"=$10,"lastSeenAt"=GREATEST("lastSeenAt",$11::timestamptz)
    WHERE ${scoped} /* event:advance */ AND id=$6 AND revision=$7 RETURNING *`,
    [...values(request.binding), event.id, event.revision, ref.id, ref.version, ref.hash, seenAt],
  );
  return result.rows[0]
    ? {
        ok: true,
        value: decodeEvent({ ...result.rows[0], currentPayload: request.candidate.evidence }),
      }
    : failure("CONFLICT");
}
async function appendStored(
  client: EventTransactionClient,
  request: EventAppendEvidenceRequest,
  seenAt: string,
): Promise<EventResult<EventRecord>> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
    request.candidate.fingerprint,
  ]);
  const row = await active(client, request.binding, request.candidate.fingerprint, true);
  if (!row) return appendNew(client, request, seenAt);
  const event = decodeEvent(row);
  if (request.expectedRevision !== null && event.revision !== request.expectedRevision)
    return failure("CONFLICT");
  if (
    event.rulePolicyVersion !== request.candidate.rulePolicyVersion ||
    event.severityFloor !== request.candidate.severityFloor
  )
    return failure("CONFLICT");
  const reused = await duplicate(client, request, row, seenAt);
  if (reused) return reused;
  if (event.revision === Number.MAX_SAFE_INTEGER) return failure("OVERFLOW");
  const prior = row.currentPayload as EventEvidenceV1;
  if (
    Date.parse(request.candidate.evidence.observedAt) <= Date.parse(prior.observedAt) ||
    (await sourceReplay(client, request, event.id))
  )
    return failure("VERSION_MISMATCH");
  if (!(await validateMetrics(client, request.candidate.evidence)))
    return failure("VERSION_MISMATCH");
  await insertEvidence(client, request, event, event.revision + 1);
  return advance(client, request, event, seenAt);
}
async function appendNew(
  client: EventTransactionClient,
  request: EventAppendEvidenceRequest,
  seenAt: string,
): Promise<EventResult<EventRecord>> {
  if (request.expectedRevision !== null) return failure("CONFLICT");
  if (!(await validateMetrics(client, request.candidate.evidence)))
    return failure("VERSION_MISMATCH");
  const event = decodeEvent(await createEvent(client, request, seenAt));
  await insertEvidence(client, request, event, 1);
  return { ok: true, value: event };
}
async function transitionStored(
  client: EventTransactionClient,
  request: EventStateTransition,
): Promise<EventResult<EventRecord>> {
  const row = await detailRow(client, request, true);
  if (!row) return failure("NOT_FOUND");
  const event = decodeEvent(row);
  if (event.revision !== request.expectedRevision || event.state !== request.fromState)
    return failure("CONFLICT");
  if (event.revision === Number.MAX_SAFE_INTEGER) return failure("OVERFLOW");
  const result = await client.query(
    `UPDATE public.events SET state=$9,revision=revision+1
    WHERE ${scoped} /* event:transition */ AND id=$6 AND revision=$7 AND state=$8 RETURNING *`,
    [
      ...values(request.binding),
      request.eventId,
      request.expectedRevision,
      request.fromState,
      request.toState,
    ],
  );
  return result.rows[0]
    ? { ok: true, value: decodeEvent({ ...result.rows[0], currentPayload: row.currentPayload }) }
    : failure("CONFLICT");
}
async function currentStored(
  client: EventTransactionClient,
  request: EventCurrentQuery,
): Promise<EventResult<EventRecord | null>> {
  const row = await active(client, request.binding, createEventFingerprint(request.identity));
  return { ok: true, value: row ? decodeEvent(row) : null };
}
async function detailStored(
  client: EventTransactionClient,
  request: EventDetailQuery,
): Promise<EventResult<EventRecord>> {
  const row = await detailRow(client, request);
  return row ? { ok: true, value: decodeEvent(row) } : failure("NOT_FOUND");
}
async function evidenceStored(
  client: EventTransactionClient,
  request: EventEvidenceQuery,
): Promise<EventResult<EventEvidenceRecord>> {
  const ref = request.reference;
  const result = await client.query(
    `SELECT * FROM public.event_evidence WHERE ${scoped}
    /* event:evidence */ AND "eventId"=$6 AND id=$7 AND version=$8 AND hash=$9`,
    [...values(request.binding), request.eventId, ref.id, ref.version, ref.hash],
  );
  if (!result.rows[0]) return failure("NOT_FOUND");
  const record = decodeEvidence(result.rows[0]);
  return same(record.reference, ref) ? { ok: true, value: record } : failure("NOT_FOUND");
}
function queryHash(request: EventListQuery | EventHistoryQuery): string {
  const { cursor, ...bound } = request;
  void cursor;
  return createHash("sha256")
    .update(JSON.stringify(canonical(bound)))
    .digest("hex");
}
type Anchor = { readonly time: string; readonly id: string; readonly revision: number };
function cursorData(request: EventListQuery | EventHistoryQuery, anchor: Anchor): string {
  return Buffer.from(JSON.stringify({ v: 1, query: queryHash(request), ...anchor })).toString(
    "base64url",
  );
}
function parseCursor(request: EventListQuery | EventHistoryQuery): Anchor | null {
  if (request.cursor === null) return { time: "1970-01-01T00:00:00Z", id: "start", revision: 1 };
  if (!/^[A-Za-z0-9_-]+$/u.test(request.cursor)) return null;
  try {
    const data: unknown = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8"));
    if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
    const row = data as Row;
    if (
      !same(Object.keys(row).sort(), ["id", "query", "revision", "time", "v"]) ||
      row.v !== 1 ||
      row.query !== queryHash(request) ||
      !ExternalIdSchema.safeParse(row.id).success
    )
      return null;
    return { time: time(row.time), id: String(row.id), revision: integer(row.revision) };
  } catch {
    return null;
  }
}
async function listStored(
  client: EventTransactionClient,
  request: EventListQuery,
): Promise<EventResult<EventPage<EventRecord>>> {
  const anchor = parseCursor(request);
  if (!anchor) return failure("INVALID_INPUT");
  const result = await client.query(
    `${eventSelect} /* event:list */
    AND (cardinality($6::text[])=0 OR e."eventType"=ANY($6::text[]))
    AND (cardinality($7::text[])=0 OR e.state=ANY($7::text[]))
    AND ($8::text IS NULL OR (e."entityKind"=$8 AND e."entityId"=$9))
    AND ($10::timestamptz IS NULL OR (e."firstSeenAt",e.id)<($10::timestamptz,$11::text))
    ORDER BY e."firstSeenAt" DESC,e.id DESC LIMIT $12`,
    [
      ...values(request.binding),
      [...request.eventTypes],
      [...request.states],
      request.entity?.kind ?? null,
      request.entity ? entityId(request.entity, request.binding) : null,
      request.cursor ? anchor.time : null,
      request.cursor ? anchor.id : null,
      request.limit + 1,
    ],
  );
  const page = result.rows.slice(0, request.limit);
  const items = page.map(decodeEvent);
  const last = items.at(-1);
  const nextCursor =
    result.rows.length > request.limit && last
      ? cursorData(request, { time: last.firstSeenAt, id: last.id, revision: last.revision })
      : null;
  return { ok: true, value: { items, nextCursor } };
}
async function historyStored(
  client: EventTransactionClient,
  request: EventHistoryQuery,
): Promise<EventResult<EventPage<EventEvidenceRecord>>> {
  const anchor = parseCursor(request);
  if (!anchor) return failure("INVALID_INPUT");
  if (!(await detailRow(client, request))) return failure("NOT_FOUND");
  const result = await client.query(
    `SELECT * FROM public.event_evidence WHERE ${scoped}
    /* event:history */ AND "eventId"=$6 AND ($7::bigint IS NULL OR "evidenceRevision"<$7)
    ORDER BY "evidenceRevision" DESC LIMIT $8`,
    [
      ...values(request.binding),
      request.eventId,
      request.cursor ? anchor.revision : null,
      request.limit + 1,
    ],
  );
  const page = result.rows.slice(0, request.limit);
  const items = page.map(decodeEvidence);
  const last = page.at(-1);
  const nextCursor =
    result.rows.length > request.limit && last
      ? cursorData(request, {
          time: time(last.observedAt),
          id: String(last.id),
          revision: integer(last.evidenceRevision),
        })
      : null;
  return { ok: true, value: { items, nextCursor } };
}
function createRunner(bound: EventRepositoryOptions) {
  let pending = Promise.resolve();
  return function run<T, R extends Authorized>(
    schema: Parser<R>,
    request: R,
    write: boolean,
    work: (request: R) => Promise<EventResult<T>>,
  ): Promise<EventResult<T>> {
    const snapshot = structuredClone(request);
    const result = pending.then(() => execute(bound, schema, snapshot, write, work));
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
/** Serial use keeps transaction-local RLS context/savepoints isolated; never commits the host's audit UoW. */
export function createEventRepository(
  options: EventRepositoryOptions,
): EventRepository & EventQueryPort {
  const actor = TenantContextSchema.parse(options?.actor);
  if (typeof options?.client?.query !== "function" || typeof options?.now !== "function")
    throw new TypeError("Invalid event transaction client");
  const bound: EventRepositoryOptions = {
    actor: structuredClone(actor),
    client: options.client,
    now: options.now,
  };
  const run = createRunner(bound);
  return Object.freeze({
    appendEvidence: (request: EventAppendEvidenceRequest) =>
      run(EventAppendEvidenceRequestSchema, request, true, (r) => appendObserved(bound, r)),
    stateTransition: (request: EventStateTransition) =>
      run(EventStateTransitionSchema, request, true, (r) => transitionStored(bound.client, r)),
    current: (request: EventCurrentQuery) =>
      run(EventCurrentQuerySchema, request, false, (r) => currentStored(bound.client, r)),
    detail: (request: EventDetailQuery) =>
      run(EventDetailQuerySchema, request, false, (r) => detailStored(bound.client, r)),
    evidence: (request: EventEvidenceQuery) =>
      run(EventEvidenceQuerySchema, request, false, (r) => evidenceStored(bound.client, r)),
    list: (request: EventListQuery) =>
      run(EventListQuerySchema, request, false, (r) => listStored(bound.client, r)),
    history: (request: EventHistoryQuery) =>
      run(EventHistoryQuerySchema, request, false, (r) => historyStored(bound.client, r)),
  });
}

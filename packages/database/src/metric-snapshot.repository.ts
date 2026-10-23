import {
  ConnectorBindingSchema,
  MetricComputationV1Schema,
  MetricSnapshotV1Schema,
  MetricSubjectSchema,
  MetricTimestampSchema,
  MetricValueSchema,
  MetricWindowSchema,
  SourceVersionSchema,
  TenantContextSchema,
  type ConnectorBinding,
  type MetricComputationV1,
  type MetricErrorCode,
  type MetricKind,
  type MetricResult,
  type MetricSnapshotQuery,
  type MetricSnapshotRepository,
  type MetricSnapshotV1,
  type MetricSubject,
  type TenantContext,
} from "@shopmate/contracts";
import type { Pool, PoolClient } from "pg";

export interface MetricHashDescriptor {
  readonly schemaVersion: 1;
  readonly hashVersion: "metric-input-sha256-v1";
  readonly definitionVersion: string;
  readonly inputRevision: string;
  readonly binding: ConnectorBinding;
  readonly window: MetricSnapshotQuery["window"];
  readonly visibleAt: string;
  readonly sourceWatermark: string | null;
  readonly kind: MetricKind;
  readonly subject: MetricSubject;
  readonly inputHash: string;
  readonly evidenceIds: readonly string[];
}
export interface MetricInputHasher {
  readonly create: (
    request: Readonly<{
      input: MetricComputationV1["input"];
      kind: MetricKind;
      subject: MetricSubject;
    }>,
  ) => MetricResult<MetricHashDescriptor>;
}
export interface StoredMetricSnapshot {
  readonly id: string;
  readonly inputHash: string;
  readonly snapshot: MetricSnapshotV1;
}
export interface MetricHistoryPage {
  readonly items: readonly StoredMetricSnapshot[];
  readonly nextCursor: string | null;
}
export interface MetricSnapshotStore extends MetricSnapshotRepository {
  readonly byId: (
    request: Readonly<{ binding: ConnectorBinding; id: string }>,
  ) => Promise<MetricResult<StoredMetricSnapshot>>;
  readonly history: (
    request: Readonly<{ query: MetricSnapshotQuery; limit: number; cursor: string | null }>,
  ) => Promise<MetricResult<MetricHistoryPage>>;
}
export interface MetricSnapshotStoreOptions {
  /** Server-owned restricted capability login; never accept actor or pool from request payloads. */
  readonly pool: Pick<Pool, "connect">;
  readonly actor: TenantContext;
  readonly hasher: MetricInputHasher;
}

type Row = Record<string, unknown>;
type SqlClient = Pick<PoolClient, "query" | "release" | "on" | "off">;
const hashPattern = /^sha256:[a-f0-9]{64}$/u;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const bindingKeys = [
  "organizationId",
  "workspaceId",
  "storeId",
  "connectionId",
  "externalStoreId",
] as const;
const kinds = new Set<MetricKind>(
  MetricValueSchema.options.flatMap((option) => option.unwrap().shape.kind.options),
);
const units = new Set([
  "PAID_ORDERS",
  "PAID_UNITS",
  "REFUNDED_COHORT_ORDERS",
  "INVENTORY_AVAILABLE",
]);
const basisPoints = new Set([
  "REFUND_COHORT_ORDER_RATE",
  "REFUND_COHORT_AMOUNT_RATE",
  "CONVERSION_RATE",
  "CART_RATE",
  "CHECKOUT_RATE",
  "ROAS",
]);
const hours = new Set(["INVENTORY_HOURS_REMAINING", "LEAD_TIME_HOURS"]);

function failure<T>(code: MetricErrorCode): MetricResult<T> {
  return { ok: false, error: { code, evidenceIds: [] } };
}
function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}
// Public evidence/issues are unordered; timestamps compare as instants like the injected P13 hasher.
function canonical(value: unknown, key = ""): string {
  if (value === null || typeof value !== "object") {
    const normalized =
      typeof value === "string" &&
      ["periodStart", "periodEnd", "visibleAt", "sourceWatermark"].includes(key)
        ? iso(value)
        : value;
    return JSON.stringify(normalized);
  }
  if (Array.isArray(value))
    return JSON.stringify(value.map((item: unknown) => canonical(item)).sort());
  return JSON.stringify(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, item]) => [name, canonical(item, name)]),
  );
}
function subjectId(subject: MetricSubject): string {
  return subject.kind === "SKU"
    ? subject.externalSkuId
    : subject.kind === "CAMPAIGN"
      ? subject.externalCampaignId
      : "";
}
function scoped(actor: TenantContext, binding: ConnectorBinding): boolean {
  return (
    actor.organizationId === binding.organizationId && actor.workspaceId === binding.workspaceId
  );
}
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => key in value)
  );
}
function validQuery(value: unknown): value is MetricSnapshotQuery {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const query = value as Record<string, unknown>;
  const keys = [
    "binding",
    "window",
    "kinds",
    "subject",
    "definitionVersion",
    "inputRevision",
    "visibleAt",
  ];
  return (
    Object.keys(query).length === keys.length &&
    keys.every((key) => key in query) &&
    ConnectorBindingSchema.safeParse(query.binding).success &&
    MetricWindowSchema.safeParse(query.window).success &&
    MetricSubjectSchema.safeParse(query.subject).success &&
    SourceVersionSchema.safeParse(query.definitionVersion).success &&
    (query.inputRevision === null || SourceVersionSchema.safeParse(query.inputRevision).success) &&
    MetricTimestampSchema.safeParse(query.visibleAt).success &&
    Array.isArray(query.kinds) &&
    query.kinds.length > 0 &&
    query.kinds.length <= kinds.size &&
    query.kinds.every((kind: unknown) => kinds.has(kind as MetricKind)) &&
    new Set(query.kinds).size === query.kinds.length
  );
}
const descriptorKeys = [
  "schemaVersion",
  "hashVersion",
  "definitionVersion",
  "inputRevision",
  "binding",
  "window",
  "visibleAt",
  "sourceWatermark",
  "kind",
  "subject",
  "inputHash",
  "evidenceIds",
];
function validDescriptorShape(
  value: unknown,
): value is Record<string, unknown> & { inputHash: string } {
  if (
    !exactKeys(value, descriptorKeys) ||
    !ConnectorBindingSchema.safeParse(value.binding).success ||
    !MetricWindowSchema.safeParse(value.window).success ||
    !MetricSubjectSchema.safeParse(value.subject).success ||
    !MetricTimestampSchema.safeParse(value.visibleAt).success ||
    (value.sourceWatermark !== null &&
      !MetricTimestampSchema.safeParse(value.sourceWatermark).success) ||
    typeof value.inputHash !== "string" ||
    !Array.isArray(value.evidenceIds) ||
    !value.evidenceIds.length ||
    !value.evidenceIds.every(
      (id: unknown) => typeof id === "string" && /^metric-evidence-v1:[a-f0-9]{64}$/u.test(id),
    ) ||
    new Set(value.evidenceIds).size !== value.evidenceIds.length
  )
    return false;
  return true;
}
function validDescriptor(
  value: unknown,
  computation: MetricComputationV1,
): value is MetricHashDescriptor {
  if (!validDescriptorShape(value)) return false;
  const { input, snapshot } = computation;
  const window = {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    timezone: input.timezone,
    currency: input.currency,
  };
  return (
    value.schemaVersion === 1 &&
    value.hashVersion === "metric-input-sha256-v1" &&
    hashPattern.test(value.inputHash) &&
    value.definitionVersion === input.definitionVersion &&
    value.inputRevision === input.inputRevision &&
    same(value.binding, input.binding) &&
    same(value.window, window) &&
    same({ visibleAt: value.visibleAt }, { visibleAt: input.visibleAt }) &&
    same({ sourceWatermark: value.sourceWatermark }, { sourceWatermark: input.sourceWatermark }) &&
    value.kind === snapshot.metric.kind &&
    same(value.subject, snapshot.subject)
  );
}
function iso(value: unknown): string {
  if (!(value instanceof Date) && !MetricTimestampSchema.safeParse(value).success) {
    throw new TypeError("Invalid stored timestamp");
  }
  const date = value instanceof Date ? value : new Date(value as string);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Invalid stored timestamp");
  return date.toISOString().replace(/\.000Z$/u, "Z");
}
function safeNumber(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === "string") {
    if (!/^-?(?:0|[1-9][0-9]*)$/u.test(value)) throw new TypeError("Invalid stored integer");
    value = BigInt(value);
  }
  const number = typeof value === "bigint" ? Number(value) : value;
  if (
    typeof number !== "number" ||
    !Number.isFinite(number) ||
    (typeof value === "bigint" && !Number.isSafeInteger(number))
  )
    throw new TypeError("Invalid stored number");
  return number;
}
function decodeValue(row: Row): MetricSnapshotV1["metric"] {
  const kind = row.key as MetricKind;
  const unit = hours.has(kind)
    ? "hours"
    : basisPoints.has(kind)
      ? "basisPoints"
      : units.has(kind)
        ? "units"
        : "minorCNY";
  const field =
    unit === "hours"
      ? "valueHours"
      : unit === "basisPoints"
        ? "valueBasisPoints"
        : unit === "units"
          ? "valueUnits"
          : "valueMinor";
  if (
    ["valueHours", "valueBasisPoints", "valueUnits", "valueMinor"].some(
      (key) => key !== field && row[key] !== null,
    )
  ) {
    throw new TypeError("Contradictory stored value columns");
  }
  return { kind, unit, value: safeNumber(row[field]) } as MetricSnapshotV1["metric"];
}
function decodeMetadata(row: Row): Pick<StoredMetricSnapshot, "id" | "inputHash"> {
  if (
    typeof row.id !== "string" ||
    !uuidPattern.test(row.id) ||
    row.hashVersion !== "metric-input-sha256-v1" ||
    typeof row.inputHash !== "string" ||
    !hashPattern.test(row.inputHash)
  )
    throw new TypeError("Invalid stored metadata");
  if (row.subjectKind === "STORE" && row.subjectId !== "")
    throw new TypeError("Invalid store subject");
  return { id: row.id, inputHash: row.inputHash };
}
function decode(row: Row): StoredMetricSnapshot {
  const metadata = decodeMetadata(row);
  const binding = Object.fromEntries(bindingKeys.map((key) => [key, row[key]]));
  const subject =
    row.subjectKind === "STORE"
      ? { kind: "STORE" }
      : row.subjectKind === "SKU"
        ? { kind: "SKU", externalSkuId: row.subjectId }
        : { kind: "CAMPAIGN", externalCampaignId: row.subjectId };
  const parsed = MetricSnapshotV1Schema.safeParse({
    schemaVersion: row.schemaVersion,
    definitionVersion: row.definitionVersion,
    inputRevision: row.inputRevision,
    binding,
    periodStart: iso(row.periodStart),
    periodEnd: iso(row.periodEnd),
    timezone: row.timezone,
    currency: row.currency,
    visibleAt: iso(row.visibleAt),
    sourceWatermark: row.sourceWatermark === null ? null : iso(row.sourceWatermark),
    computedAt: iso(row.computedAt),
    sampleSize: safeNumber(row.sampleSize),
    coverageBasisPoints: row.coverageBasisPoints,
    status: row.status,
    evidenceIds: row.evidenceIds,
    issues: row.issues,
    subject,
    metric: decodeValue(row),
  });
  if (!parsed.success || row.subjectKind !== parsed.data.subject.kind)
    throw new TypeError("Invalid stored snapshot");
  return { ...metadata, snapshot: parsed.data };
}
function identity(snapshot: MetricSnapshotV1): unknown[] {
  const binding = bindingKeys.map((key) => snapshot.binding[key]);
  return [
    ...binding,
    snapshot.metric.kind,
    snapshot.subject.kind,
    subjectId(snapshot.subject),
    snapshot.definitionVersion,
    snapshot.periodStart,
    snapshot.periodEnd,
    snapshot.inputRevision,
  ];
}
function snapshotValues(snapshot: MetricSnapshotV1, inputHash: string): unknown[] {
  const { metric } = snapshot;
  return [
    ...identity(snapshot).slice(0, 5),
    metric.kind,
    snapshot.definitionVersion,
    snapshot.schemaVersion,
    "metric-input-sha256-v1",
    snapshot.inputRevision,
    inputHash,
    snapshot.subject.kind,
    subjectId(snapshot.subject),
    snapshot.periodStart,
    snapshot.periodEnd,
    snapshot.timezone,
    snapshot.currency,
    snapshot.visibleAt,
    snapshot.sourceWatermark,
    snapshot.computedAt,
    BigInt(snapshot.sampleSize),
    snapshot.coverageBasisPoints,
    snapshot.status,
    [...snapshot.evidenceIds],
    JSON.stringify(snapshot.issues),
    metric.unit === "minorCNY" && metric.value !== null ? BigInt(metric.value) : null,
    metric.unit === "units" && metric.value !== null ? BigInt(metric.value) : null,
    metric.unit === "basisPoints" && metric.value !== null ? BigInt(metric.value) : null,
    metric.unit === "hours" ? metric.value : null,
  ];
}
const insertSql = `INSERT INTO public.metric_snapshots (
  "organizationId","workspaceId","storeId","connectionId","externalStoreId",
  "key","definitionVersion","schemaVersion","hashVersion","inputRevision","inputHash",
  "subjectKind","subjectId","periodStart","periodEnd","timezone","currency",
  "visibleAt","sourceWatermark","computedAt","sampleSize","coverageBasisPoints",
  "status","evidenceIds","issues","valueMinor","valueUnits","valueBasisPoints","valueHours"
) VALUES (${Array.from({ length: 29 }, (_, index) => `$${index + 1}`).join(",")})
ON CONFLICT ("organizationId","workspaceId","storeId","connectionId","externalStoreId",
  "key","subjectKind","subjectId","definitionVersion","periodStart","periodEnd","inputRevision")
DO NOTHING RETURNING *`;
const identitySql = `SELECT * FROM public.metric_snapshots WHERE
  "organizationId"=$1 AND "workspaceId"=$2 AND "storeId"=$3 AND
  "connectionId"=$4 AND "externalStoreId"=$5 AND "key"=$6 AND
  "subjectKind"=$7 AND "subjectId"=$8 AND "definitionVersion"=$9 AND
  "periodStart"=$10 AND "periodEnd"=$11 AND "inputRevision"=$12`;
const querySql = `"organizationId"=$1 AND "workspaceId"=$2 AND "storeId"=$3 AND
  "connectionId"=$4 AND "externalStoreId"=$5 AND "periodStart"=$6 AND
  "periodEnd"=$7 AND "timezone"=$8 AND "currency"=$9 AND
  "subjectKind"=$10 AND "subjectId"=$11 AND "definitionVersion"=$12 AND
  "visibleAt" <= $13 AND "key" = ANY($14::text[]) AND
  ($15::text IS NULL OR "inputRevision"=$15)`;
function queryValues(query: MetricSnapshotQuery): unknown[] {
  return [
    ...bindingKeys.map((key) => query.binding[key]),
    query.window.periodStart,
    query.window.periodEnd,
    query.window.timezone,
    query.window.currency,
    query.subject.kind,
    subjectId(query.subject),
    query.definitionVersion,
    query.visibleAt,
    [...query.kinds],
    query.inputRevision,
  ];
}
async function authorize(
  client: SqlClient,
  actor: TenantContext,
  binding: ConnectorBinding,
  write: boolean,
): Promise<boolean> {
  const values = [actor.userId, ...bindingKeys.map((key) => binding[key])];
  await client.query(
    `SELECT set_config('app.user_id',$1,true),
    set_config('app.organization_id',$2,true),set_config('app.workspace_id',$3,true),
    set_config('app.store_id',$4,true),set_config('app.connection_id',$5,true),
    set_config('app.external_store_id',$6,true),set_config('app.merchant_id',$7,true)`,
    [...values, actor.merchantId],
  );
  const result = await client.query(
    `SELECT public.metric_scope_access($1,$2,$3,$4,$5,$6) AS allowed`,
    [...values.slice(1), write],
  );
  return result.rows[0]?.allowed === true;
}
async function rollbackFailed(client: SqlClient | undefined, begun: boolean): Promise<boolean> {
  if (!client || !begun) return false;
  try {
    await client.query("ROLLBACK");
    return false;
  } catch {
    return true;
  }
}
async function transaction<T>(
  options: MetricSnapshotStoreOptions,
  binding: ConnectorBinding,
  write: boolean,
  work: (client: SqlClient) => Promise<MetricResult<T>>,
): Promise<MetricResult<T>> {
  if (!scoped(options.actor, binding)) return failure(write ? "FORBIDDEN" : "NOT_FOUND");
  let client: SqlClient | undefined;
  let begun = false;
  let rollingBack = false;
  let discard = false;
  const onError = () => {
    discard = true;
  };
  try {
    client = await options.pool.connect();
    // pg-pool removes its idle error listener while a client is checked out.
    client.on("error", onError);
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    begun = true;
    const result = (await authorize(client, options.actor, binding, write))
      ? await work(client)
      : failure<T>(write ? "FORBIDDEN" : "NOT_FOUND");
    if (discard) throw new Error("Metric connection unavailable");
    rollingBack = !result.ok;
    await client.query(result.ok ? "COMMIT" : "ROLLBACK");
    begun = false;
    if (discard) throw new Error("Metric connection unavailable");
    return result;
  } catch {
    discard = rollingBack || (await rollbackFailed(client, begun)) || discard;
    return failure("SOURCE_UNAVAILABLE");
  } finally {
    client?.off("error", onError);
    client?.release(discard);
  }
}
function equivalent(
  stored: StoredMetricSnapshot,
  snapshot: MetricSnapshotV1,
  inputHash: string,
): boolean {
  const { computedAt: priorTime, ...prior } = stored.snapshot;
  const { computedAt: nextTime, ...next } = snapshot;
  void priorTime;
  void nextTime;
  return stored.inputHash === inputHash && same(prior, next);
}
async function appendStored(
  client: SqlClient,
  computation: MetricComputationV1,
  inputHash: string,
): Promise<MetricResult<MetricSnapshotV1>> {
  const { snapshot } = computation;
  const definition = await client.query(
    `SELECT "unit" FROM public.metric_definitions WHERE
    "organizationId"=$1 AND "workspaceId"=$2 AND "storeId"=$3 AND
    "connectionId"=$4 AND "externalStoreId"=$5 AND "key"=$6 AND "definitionVersion"=$7`,
    [
      ...bindingKeys.map((key) => snapshot.binding[key]),
      snapshot.metric.kind,
      snapshot.definitionVersion,
    ],
  );
  if (definition.rows[0]?.unit !== snapshot.metric.unit) return failure("VERSION_MISMATCH");
  const key = identity(snapshot);
  const existing = await client.query(identitySql, key);
  if (existing.rows[0]) return duplicate(existing.rows[0], snapshot, inputHash);
  const inserted = await client.query(insertSql, snapshotValues(snapshot, inputHash));
  if (inserted.rows[0]) return { ok: true, value: decode(inserted.rows[0]).snapshot };
  const raced = await client.query(identitySql, key);
  return raced.rows[0]
    ? duplicate(raced.rows[0], snapshot, inputHash)
    : failure("SOURCE_UNAVAILABLE");
}
function duplicate(
  row: Row,
  snapshot: MetricSnapshotV1,
  inputHash: string,
): MetricResult<MetricSnapshotV1> {
  const stored = decode(row);
  return equivalent(stored, snapshot, inputHash)
    ? { ok: true, value: stored.snapshot }
    : failure("CONFLICT");
}
async function append(
  options: MetricSnapshotStoreOptions,
  value: MetricComputationV1,
): Promise<MetricResult<MetricSnapshotV1>> {
  const parsed = MetricComputationV1Schema.safeParse(value);
  if (!parsed.success) return failure("INVALID_INPUT");
  let proof: MetricResult<MetricHashDescriptor>;
  try {
    proof = options.hasher.create({
      input: parsed.data.input,
      kind: parsed.data.snapshot.metric.kind,
      subject: parsed.data.snapshot.subject,
    });
  } catch {
    return failure("SOURCE_UNAVAILABLE");
  }
  if (!proof.ok) return failure(proof.error.code);
  if (!validDescriptor(proof.value, parsed.data)) return failure("INVALID_INPUT");
  return transaction(options, parsed.data.input.binding, true, (client) =>
    appendStored(client, parsed.data, proof.value.inputHash),
  );
}
async function read(
  options: MetricSnapshotStoreOptions,
  query: MetricSnapshotQuery,
): Promise<MetricResult<readonly MetricSnapshotV1[]>> {
  if (!validQuery(query)) return failure("INVALID_INPUT");
  query = structuredClone(query);
  return transaction(options, query.binding, false, async (client) => {
    const result = await client.query(
      `SELECT * FROM public.metric_snapshots WHERE ${querySql}
      ORDER BY "key" ASC,"computedAt" DESC,"id" DESC`,
      queryValues(query),
    );
    return { ok: true, value: result.rows.map((row) => decode(row).snapshot) };
  });
}
async function byId(
  options: MetricSnapshotStoreOptions,
  request: Readonly<{ binding: ConnectorBinding; id: string }>,
): Promise<MetricResult<StoredMetricSnapshot>> {
  if (
    !exactKeys(request, ["binding", "id"]) ||
    !ConnectorBindingSchema.safeParse(request?.binding).success ||
    typeof request?.id !== "string" ||
    !uuidPattern.test(request.id)
  )
    return failure("INVALID_INPUT");
  request = structuredClone(request);
  return transaction(options, request.binding, false, async (client) => {
    const result = await client.query(
      `SELECT * FROM public.metric_snapshots WHERE
      "organizationId"=$1 AND "workspaceId"=$2 AND "storeId"=$3 AND
      "connectionId"=$4 AND "externalStoreId"=$5 AND "id"=$6`,
      [...bindingKeys.map((key) => request.binding[key]), request.id],
    );
    return result.rows[0] ? { ok: true, value: decode(result.rows[0]) } : failure("NOT_FOUND");
  });
}
function cursorData(query: MetricSnapshotQuery, anchor: Row): string {
  return Buffer.from(JSON.stringify({ query, id: anchor.id }), "utf8").toString("base64url");
}
function parseCursor(cursor: string, query: MetricSnapshotQuery): string | null {
  // The embedded strict query can contain multibyte external IDs at the public 256-code-unit limit.
  if (cursor.length > 32768 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return same(record.query, query) && typeof record.id === "string" && uuidPattern.test(record.id)
      ? record.id
      : null;
  } catch {
    return null;
  }
}
async function historyStored(
  client: SqlClient,
  query: MetricSnapshotQuery,
  limit: number,
  cursor: string | null,
): Promise<MetricResult<MetricHistoryPage>> {
  const values = queryValues(query);
  let anchor: Row | undefined;
  if (cursor !== null) {
    const id = parseCursor(cursor, query);
    if (id === null) return failure("INVALID_INPUT");
    const found = await client.query(
      `SELECT * FROM public.metric_snapshots WHERE ${querySql} AND "id"=$16`,
      [...values, id],
    );
    anchor = found.rows[0];
    if (!anchor) return failure("NOT_FOUND");
  }
  const rows = await client.query(
    `SELECT * FROM public.metric_snapshots WHERE ${querySql}
    AND ($16::timestamptz IS NULL OR ("createdAt","id") < ($16,$17::uuid))
    ORDER BY "createdAt" DESC,"id" DESC LIMIT $18`,
    [...values, anchor?.createdAt ?? null, anchor?.id ?? null, limit + 1],
  );
  const page = rows.rows.slice(0, limit);
  const items = page.map(decode);
  const nextCursor =
    rows.rows.length > limit && page.length ? cursorData(query, page.at(-1)!) : null;
  return { ok: true, value: { items, nextCursor } };
}
async function history(
  options: MetricSnapshotStoreOptions,
  request: Readonly<{ query: MetricSnapshotQuery; limit: number; cursor: string | null }>,
): Promise<MetricResult<MetricHistoryPage>> {
  if (
    !exactKeys(request, ["query", "limit", "cursor"]) ||
    !validQuery(request?.query) ||
    !Number.isInteger(request?.limit) ||
    request.limit < 1 ||
    request.limit > 100 ||
    (request.cursor !== null && typeof request.cursor !== "string")
  )
    return failure("INVALID_INPUT");
  request = structuredClone(request);
  return transaction(options, request.query.binding, false, (client) =>
    historyStored(client, request.query, request.limit, request.cursor),
  );
}

export function createMetricSnapshotRepository(
  options: MetricSnapshotStoreOptions,
): MetricSnapshotStore {
  const actor = TenantContextSchema.safeParse(options?.actor);
  if (
    !actor.success ||
    typeof options?.pool?.connect !== "function" ||
    typeof options?.hasher?.create !== "function"
  )
    throw new TypeError("Invalid metric repository dependencies");
  const bound = { actor: actor.data, pool: options.pool, hasher: options.hasher };
  return Object.freeze({
    append: (value: MetricComputationV1) => append(bound, value),
    read: (query: MetricSnapshotQuery) => read(bound, query),
    byId: (request: Readonly<{ binding: ConnectorBinding; id: string }>) => byId(bound, request),
    history: (
      request: Readonly<{ query: MetricSnapshotQuery; limit: number; cursor: string | null }>,
    ) => history(bound, request),
  });
}

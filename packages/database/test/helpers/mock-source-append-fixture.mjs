import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { codecRecord, codecRecords } from "./mock-source-codec-fixture.mjs";
import {
  sourceTransaction,
  scopeValues,
  leaseOf,
  newScope,
  claim,
} from "./mock-source-lease-fixture.mjs";
import {
  createSourceSession,
  grantSource,
  scopeFor,
  configFor,
  hashConfig,
} from "./mock-platform-fixture.mjs";
import { rawInsert, rawValues } from "./mock-source-control-fixture.mjs";

export const eventSql = `INSERT INTO mock_platform."SourceEvent" ("sessionId",generation,"organizationId","workspaceId","storeId","connectionId","externalStoreId","releaseRevision",kind,"occurredAt",ordinal,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING *`;
export const versionSql = `INSERT INTO mock_platform."EntityVersion" ("sessionId",generation,"organizationId","workspaceId","storeId","connectionId","externalStoreId","releaseRevision","eventSeq") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`;
export const appendSql = `UPDATE mock_platform."BuildJob" SET checkpoint=$4::jsonb WHERE "sessionId"=$1 AND generation=$2 AND revision=$3 RETURNING *`;
const batchEventSql = `INSERT INTO mock_platform."SourceEvent" ("sessionId",generation,"organizationId","workspaceId","storeId","connectionId","externalStoreId","releaseRevision",kind,"occurredAt",ordinal,payload)
  SELECT $1,$2,$3,$4,$5,$6,$7,$8,value->>'kind',(value->>'occurredAt')::timestamp,(value->>'ordinal')::bigint,value->'after' FROM jsonb_array_elements($9::jsonb) WITH ORDINALITY AS input(value,position) ORDER BY position RETURNING *`;
const batchVersionSql = `INSERT INTO mock_platform."EntityVersion" ("sessionId",generation,"organizationId","workspaceId","storeId","connectionId","externalStoreId","releaseRevision","eventSeq")
  SELECT $1,$2,$3,$4,$5,$6,$7,$8,sequence FROM unnest($9::bigint[]) WITH ORDINALITY AS input(sequence,position) ORDER BY position RETURNING *`;
export const kinds = Object.keys(codecRecords);
export const utc = (value) => new Date(value).toISOString();
export const nextFor = (job, sealed = false) => ({ processedThrough: utc(job.targetTime), sealed });

export function eventFor(
  context,
  kind = "STORE",
  ordinal = "0",
  at = utc(context.job.targetTime),
  change,
) {
  const after = codecRecord(kind, (record) => {
    record.externalStoreId = context.scope.externalStoreId;
    record.source.updatedAt = at;
    if (change) change(record);
  });
  return { kind, occurredAt: at, ordinal, after };
}
export async function appendSettings(client, job, events, next, overrides = {}) {
  await client.query(
    "SELECT set_config('mock.expected_checkpoint_hash',$1,true),set_config('mock.source_append',$2,true)",
    [
      overrides.expected ?? job.checkpointHash,
      JSON.stringify(overrides.declaration ?? { eventCount: events.length, next }),
    ],
  );
}
export async function insertEvent(client, context, event) {
  return client.query(eventSql, [
    ...scopeValues(context.scope),
    context.job.revision,
    event.kind,
    event.occurredAt,
    event.ordinal,
    JSON.stringify(event.after),
  ]);
}
export async function insertVersion(client, context, sequence) {
  return client.query(versionSql, [...scopeValues(context.scope), context.job.revision, sequence]);
}
export async function insertBatch(client, context, events, versions = true, timings = {}) {
  const eventStarted = Date.now();
  const result = await client.query(batchEventSql, [
    ...scopeValues(context.scope),
    context.job.revision,
    JSON.stringify(events),
  ]);
  timings.eventMs = (timings.eventMs ?? 0) + Date.now() - eventStarted;
  const versionStarted = Date.now();
  if (versions)
    await client.query(batchVersionSql, [
      ...scopeValues(context.scope),
      context.job.revision,
      result.rows.map((event) => event.eventSeq),
    ]);
  timings.versionMs = (timings.versionMs ?? 0) + Date.now() - versionStarted;
  return result;
}
export async function batchAppend(
  client,
  context,
  batches,
  next = nextFor(context.job),
  declared = batches.flat().length,
  timings = {},
) {
  const started = Date.now();
  const result = await sourceTransaction(
    client,
    context.scope,
    "APPEND",
    async () => {
      await appendSettings(client, context.job, [], next, {
        declaration: { eventCount: declared, next },
      });
      for (const events of batches) await insertBatch(client, context, events, true, timings);
      const updateStarted = Date.now(),
        updated = await updateAppend(client, context, next);
      timings.updateMs = Date.now() - updateStarted;
      return updated;
    },
    leaseOf(context.job),
    context.grant,
  );
  timings.totalMs = Date.now() - started;
  timings.commitAndProtocolMs =
    timings.totalMs - timings.eventMs - timings.versionMs - timings.updateMs;
  return result;
}
export function largeProduct(context, index = 0) {
  return eventFor(context, "PRODUCT", "0", utc(context.job.targetTime), (record) => {
    record.externalProductId = `product-${String(index).padStart(3, "0")}`;
    record.skus = Array.from({ length: 24 }, (_, position) => ({
      ...record.skus[0],
      externalProductId: record.externalProductId,
      externalSkuId: `sku-${position}`,
      attributes: Array.from({ length: 30 }, (_, attribute) => ({
        name: String(attribute).padStart(3, "0") + "n".repeat(97),
        value: "v".repeat(200),
      })),
    }));
  });
}
export async function updateAppend(client, context, next) {
  return client.query(appendSql, [
    context.scope.sessionId,
    context.scope.generation,
    context.job.revision,
    JSON.stringify(next),
  ]);
}
export async function append(client, context, events, next = nextFor(context.job), options = {}) {
  return sourceTransaction(
    client,
    context.scope,
    "APPEND",
    async () => {
      await appendSettings(client, context.job, events, next, options);
      for (const event of events) {
        const result = await insertEvent(client, context, event);
        if (options.versions !== false && result.rows[0])
          await insertVersion(client, context, result.rows[0].eventSeq);
      }
      if (options.update !== false) return updateAppend(client, context, next);
      return null;
    },
    options.lease ?? leaseOf(context.job),
    options.grant ?? context.grant,
  );
}
export async function freshAppend(admin, worker, suffix, namespace) {
  const context =
    namespace === undefined
      ? await newScope(admin, worker, `append-${suffix}`)
      : await namespaceScope(admin, worker, suffix, namespace);
  const job = (await claim(worker, context)).rows[0];
  assert.ok(job);
  return { ...context, job };
}
async function namespaceScope(admin, worker, suffix, namespace) {
  const scope = {
    ...scopeFor(),
    storeId: `append-store-${suffix}`,
    sessionId: `append-session-${suffix}`,
    connectionId: `append-connection-${suffix}`,
    externalStoreId: namespace,
  };
  const grant = `append-grant-${suffix}`,
    config = configFor(scope),
    values = rawValues(scope);
  await createSourceSession(admin, scope);
  await grantSource(admin, scope, grant);
  values[7] = JSON.stringify(config);
  values[8] = hashConfig(config);
  await sourceTransaction(
    worker,
    scope,
    "CLAIM",
    () => worker.query(rawInsert, values),
    null,
    grant,
  );
  return { scope, grant };
}
export async function snapshot(admin, context) {
  const result = await admin.query(
    `SELECT (SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY generation,revision),'[]'::jsonb) FROM mock_platform."BuildJob" j WHERE "sessionId"=$1) AS jobs,
    (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY "eventSeq"),'[]'::jsonb) FROM mock_platform."SourceEvent" e WHERE "sessionId"=$1) AS events,
    (SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY "eventSeq"),'[]'::jsonb) FROM mock_platform."EntityVersion" v WHERE "sessionId"=$1) AS versions`,
    [context.scope.sessionId],
  );
  return result.rows[0];
}
export async function rejectedAppend(admin, worker, context, events, next, options, predicate) {
  const before = await snapshot(admin, context);
  await assert.rejects(append(worker, context, events, next, options), predicate);
  assert.deepEqual(await snapshot(admin, context), before);
}
export async function suppression(admin, table, action) {
  const names = {
    SourceEvent: 'mock_platform."SourceEvent"',
    EntityVersion: 'mock_platform."EntityVersion"',
    BuildJob: 'mock_platform."BuildJob"',
  };
  assert.ok(names[table]);
  await admin.query(
    "CREATE FUNCTION mock_platform.test_suppress_append() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$",
  );
  try {
    await admin.query(
      `CREATE TRIGGER zzz_test_suppress_append BEFORE ${table === "BuildJob" ? "UPDATE" : "INSERT"} ON ${names[table]} FOR EACH ROW EXECUTE FUNCTION mock_platform.test_suppress_append()`,
    );
    await action();
  } finally {
    await admin.query(`DROP TRIGGER IF EXISTS zzz_test_suppress_append ON ${names[table]}`);
    await admin.query("DROP FUNCTION mock_platform.test_suppress_append()");
  }
}
export const uniqueSuffix = () => randomUUID().slice(0, 8);

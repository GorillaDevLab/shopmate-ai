import assert from "node:assert/strict";
import { sourceTransaction, leaseOf } from "./mock-source-lease-fixture.mjs";
import { append, nextFor, snapshot } from "./mock-source-append-fixture.mjs";
import { operatorControl } from "./mock-source-control-fixture.mjs";

export const publishSql = `UPDATE mock_platform."BuildJob" SET state='PUBLISHED' WHERE "sessionId"=$1 AND generation=$2 AND revision=$3 RETURNING *`;
export const certificateColumns = `"organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,revision,"targetClockRevision","targetTime","baseRevision","baseHighEventSeq","highEventSeq","eventCount","versionCount","processedThrough","generatorVersion","runtimeVersion",codec,"publishedAt","certificateHash",state`;
export async function publishSettings(client, job, options = {}) {
  await client.query(
    "SELECT set_config('mock.expected_checkpoint_hash',$1,true),set_config('mock.expected_base_revision',$2,true)",
    [options.hash ?? job.checkpointHash, options.base ?? job.baseRevision],
  );
}
export async function updatePublish(client, context) {
  return client.query(publishSql, [
    context.scope.sessionId,
    context.scope.generation,
    context.job.revision,
  ]);
}
export async function publish(worker, context, options = {}) {
  return sourceTransaction(
    worker,
    context.scope,
    "PUBLISH",
    async () => {
      await publishSettings(worker, context.job, options);
      return updatePublish(worker, context);
    },
    options.lease ?? leaseOf(context.job),
    options.grant ?? context.grant,
  );
}
export async function seal(worker, context, events = []) {
  context.job = (await append(worker, context, events, nextFor(context.job, true))).rows[0];
  return context;
}
export async function readerTransaction(reader, context, action) {
  await reader.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await reader.query(
      "SELECT set_config('app.user_id',$1,true),set_config('app.merchant_id',$2,true)",
      ["source-human", context.scope.organizationId.replace("legacy-org-", "")],
    );
    const result = await action();
    await reader.query("COMMIT");
    return result;
  } catch (error) {
    await reader.query("ROLLBACK");
    throw error;
  }
}
export async function certificates(reader, context) {
  return readerTransaction(reader, context, () =>
    reader.query(
      `SELECT ${certificateColumns} FROM mock_platform."BuildJob" WHERE "sessionId"=$1 ORDER BY revision`,
      [context.scope.sessionId],
    ),
  );
}
export async function visibleVersions(reader, context) {
  return readerTransaction(reader, context, () =>
    reader.query(
      `SELECT * FROM mock_platform."EntityVersion" WHERE "sessionId"=$1 ORDER BY "eventSeq"`,
      [context.scope.sessionId],
    ),
  );
}
export async function rejectedPublish(admin, worker, context, predicate, options = {}) {
  const before = await snapshot(admin, context);
  await assert.rejects(publish(worker, context, options), predicate);
  assert.deepEqual(await snapshot(admin, context), before);
}
const tables = [
  'mock_platform."BuildJob"',
  'mock_platform."SourceEvent"',
  'mock_platform."EntityVersion"',
];
export async function operatorFacts(admin, action) {
  await admin.query("BEGIN");
  try {
    for (const table of tables) await admin.query(`ALTER TABLE ${table} DISABLE TRIGGER ALL`);
    const result = await action();
    for (const table of tables) await admin.query(`ALTER TABLE ${table} ENABLE TRIGGER ALL`);
    await admin.query("COMMIT");
    return result;
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}
export async function corruption(admin, context, mutate, action) {
  const original = await snapshot(admin, context);
  try {
    await operatorFacts(admin, mutate);
    await action();
  } finally {
    await operatorFacts(admin, async () => {
      for (const table of [...tables].reverse())
        await admin.query(`DELETE FROM ${table} WHERE "sessionId"=$1`, [context.scope.sessionId]);
      for (const [index, rows] of [original.jobs, original.events, original.versions].entries())
        await admin.query(
          `INSERT INTO ${tables[index]} SELECT * FROM jsonb_populate_recordset(NULL::${tables[index]},$1::jsonb)`,
          [JSON.stringify(rows)],
        );
    });
    assert.deepEqual(await snapshot(admin, context), original);
  }
}
export async function advance(admin, context, at) {
  return operatorControl(
    admin,
    'UPDATE demo."DemoCommerceSession" SET "clockNow"=$1::timestamp,"clockRevision"="clockRevision"+1,revision=revision+1 WHERE id=$2',
    [at, context.scope.sessionId],
    context.scope,
  );
}
export function publicationOf(job, scope) {
  return {
    scope,
    revision: job.revision,
    targetClockRevision: job.targetClockRevision,
    targetTime: job.targetTime.toISOString(),
    baseRevision: job.baseRevision,
    baseHighEventSeq: job.baseHighEventSeq,
    highEventSeq: job.highEventSeq,
    eventCount: job.eventCount,
    versionCount: job.versionCount,
    processedThrough: job.processedThrough.toISOString(),
    generatorVersion: job.generatorVersion,
    runtimeVersion: job.runtimeVersion,
    codec: job.codec,
    publishedAt: job.publishedAt.toISOString(),
  };
}
export async function deferredTamper(admin, action) {
  await admin.query(`CREATE FUNCTION mock_platform.test_tamper_publish() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
    BEGIN
      UPDATE mock_platform."SourceEvent" SET "envelopeHash"=repeat('a',64)
        WHERE "sessionId"=NEW."sessionId" AND generation=NEW.generation AND "releaseRevision"=NEW.revision AND "eventSeq"=NEW."highEventSeq";
      IF NOT FOUND THEN RAISE EXCEPTION 'Publication fixture did not tamper'; END IF;
      RETURN NEW;
    END $$`);
  try {
    await admin.query(
      'ALTER TABLE mock_platform."SourceEvent" DISABLE TRIGGER source_event_immutable',
    );
    await admin.query(
      'GRANT UPDATE("envelopeHash") ON mock_platform."SourceEvent" TO shopmate_mock_source_worker',
    );
    await admin.query(`CREATE POLICY test_publish_tamper ON mock_platform."SourceEvent" FOR UPDATE TO shopmate_mock_source_worker USING
      (mock_platform.has_worker_access("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation))`);
    await admin.query(
      "CREATE TRIGGER zzz_test_tamper_publish AFTER UPDATE ON mock_platform.\"BuildJob\" FOR EACH ROW WHEN (NEW.state='PUBLISHED') EXECUTE FUNCTION mock_platform.test_tamper_publish()",
    );
    await action();
  } finally {
    await admin.query('DROP TRIGGER IF EXISTS zzz_test_tamper_publish ON mock_platform."BuildJob"');
    await admin.query('DROP POLICY IF EXISTS test_publish_tamper ON mock_platform."SourceEvent"');
    await admin.query(
      'REVOKE UPDATE("envelopeHash") ON mock_platform."SourceEvent" FROM shopmate_mock_source_worker',
    );
    await admin.query(
      'ALTER TABLE mock_platform."SourceEvent" ENABLE TRIGGER source_event_immutable',
    );
    await admin.query("DROP FUNCTION mock_platform.test_tamper_publish()");
  }
}

import assert from "node:assert/strict";
import pg from "pg";

export async function measuredHydration(t, expectedSql, action) {
  const original = pg.Client.prototype.query,
    plans = [];
  const spy = t.mock.method(pg.Client.prototype, "query", async function (sql, ...args) {
    if (sql === expectedSql) {
      const result = await original.call(
        this,
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
        ...args,
      );
      plans.push(result.rows[0]["QUERY PLAN"][0]);
    }
    return original.call(this, sql, ...args);
  });
  try {
    return { result: await action(), plans };
  } finally {
    spy.mock.restore();
  }
}
function nodes(plan) {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}
export function assertPointPlans(plans) {
  assert.equal(plans.length, 100);
  for (const plan of plans) {
    const versions = nodes(plan.Plan).filter((node) => node["Relation Name"] === "EntityVersion");
    assert.equal(versions.length, 1);
    assert.ok(versions[0]["Index Cond"]?.includes('"entityKey"'), JSON.stringify(plan));
    assert.ok(versions[0]["Index Cond"].includes('"occurredAt" <'), JSON.stringify(plan));
    assert.ok(versions[0]["Actual Rows"] <= 1);
    assert.equal(versions[0]["Rows Removed by Filter"] ?? 0, 0);
  }
}
export async function addOldHistory(admin, state) {
  // Isolated planner stress fixture only: old synthetic versions precede every
  // real point result. No runtime proof is relaxed outside corruption().
  await admin.query(
    `INSERT INTO mock_platform."EntityVersion"
    SELECT (jsonb_populate_record(NULL::mock_platform."EntityVersion",to_jsonb(v)||
      jsonb_build_object('eventSeq',1000+v."eventSeq"*4000+n,'occurredAt',v."occurredAt"-interval '1 day'))).*
    FROM mock_platform."EntityVersion" v CROSS JOIN generate_series(1,4000) n
    WHERE v."sessionId"=$1 AND v.generation=$2`,
    [state.scope.sessionId, state.scope.generation],
  );
  // Model a large committed prefix as well: a six-event high watermark would
  // correctly make the primary-key prefix cheaper than a historical seek.
  await admin.query(
    `UPDATE mock_platform."BuildJob" j SET "highEventSeq"=29000,"eventCount"=29000,
      "versionCount"=29000,checkpoint=jsonb_set(checkpoint,'{highEventSeq}','"29000"'::jsonb)
      WHERE "sessionId"=$1 AND generation=$2 AND revision=$3`,
    [state.scope.sessionId, state.scope.generation, state.lease.revision],
  );
  const result = await admin.query(
    `UPDATE mock_platform."BuildJob" j SET "checkpointHash"=mock_platform.hash_jsonb(jsonb_build_object(
      'codec','source-checkpoint-hash-v1','scope',mock_platform.source_scope(to_jsonb(j)),
      'revision',revision::text,'checkpoint',checkpoint))
      WHERE "sessionId"=$1 AND generation=$2 AND revision=$3 RETURNING "checkpointHash"`,
    [state.scope.sessionId, state.scope.generation, state.lease.revision],
  );
  state.hash = result.rows[0].checkpointHash;
}

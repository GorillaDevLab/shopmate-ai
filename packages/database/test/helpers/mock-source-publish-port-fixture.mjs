import assert from "node:assert/strict";
import { fullSnapshot } from "./mock-source-control-race-fixture.mjs";
import { preparedAppend, chunkFor } from "./mock-source-append-port-fixture.mjs";
export async function sealedPublication(context, kinds = [], namespace) {
  const state = await preparedAppend(context, namespace);
  const appended = await context.worker.appendChunk(
    state.actor,
    state.lease,
    chunkFor(state, kinds, true),
  );
  assert.equal(appended.status, "COMMITTED");
  state.input = {
    expectedBaseRevision: state.lease.baseRevision,
    checkpointHash: appended.checkpointHash,
  };
  return state;
}
export async function unchangedPublication(
  context,
  state,
  expected,
  lease = state.lease,
  input = state.input,
  actor = state.actor,
) {
  const before = await fullSnapshot(context.admin, state);
  const action = () => context.worker.publish(actor, lease, input);
  if (typeof expected === "string")
    await assert.rejects(action, { code: expected, message: expected });
  else assert.deepEqual(await action(), expected);
  assert.deepEqual(await fullSnapshot(context.admin, state), before);
}

// The reviewed isolated own-certificate-hole fixture; runtime guards stay enabled outside corruption().
export async function installLaterCertificate(admin, state) {
  return admin.query(
    `WITH shaped AS (SELECT jsonb_populate_record(NULL::mock_platform."BuildJob",to_jsonb(j)||
    jsonb_build_object('revision',2,'targetClockRevision',1,'baseRevision',1,'baseHighEventSeq',j."highEventSeq",'eventCount',0,'versionCount',0,'state','PUBLISHED','publishedAt',clock_timestamp(),'certificateHash',repeat('a',64))) AS job
    FROM mock_platform."BuildJob" j WHERE "sessionId"=$1), certified AS
    (SELECT jsonb_populate_record(job,jsonb_build_object('certificateHash',mock_platform.hash_jsonb(jsonb_build_object('codec','source-certificate-v1','certificate',mock_platform.publication_certificate(job))))) AS job FROM shaped)
    INSERT INTO mock_platform."BuildJob" SELECT (job).* FROM certified`,
    [state.scope.sessionId],
  );
}

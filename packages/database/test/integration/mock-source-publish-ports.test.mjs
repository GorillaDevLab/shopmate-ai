import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import pg from "pg";
import {
  leasePortDatabase,
  closeLeasePortDatabase,
  deferredFailure,
  waitForLeaseExpiry,
  deferredLeaseExpiry,
} from "../helpers/mock-source-lease-port-fixture.mjs";
import { preparedAppend, chunkFor } from "../helpers/mock-source-append-port-fixture.mjs";
import { readerActor, grantSource, scopeFor } from "../helpers/mock-platform-fixture.mjs";
import {
  sealedPublication,
  unchangedPublication,
  installLaterCertificate,
} from "../helpers/mock-source-publish-port-fixture.mjs";
import { corruption, advance, visibleVersions } from "../helpers/mock-source-publish-fixture.mjs";
import { suppression } from "../helpers/mock-source-append-fixture.mjs";
import { kinds } from "../helpers/mock-source-append-fixture.mjs";
import { fullSnapshot } from "../helpers/mock-source-control-race-fixture.mjs";
const source = await import("../../dist/src/mock-platform/index.js");
let context;
let reader;
let rawReader;
test.before(async () => {
  context = await leasePortDatabase(source, "publish");
  reader = source.createMockSourceReader(context.env);
  rawReader = new pg.Client({ connectionString: context.env.MOCK_PLATFORM_READ_DATABASE_URL });
  await rawReader.connect();
});
test.after(async () => {
  await reader.close();
  await rawReader.end();
  await closeLeasePortDatabase(context);
});

async function sealedState(kinds = []) {
  return sealedPublication(context, kinds);
}

test("official publish commits a sealed empty prefix and returns its immutable certificate", async () => {
  const state = await sealedState();
  const result = await context.worker.publish(state.actor, state.lease, state.input);
  assert.equal(result.status, "PUBLISHED");
  assert.equal(result.publication.eventCount, "0");
  assert.deepEqual(result.publication.scope, state.scope);
});

test("published exact retry is immutable after natural expiry and worker reader recreation", async () => {
  const state = await sealedState(["STORE"]);
  const result = await context.worker.publish(state.actor, state.lease, state.input);
  assert.equal(result.status, "PUBLISHED");
  await waitForLeaseExpiry(context.admin, state.lease);
  await context.worker.close();
  context.worker = source.createMockSourceWorker(context.env);
  await reader.close();
  reader = source.createMockSourceReader(context.env);
  await unchangedPublication(context, state, {
    status: "ALREADY_PUBLISHED",
    publication: result.publication,
  });
  assert.deepEqual(await reader.findPublication(readerActor, state.scope), result.publication);
  for (const [key, value] of [
    ["fence", "2"],
    ["revision", "2"],
    ["ownerId", "00000000-0000-4000-8000-000000000000"],
  ])
    await unchangedPublication(
      context,
      state,
      { status: "FENCED" },
      { ...state.lease, [key]: value },
    );
  await grantSource(context.admin, state.scope, `${state.actor.grantId}-other`);
  await unchangedPublication(context, state, { status: "FENCED" }, state.lease, state.input, {
    grantId: `${state.actor.grantId}-other`,
  });
});

for (const published of [false, true]) {
  for (const [key, value] of [
    ["expectedBaseRevision", "1"],
    ["checkpointHash", "a".repeat(64)],
  ]) {
    test(`${published ? "published" : "building"} changed ${key} conflicts without writes`, async () => {
      const state = await sealedState();
      if (published)
        assert.equal(
          (await context.worker.publish(state.actor, state.lease, state.input)).status,
          "PUBLISHED",
        );
      await unchangedPublication(context, state, { status: "CONFLICT" }, state.lease, {
        ...state.input,
        [key]: value,
      });
    });
  }
}

test("unsealed target frontier cannot publish and missing matching lease is fenced", async () => {
  const state = await preparedAppend(context);
  const appended = await context.worker.appendChunk(
    state.actor,
    state.lease,
    chunkFor(state, ["STORE"]),
  );
  state.input = { expectedBaseRevision: "0", checkpointHash: appended.checkpointHash };
  await unchangedPublication(context, state, { status: "CONFLICT" });
  await unchangedPublication(
    context,
    state,
    { status: "FENCED" },
    { ...state.lease, revision: "2" },
  );
});

test("suppressed publication update fails exact count and rolls back all state", async () => {
  const state = await sealedState(["STORE"]);
  await suppression(context.admin, "BuildJob", () =>
    unchangedPublication(context, state, "SOURCE_INTEGRITY"),
  );
  assert.equal(await reader.findPublication(readerActor, state.scope), null);
});

for (const [code, expected] of [
  ["SM001", { status: "DENIED" }],
  ["SM003", { status: "FENCED" }],
  ["SM004", { status: "CONFLICT" }],
  ["SM005", "SOURCE_INTEGRITY"],
  ["23514", "SOURCE_STORAGE"],
]) {
  test(`deferred publication ${code} returns only after complete rollback`, async () => {
    const state = await sealedState(["STORE"]);
    await deferredFailure(context.admin, code, () =>
      unchangedPublication(context, state, expected),
    );
    assert.equal(await reader.findPublication(readerActor, state.scope), null);
    assert.equal(
      (await context.worker.publish(state.actor, state.lease, state.input)).status,
      "PUBLISHED",
    );
  });
}

test("publication whole-job proof rejects missing accepted version", async () => {
  const state = await sealedState(["STORE", "PRODUCT"]);
  await corruption(
    context.admin,
    state,
    () =>
      context.admin.query(
        'DELETE FROM mock_platform."EntityVersion" WHERE "sessionId"=$1 AND "eventSeq"=1',
        [state.scope.sessionId],
      ),
    () => unchangedPublication(context, state, "SOURCE_INTEGRITY"),
  );
});

test("deferred publication observes actual thirty-second lease expiry and rolls back its certificate", async () => {
  const state = await sealedState(["STORE"]);
  const renewed = await context.worker.renew(state.actor, state.lease);
  assert.equal(renewed.status, "RENEWED");
  state.lease = renewed.lease;
  await deferredLeaseExpiry(context.admin, () =>
    unchangedPublication(context, state, { status: "FENCED" }),
  );
  assert.equal(await reader.findPublication(readerActor, state.scope), null);
  const takeover = await context.worker.claim(state.actor, state.scope);
  assert.equal(takeover.status, "CLAIMED");
  assert.equal(
    (await context.worker.publish(state.actor, takeover.lease, state.input)).status,
    "PUBLISHED",
  );
});

for (const [name, mutation] of [
  ["certificate hash", "\"certificateHash\"=repeat('a',64)"],
  ["DTO timestamp with a matching DB hash", "\"publishedAt\"='10000-01-01T00:00:00Z'::timestamptz"],
]) {
  test(`reader and published retry fail closed on malformed stored ${name}`, async () => {
    const state = await sealedState(["STORE"]);
    assert.equal(
      (await context.worker.publish(state.actor, state.lease, state.input)).status,
      "PUBLISHED",
    );
    await corruption(
      context.admin,
      state,
      async () => {
        if (name === "certificate hash")
          await context.admin.query(
            `UPDATE mock_platform."BuildJob" SET ${mutation} WHERE "sessionId"=$1`,
            [state.scope.sessionId],
          );
        else
          await context.admin.query(
            `UPDATE mock_platform."BuildJob" j SET ${mutation},"certificateHash"=mock_platform.hash_jsonb(
        jsonb_build_object('codec','source-certificate-v1','certificate',mock_platform.publication_certificate(j)||
        jsonb_build_object('publishedAt','10000-01-01T00:00:00.000Z'))) WHERE "sessionId"=$1`,
            [state.scope.sessionId],
          );
      },
      async () => {
        await assert.rejects(reader.findPublication(readerActor, state.scope), {
          code: "SOURCE_INTEGRITY",
          message: "SOURCE_INTEGRITY",
        });
        await unchangedPublication(context, state, "SOURCE_INTEGRITY");
      },
    );
  });
}

test("one reader pool isolates merchant identities and recovers from denial", async () => {
  const state = await sealedState();
  const result = await context.worker.publish(state.actor, state.lease, state.input);
  assert.equal(
    await reader.findPublication({ ...readerActor, merchantId: "source-merchant-b" }, state.scope),
    null,
  );
  assert.equal(
    await reader.findPublication({ ...readerActor, userId: "missing-reader" }, state.scope),
    null,
  );
  assert.equal(
    await reader.findPublication(readerActor, { ...state.scope, externalStoreId: "changed" }),
    null,
  );
  assert.deepEqual(await reader.findPublication(readerActor, state.scope), result.publication);
  assert.equal(await reader.findPublication(readerActor, scopeFor("b")), null);
  assert.deepEqual(await reader.findPublication(readerActor, state.scope), result.publication);
});

test("current grant revocation denies published retry while independent reader remains authorized", async () => {
  const state = await sealedState();
  const result = await context.worker.publish(state.actor, state.lease, state.input);
  await context.admin.query("UPDATE demo.\"MockWorkerGrant\" SET status='REVOKED' WHERE id=$1", [
    state.actor.grantId,
  ]);
  await unchangedPublication(context, state, { status: "DENIED" });
  assert.deepEqual(await reader.findPublication(readerActor, state.scope), result.publication);
});

test("advance after claim preserves frozen target then reader selects next published revision", async () => {
  const state = await sealedState(["STORE"]);
  await advance(context.admin, state, "2026-01-01T00:00:00.000Z");
  const first = await context.worker.publish(state.actor, state.lease, state.input);
  assert.equal(first.publication.targetTime, state.lease.targetTime);
  const claimed = await context.worker.claim(state.actor, state.scope);
  assert.equal(claimed.status, "CLAIMED");
  const next = { ...state, lease: claimed.lease };
  const appended = await context.worker.appendChunk(
    next.actor,
    next.lease,
    chunkFor(next, [], true),
  );
  const second = await context.worker.publish(next.actor, next.lease, {
    expectedBaseRevision: "1",
    checkpointHash: appended.checkpointHash,
  });
  assert.equal(second.publication.revision, "2");
  assert.deepEqual(await reader.findPublication(readerActor, state.scope), second.publication);
  await unchangedPublication(context, state, {
    status: "ALREADY_PUBLISHED",
    publication: first.publication,
  });
});

for (const namespace of ["商".repeat(200), "e\u0301".repeat(100), "\u{1f600}".repeat(100)]) {
  test(`official six-stream publication preserves Unicode namespace ${namespace.length}/${Buffer.byteLength(namespace)}`, async () => {
    const state = await sealedPublication(context, kinds, namespace);
    const result = await context.worker.publish(state.actor, state.lease, state.input);
    assert.equal(result.status, "PUBLISHED");
    assert.equal(result.publication.scope.externalStoreId, namespace);
    assert.deepEqual(await reader.findPublication(readerActor, state.scope), result.publication);
    assert.equal((await visibleVersions(rawReader, state)).rowCount, 6);
    if (namespace.normalize("NFC") !== namespace)
      assert.equal(
        await reader.findPublication(readerActor, {
          ...state.scope,
          externalStoreId: namespace.normalize("NFC"),
        }),
        null,
      );
  });
}

test("official certificate reader hides staged facts then reads nonempty publication", async () => {
  const state = await sealedState(["STORE", "PRODUCT"]);
  assert.equal(await reader.findPublication(readerActor, state.scope), null);
  const result = await context.worker.publish(state.actor, state.lease, state.input);
  assert.equal(result.status, "PUBLISHED");
  assert.equal(result.publication.eventCount, "2");
  assert.deepEqual(await reader.findPublication(readerActor, state.scope), result.publication);
});

test("reader requires each version's own certificate despite a later published head", async () => {
  const state = await sealedState(["STORE"]);
  await corruption(
    context.admin,
    state,
    () => installLaterCertificate(context.admin, state),
    async () => {
      const publication = await reader.findPublication(readerActor, state.scope);
      assert.equal(publication.revision, "2");
      assert.equal(publication.eventCount, "0");
      assert.equal((await visibleVersions(rawReader, state)).rowCount, 0);
      assert.equal((await fullSnapshot(context.admin, state)).versions.length, 1);
      await unchangedPublication(context, state, "SOURCE_INTEGRITY");
    },
  );
});

test("reader certificate succeeds with no permission on worker certificate helper or private job columns", async () => {
  const state = await sealedState();
  const published = await context.worker.publish(state.actor, state.lease, state.input);
  await assert.rejects(rawReader.query('SELECT checkpoint FROM mock_platform."BuildJob"'), {
    code: "42501",
  });
  await assert.rejects(
    rawReader.query('SELECT mock_platform.publication_certificate(NULL::mock_platform."BuildJob")'),
    { code: "42501" },
  );
  assert.deepEqual(await reader.findPublication(readerActor, state.scope), published.publication);
  assert.deepEqual(
    Object.keys(published.publication).sort(),
    [
      "scope",
      "revision",
      "targetClockRevision",
      "targetTime",
      "baseRevision",
      "baseHighEventSeq",
      "highEventSeq",
      "eventCount",
      "versionCount",
      "processedThrough",
      "generatorVersion",
      "runtimeVersion",
      "codec",
      "publishedAt",
      "certificateHash",
    ].sort(),
  );
});

test("failed takeover publishes with new reference and fences its predecessor", async () => {
  const state = await sealedState(["STORE"]);
  assert.equal(
    (await context.worker.fail(state.actor, state.lease, "INTERRUPTED")).status,
    "FAILED",
  );
  const takeover = await context.worker.claim(state.actor, state.scope);
  assert.equal(takeover.status, "CLAIMED");
  assert.equal(takeover.lease.revision, state.lease.revision);
  await unchangedPublication(context, state, { status: "FENCED" });
  const result = await context.worker.publish(state.actor, takeover.lease, state.input);
  assert.equal(result.status, "PUBLISHED");
  assert.deepEqual(await reader.findPublication(readerActor, state.scope), result.publication);
});

test("all seven scope coordinates remain bound for publication and reader lookup", async () => {
  const state = await sealedState();
  for (const field of Object.keys(state.scope)) {
    const scope = { ...state.scope, [field]: field === "generation" ? 1 : `other-${field}` };
    await unchangedPublication(context, state, { status: "DENIED" }, { ...state.lease, scope });
    assert.equal(await reader.findPublication(readerActor, scope), null);
  }
  assert.equal(
    (await context.worker.publish(state.actor, state.lease, state.input)).status,
    "PUBLISHED",
  );
});

for (const published of [false, true]) {
  for (const change of ["reset", "disconnect"]) {
    test(`${change} denies ${published ? "published retry" : "new publication"} and hides old reader certificate`, async () => {
      const state = await sealedState(["STORE"]);
      if (published)
        assert.equal(
          (await context.worker.publish(state.actor, state.lease, state.input)).status,
          "PUBLISHED",
        );
      if (change === "reset")
        await context.admin.query(
          'UPDATE public."PlatformConnection" SET generation=generation+1 WHERE id=$1',
          [state.scope.connectionId],
        );
      else
        await context.admin.query(
          "UPDATE public.\"PlatformConnection\" SET status='DISCONNECTED' WHERE id=$1",
          [state.scope.connectionId],
        );
      await unchangedPublication(context, state, { status: "DENIED" });
      assert.equal(await reader.findPublication(readerActor, state.scope), null);
    });
  }
}

test("one reader pool switches between authorized merchants without retaining the prior identity", async () => {
  const first = await sealedState();
  const firstResult = await context.worker.publish(first.actor, first.lease, first.input);
  const scope = scopeFor("b"),
    actor = { grantId: "source-grant-b" };
  assert.equal((await context.worker.initializeGeneration(actor, scope)).status, "CREATED");
  const claimed = await context.worker.claim(actor, scope);
  const second = { scope, actor, lease: claimed.lease };
  const appended = await context.worker.appendChunk(
    actor,
    claimed.lease,
    chunkFor(second, [], true),
  );
  const secondResult = await context.worker.publish(actor, claimed.lease, {
    expectedBaseRevision: "0",
    checkpointHash: appended.checkpointHash,
  });
  const secondActor = { ...readerActor, merchantId: "source-merchant-b" };
  assert.deepEqual(await reader.findPublication(secondActor, scope), secondResult.publication);
  assert.equal(await reader.findPublication(secondActor, first.scope), null);
  assert.deepEqual(await reader.findPublication(readerActor, first.scope), firstResult.publication);
  assert.equal(await reader.findPublication(readerActor, scope), null);
  assert.deepEqual(await reader.findPublication(secondActor, scope), secondResult.publication);
});

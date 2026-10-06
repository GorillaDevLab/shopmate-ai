import assert from "node:assert/strict";
import test from "node:test";
import {
  leasePortDatabase,
  closeLeasePortDatabase,
  deferredFailure,
  deferredLeaseExpiry,
  waitForLeaseExpiry,
} from "../helpers/mock-source-lease-port-fixture.mjs";
import {
  preparedAppend,
  chunkFor,
  sdkAppend,
  unchangedAppend,
  renewAppend,
  rawPublishAppend,
  simulatedLostAppendAcknowledgment,
} from "../helpers/mock-source-append-port-fixture.mjs";
import { kinds, snapshot, suppression } from "../helpers/mock-source-append-fixture.mjs";
import { fullSnapshot } from "../helpers/mock-source-control-race-fixture.mjs";
import { codecSchemas } from "../helpers/mock-source-codec-fixture.mjs";
import * as schemas from "../../../contracts/dist/index.js";
import { corruption, advance, visibleVersions } from "../helpers/mock-source-publish-fixture.mjs";
import { eventFor } from "../helpers/mock-source-append-fixture.mjs";
import { grantSource, loginUrl } from "../helpers/mock-platform-fixture.mjs";
import pg from "pg";
const source = await import("../../dist/src/mock-platform/index.js");
let context;
test.before(async () => {
  context = await leasePortDatabase(source, "append");
});
test.after(async () => closeLeasePortDatabase(context));

test("official append derives six records and exact latest receipt after committed acknowledgment loss", async () => {
  const state = await preparedAppend(context);
  const input = chunkFor(state, kinds, true);
  await assert.rejects(simulatedLostAppendAcknowledgment(context, state, input), {
    message: "TEST_APPEND_ACKNOWLEDGMENT_LOST",
  });
  const rows = await snapshot(context.admin, state);
  assert.equal(rows.events.length, 6);
  assert.equal(rows.versions.length, 6);
  for (const [index, event] of rows.events.entries()) {
    assert.equal(event.payload.source.version, `mock-runtime-v2:g:0:e:${index + 1}`);
    assert.deepEqual(event.payload, rows.versions[index].payload);
    assert.ok(schemas[codecSchemas[event.kind]].safeParse(event.payload).success);
  }
  const job = rows.jobs[0];
  await unchangedAppend(context, state, input, {
    status: "ALREADY_COMMITTED",
    checkpoint: job.checkpoint,
    checkpointHash: job.checkpointHash,
  });
});

const receiptChanges = [
  [
    "kind",
    (input, state) => {
      input.events = chunkFor(state, ["PRODUCT"]).events;
    },
  ],
  [
    "occurredAt",
    (input) => {
      input.events[0].occurredAt = "2025-12-31T15:59:59.999Z";
      input.events[0].after.source.updatedAt = input.events[0].occurredAt;
    },
  ],
  [
    "ordinal",
    (input) => {
      input.events[0].ordinal = "1";
    },
  ],
  [
    "entity key",
    (input) => {
      input.events[0].after.externalProductId = "changed-product";
      input.events[0].after.skus[0].externalProductId = "changed-product";
    },
  ],
  [
    "payload",
    (input) => {
      input.events[0].after.name = "Changed store";
    },
  ],
  [
    "quality",
    (input) => {
      input.events[0].after.source.quality = { state: "PARTIAL", issues: ["SOURCE_INCONSISTENT"] };
    },
  ],
  [
    "proposal",
    (input) => {
      input.next.sealed = true;
    },
  ],
  [
    "count",
    (input) => {
      input.events = [];
    },
  ],
  [
    "expected hash",
    (input) => {
      input.expectedCheckpointHash = "a".repeat(64);
    },
  ],
];
for (const [label, mutate] of receiptChanges)
  test(`official latest receipt rejects changed ${label} with exact rollback`, async () => {
    const state = await preparedAppend(context);
    const input = chunkFor(state, label === "entity key" ? ["PRODUCT"] : ["STORE"]);
    const committed = await sdkAppend(context, state, input);
    assert.equal(committed.status, "COMMITTED");
    const changed = globalThis.structuredClone(input);
    mutate(changed, state);
    await unchangedAppend(context, state, changed, { status: "CONFLICT" });
    await unchangedAppend(context, state, input, { ...committed, status: "ALREADY_COMMITTED" });
  });

test("latest retry remains exact after renew and FAILED takeover while old fences are rejected", async () => {
  const state = await preparedAppend(context);
  const input = chunkFor(state);
  const committed = await sdkAppend(context, state, input);
  const old = state.lease;
  await renewAppend(context, state);
  await unchangedAppend(context, state, input, { ...committed, status: "ALREADY_COMMITTED" });
  assert.deepEqual(await context.worker.fail(state.actor, state.lease, "INTERRUPTED"), {
    status: "FAILED",
  });
  const claimed = await context.worker.claim(state.actor, state.scope);
  assert.equal(claimed.status, "CLAIMED");
  state.lease = claimed.lease;
  await unchangedAppend(context, state, input, { status: "FENCED" }, old);
  await unchangedAppend(context, state, input, { ...committed, status: "ALREADY_COMMITTED" });
  const next = chunkFor(state);
  next.events[0].ordinal = "1";
  assert.equal((await sdkAppend(context, state, next)).status, "COMMITTED");
  const rows = await snapshot(context.admin, state);
  assert.equal(rows.events[0].acceptedFence, 1);
  assert.equal(rows.events[1].acceptedFence, 2);
  await unchangedAppend(context, state, input, { status: "CONFLICT" });
});

test("zero event progress and exact empty seal work while no-progress conflicts", async () => {
  const state = await preparedAppend(context, "mock/store.1", "2026-01-01T16:00:00.000Z");
  const unchanged = chunkFor(state, []);
  unchanged.next.processedThrough = state.lease.checkpoint.processedThrough;
  await unchangedAppend(context, state, unchanged, { status: "CONFLICT" });
  const progress = chunkFor(state, []);
  const committed = await sdkAppend(context, state, progress);
  assert.equal(committed.status, "COMMITTED");
  await unchangedAppend(context, state, progress, { ...committed, status: "ALREADY_COMMITTED" });
  const seal = {
    ...progress,
    expectedCheckpointHash: committed.checkpointHash,
    next: { ...progress.next, sealed: true },
  };
  const sealed = await sdkAppend(context, state, seal);
  assert.equal(sealed.status, "COMMITTED");
  await unchangedAppend(context, state, seal, { ...sealed, status: "ALREADY_COMMITTED" });
  assert.deepEqual((await snapshot(context.admin, state)).events, []);
});

test("target-time tuples split across unsealed chunks and sealed latest retries survive recreation", async () => {
  const state = await preparedAppend(context);
  const first = chunkFor(state);
  const committed = await sdkAppend(context, state, first);
  const next = chunkFor(state);
  next.expectedCheckpointHash = committed.checkpointHash;
  next.events[0].ordinal = "1";
  next.next.sealed = true;
  const sealed = await sdkAppend(context, state, next);
  assert.equal(sealed.status, "COMMITTED");
  assert.equal(sealed.checkpoint.lastEvent.ordinal, "1");
  await unchangedAppend(context, state, first, { status: "CONFLICT" });
  await context.worker.close();
  context.worker = source.createMockSourceWorker(context.env);
  await unchangedAppend(context, state, next, { ...sealed, status: "ALREADY_COMMITTED" });
  const fresh = { ...next, expectedCheckpointHash: sealed.checkpointHash };
  await unchangedAppend(context, state, fresh, { status: "CONFLICT" });
});

for (const table of ["SourceEvent", "EntityVersion", "BuildJob"])
  test(`official append requires an exact ${table} write count`, async () => {
    const state = await preparedAppend(context);
    const input = chunkFor(state);
    await suppression(context.admin, table, () =>
      unchangedAppend(context, state, input, "SOURCE_INTEGRITY"),
    );
    assert.equal((await sdkAppend(context, state, input)).status, "COMMITTED");
  });

for (const [code, expected] of [
  ["SM001", { status: "DENIED" }],
  ["SM003", { status: "FENCED" }],
  ["SM004", { status: "CONFLICT" }],
  ["SM005", "SOURCE_INTEGRITY"],
  ["SM002", "SOURCE_STORAGE"],
  ["40P01", "SOURCE_STORAGE"],
  ["ZZ999", "SOURCE_STORAGE"],
])
  test(`official append deferred ${code} rolls back inserted facts and checkpoint`, async () => {
    const state = await preparedAppend(context);
    const input = chunkFor(state);
    await deferredFailure(context.admin, code, () =>
      unchangedAppend(context, state, input, expected),
    );
    assert.equal((await sdkAppend(context, state, input)).status, "COMMITTED");
  });

test("official append requires current actor grant and full scope for receipt authority", async () => {
  const state = await preparedAppend(context);
  const input = chunkFor(state, ["STORE"], true);
  const committed = await sdkAppend(context, state, input);
  for (const field of [
    "organizationId",
    "workspaceId",
    "storeId",
    "sessionId",
    "connectionId",
    "externalStoreId",
    "generation",
  ]) {
    const scope = { ...state.scope, [field]: field === "generation" ? 1 : `other-${field}` };
    const boundInput = globalThis.structuredClone(input);
    boundInput.events[0].after.externalStoreId = scope.externalStoreId;
    await unchangedAppend(
      context,
      state,
      boundInput,
      { status: "DENIED" },
      { ...state.lease, scope },
    );
  }
  await unchangedAppend(context, state, input, { status: "DENIED" }, state.lease, {
    grantId: "missing-grant",
  });
  const grantId = `${state.actor.grantId}-other`;
  await grantSource(context.admin, state.scope, grantId);
  await unchangedAppend(context, state, input, { status: "FENCED" }, state.lease, { grantId });
  await unchangedAppend(
    context,
    state,
    input,
    { status: "FENCED" },
    { ...state.lease, revision: "2" },
  );
  await unchangedAppend(context, state, input, { ...committed, status: "ALREADY_COMMITTED" });
});

test("first-job inclusive boundaries and later published frontier use the real CONTROL clock", async () => {
  const state = await preparedAppend(context, "mock/store.1", "2026-01-01T16:00:00.000Z");
  const input = chunkFor(state);
  const opening = eventFor(
    { scope: state.scope },
    "STORE",
    "0",
    state.lease.checkpoint.processedThrough,
  );
  input.events = [opening, input.events[0]];
  input.next.sealed = true;
  const committed = await sdkAppend(context, state, input);
  assert.equal(committed.status, "COMMITTED");
  const published = await rawPublishAppend(context, state);
  await advance(context.admin, state, "2026-01-02T16:00:00.000Z");
  state.lease = (await context.worker.claim(state.actor, state.scope)).lease;
  const next = chunkFor(state);
  next.events[0].occurredAt = input.next.processedThrough;
  next.events[0].after.source.updatedAt = next.events[0].occurredAt;
  await unchangedAppend(context, state, next, { status: "CONFLICT" });
  next.events = chunkFor(state).events;
  next.next.sealed = true;
  assert.equal((await sdkAppend(context, state, next)).status, "COMMITTED");
  assert.deepEqual(
    (await snapshot(context.admin, state)).jobs[0].certificateHash,
    published.certificateHash,
  );
});

test(
  "genuine expiry takeover retries with new lease and fences the old reference",
  { timeout: 60000 },
  async () => {
    const state = await preparedAppend(context);
    const input = chunkFor(state);
    const committed = await sdkAppend(context, state, input);
    const old = state.lease;
    await waitForLeaseExpiry(context.admin, old);
    await unchangedAppend(context, state, input, { status: "FENCED" }, old);
    const claimed = await context.worker.claim(state.actor, state.scope);
    assert.equal(claimed.status, "CLAIMED");
    state.lease = claimed.lease;
    await unchangedAppend(context, state, input, { ...committed, status: "ALREADY_COMMITTED" });
    await unchangedAppend(context, state, input, { status: "FENCED" }, old);
  },
);

test(
  "genuine deferred append lease expiry rolls back all newly inserted facts",
  { timeout: 60000 },
  async () => {
    const state = await preparedAppend(context);
    const input = chunkFor(state);
    const before = await fullSnapshot(context.admin, state);
    const result = await deferredLeaseExpiry(context.admin, () => sdkAppend(context, state, input));
    assert.deepEqual(result, { status: "FENCED" });
    assert.deepEqual(await fullSnapshot(context.admin, state), before);
    const claimed = await context.worker.claim(state.actor, state.scope);
    assert.equal(claimed.status, "CLAIMED");
    state.lease = claimed.lease;
    assert.equal((await sdkAppend(context, state, input)).status, "COMMITTED");
  },
);

for (const namespace of [
  "商".repeat(200),
  String.fromCodePoint(0x65, 0x301).repeat(100),
  "😀".repeat(100),
])
  test(`official six-stream append preserves ${namespace.length} UTF16 units through reviewed raw publication`, async () => {
    const state = await preparedAppend(context, namespace);
    const input = chunkFor(state, kinds, true);
    const committed = await sdkAppend(context, state, input);
    assert.equal(committed.status, "COMMITTED");
    await unchangedAppend(context, state, input, { ...committed, status: "ALREADY_COMMITTED" });
    const reader = new pg.Client({
      connectionString: loginUrl(context.env.MOCK_PLATFORM_READ_DATABASE_URL, "source_read_login"),
    });
    await reader.connect();
    try {
      assert.equal((await visibleVersions(reader, state)).rowCount, 0);
      await rawPublishAppend(context, state);
      const visible = await visibleVersions(reader, state);
      assert.equal(visible.rowCount, 6);
      for (const row of visible.rows) assert.equal(row.payload.externalStoreId, namespace);
      const rows = await fullSnapshot(context.admin, state);
      assert.equal(rows.runtimes[0].externalStoreId, namespace);
      assert.deepEqual(JSON.parse(rows.events[0].entityKey), ["STORE", namespace]);
      for (const row of [...rows.events, ...rows.versions])
        assert.equal(row.externalStoreId, namespace);
    } finally {
      await reader.end();
    }
  });

const storedChanges = [
  [
    "checkpoint hash",
    'UPDATE mock_platform."BuildJob" SET "checkpointHash"=repeat(\'a\',64) WHERE "sessionId"=$1',
  ],
  [
    "receipt start",
    'UPDATE mock_platform."BuildJob" SET "lastAppendStartSeq"=2 WHERE "sessionId"=$1',
  ],
  [
    "receipt count",
    'UPDATE mock_platform."BuildJob" SET "lastAppendEventCount"=0 WHERE "sessionId"=$1',
  ],
  [
    "event envelope",
    'UPDATE mock_platform."SourceEvent" SET "envelopeHash"=repeat(\'a\',64) WHERE "sessionId"=$1',
  ],
  [
    "event identity",
    'UPDATE mock_platform."SourceEvent" SET "eventId"=repeat(\'a\',64) WHERE "sessionId"=$1',
  ],
  [
    "derived version",
    'UPDATE mock_platform."EntityVersion" SET payload=jsonb_set(payload,\'{source,version}\',\'"wrong-version"\') WHERE "sessionId"=$1',
  ],
];
for (const [label, sql] of storedChanges)
  test(`official append rejects malformed stored ${label} with whole-state rollback`, async () => {
    const state = await preparedAppend(context);
    const input = chunkFor(state);
    assert.equal((await sdkAppend(context, state, input)).status, "COMMITTED");
    await corruption(
      context.admin,
      state,
      () => context.admin.query(sql, [state.scope.sessionId]),
      () => unchangedAppend(context, state, input, "SOURCE_INTEGRITY"),
    );
  });

test("official empty initial seal is committed and exactly retried", async () => {
  const state = await preparedAppend(context);
  const input = chunkFor(state, [], true);
  const committed = await sdkAppend(context, state, input);
  assert.equal(committed.status, "COMMITTED");
  assert.equal(committed.checkpoint.highEventSeq, "0");
  await unchangedAppend(context, state, input, { ...committed, status: "ALREADY_COMMITTED" });
  const rows = await snapshot(context.admin, state);
  assert.equal(rows.jobs[0].lastAppendEventCount, 0);
  assert.deepEqual(rows.events, []);
  assert.deepEqual(rows.versions, []);
});

test("changed private frontier is a conflict even with an unchanged saved input hash", async () => {
  const state = await preparedAppend(context, "mock/store.1", "2026-01-01T16:00:00.000Z");
  const input = chunkFor(state);
  input.events[0] = eventFor(
    { scope: state.scope },
    "STORE",
    "0",
    state.lease.checkpoint.processedThrough,
  );
  const committed = await sdkAppend(context, state, input);
  assert.equal(committed.status, "COMMITTED");
  const changed = globalThis.structuredClone(input);
  changed.next.processedThrough = "2026-01-01T15:59:59.999Z";
  await unchangedAppend(context, state, changed, { status: "CONFLICT" });
});

test("official append rejects opening and target violations and cross-chunk chronology", async () => {
  const state = await preparedAppend(context);
  const tooEarly = chunkFor(state);
  tooEarly.events[0] = eventFor({ scope: state.scope }, "STORE", "0", "2025-12-31T15:59:59.999Z");
  await unchangedAppend(context, state, tooEarly, { status: "CONFLICT" });
  const tooLate = chunkFor(state);
  tooLate.next.processedThrough = "2025-12-31T16:00:00.001Z";
  tooLate.events[0] = eventFor({ scope: state.scope }, "STORE", "0", tooLate.next.processedThrough);
  await unchangedAppend(context, state, tooLate, { status: "CONFLICT" });
  const input = chunkFor(state, ["PRODUCT"]);
  const committed = await sdkAppend(context, state, input);
  assert.equal(committed.status, "COMMITTED");
  const regression = chunkFor(state);
  regression.expectedCheckpointHash = committed.checkpointHash;
  await unchangedAppend(context, state, regression, { status: "CONFLICT" });
  const duplicate = { ...input, expectedCheckpointHash: committed.checkpointHash };
  await unchangedAppend(context, state, duplicate, { status: "CONFLICT" });
});

test("latest receipt detects mixed historical accepted fences after takeover", async () => {
  const state = await preparedAppend(context);
  const input = chunkFor(state, ["STORE", "PRODUCT"]);
  assert.equal((await sdkAppend(context, state, input)).status, "COMMITTED");
  assert.deepEqual(await context.worker.fail(state.actor, state.lease, "INTERRUPTED"), {
    status: "FAILED",
  });
  const claimed = await context.worker.claim(state.actor, state.scope);
  assert.equal(claimed.status, "CLAIMED");
  state.lease = claimed.lease;
  await corruption(
    context.admin,
    state,
    () =>
      context.admin.query(
        'UPDATE mock_platform."SourceEvent" SET "acceptedFence"=2 WHERE "sessionId"=$1 AND "eventSeq"=2',
        [state.scope.sessionId],
      ),
    () => unchangedAppend(context, state, input, "SOURCE_INTEGRITY"),
  );
});

test("revoked or replaced login grant cannot borrow a saved append receipt", async () => {
  const state = await preparedAppend(context);
  const input = chunkFor(state);
  const committed = await sdkAppend(context, state, input);
  for (const sql of [
    "UPDATE demo.\"MockWorkerGrant\" SET status='REVOKED' WHERE id=$1",
    'UPDATE demo."MockWorkerGrant" SET "databaseRole"=\'source_foreign_login\' WHERE id=$1',
  ]) {
    try {
      await context.admin.query(sql, [state.actor.grantId]);
      await unchangedAppend(context, state, input, { status: "DENIED" });
    } finally {
      await context.admin.query(
        "UPDATE demo.\"MockWorkerGrant\" SET status='ACTIVE',\"databaseRole\"='source_worker_login' WHERE id=$1",
        [state.actor.grantId],
      );
    }
  }
  await unchangedAppend(context, state, input, { ...committed, status: "ALREADY_COMMITTED" });
});

test("NFC spelling cannot authorize an NFD namespace receipt", async () => {
  const namespace = String.fromCodePoint(0x65, 0x301).repeat(100);
  const state = await preparedAppend(context, namespace);
  const input = chunkFor(state);
  const committed = await sdkAppend(context, state, input);
  const changed = globalThis.structuredClone(input);
  const scope = { ...state.scope, externalStoreId: namespace.normalize("NFC") };
  changed.events[0].after.externalStoreId = scope.externalStoreId;
  await unchangedAppend(context, state, changed, { status: "DENIED" }, { ...state.lease, scope });
  await unchangedAppend(context, state, input, { ...committed, status: "ALREADY_COMMITTED" });
});

test("committed checkpoint with its entire receipt cleared is malformed stored state", async () => {
  const state = await preparedAppend(context);
  const input = chunkFor(state);
  const committed = await sdkAppend(context, state, input);
  assert.equal(committed.status, "COMMITTED");
  const next = chunkFor(state);
  next.expectedCheckpointHash = committed.checkpointHash;
  next.events[0].ordinal = "1";
  await corruption(
    context.admin,
    state,
    () =>
      context.admin.query(
        'UPDATE mock_platform."BuildJob" SET "lastAppendExpectedHash"=NULL,"lastAppendStartSeq"=NULL,"lastAppendEventCount"=NULL,"lastAppendHash"=NULL WHERE "sessionId"=$1',
        [state.scope.sessionId],
      ),
    async () => {
      await unchangedAppend(context, state, input, "SOURCE_INTEGRITY");
      await unchangedAppend(context, state, next, "SOURCE_INTEGRITY");
    },
  );
});

test("initial checkpoint legitimately has no receipt and a wrong hash conflicts", async () => {
  const state = await preparedAppend(context);
  assert.equal(state.lease.checkpoint.chunkIndex, "0");
  const rows = await snapshot(context.admin, state);
  for (const field of [
    "lastAppendExpectedHash",
    "lastAppendStartSeq",
    "lastAppendEventCount",
    "lastAppendHash",
  ])
    assert.equal(rows.jobs[0][field], null);
  const input = chunkFor(state);
  await unchangedAppend(
    context,
    state,
    { ...input, expectedCheckpointHash: "a".repeat(64) },
    { status: "CONFLICT" },
  );
  assert.equal((await sdkAppend(context, state, input)).status, "COMMITTED");
});

test("malformed stored latest receipt hash raises integrity with exact rollback", async () => {
  const state = await preparedAppend(context);
  const input = chunkFor(state);
  assert.equal((await sdkAppend(context, state, input)).status, "COMMITTED");
  await corruption(
    context.admin,
    state,
    () =>
      context.admin.query(
        'UPDATE mock_platform."BuildJob" SET "lastAppendHash"=repeat(\'a\',64) WHERE "sessionId"=$1',
        [state.scope.sessionId],
      ),
    () => unchangedAppend(context, state, input, "SOURCE_INTEGRITY"),
  );
});

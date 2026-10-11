import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  leasePortDatabase,
  closeLeasePortDatabase,
} from "../helpers/mock-source-lease-port-fixture.mjs";
import { preparedAppend } from "../helpers/mock-source-append-port-fixture.mjs";
import { eventFor } from "../helpers/mock-source-append-fixture.mjs";
import { advance } from "../helpers/mock-source-publish-fixture.mjs";
import { readerActor } from "../helpers/mock-platform-fixture.mjs";
import { assertEntitySeeks, measuredLatest } from "../helpers/mock-source-latest-plan-fixture.mjs";
import { restartedLatestRead } from "../helpers/mock-source-latest-restart.mjs";
import {
  readLatestCursor,
  createLatestCursor,
} from "../../dist/src/mock-platform/latest-cursor.js";

const source = await import("../../dist/src/mock-platform/index.js");
let context;
let reader;

test.before(async () => {
  context = await leasePortDatabase(source, "latest");
  context.env.MOCK_SOURCE_CURSOR_KEY = "k".repeat(32);
  reader = source.createMockSourceReader(context.env);
});

test.after(async () => {
  await reader.close();
  await closeLeasePortDatabase(context);
});

function product(state, id, at = state.lease.targetTime, change) {
  return eventFor({ scope: state.scope, job: { targetTime: at } }, "PRODUCT", "0", at, (record) => {
    record.externalProductId = id;
    record.skus[0].externalProductId = id;
    if (change) change(record);
  });
}

async function publishEvents(state, events) {
  let checkpointHash = state.lease.checkpointHash;
  for (let start = 0; start < Math.max(1, events.length); start += 15) {
    const renewed = await context.worker.renew(state.actor, state.lease);
    assert.equal(renewed.status, "RENEWED");
    state.lease = renewed.lease;
    const appended = await context.worker.appendChunk(state.actor, state.lease, {
      expectedCheckpointHash: checkpointHash,
      next: { processedThrough: state.lease.targetTime, sealed: start + 15 >= events.length },
      events: events.slice(start, start + 15),
    });
    assert.equal(appended.status, "COMMITTED");
    checkpointHash = appended.checkpointHash;
  }
  const published = await context.worker.publish(state.actor, state.lease, {
    expectedBaseRevision: state.lease.baseRevision,
    checkpointHash,
  });
  assert.equal(published.status, "PUBLISHED");
  return published.publication;
}

async function nextRelease(state, at) {
  await advance(context.admin, state, at);
  const claimed = await context.worker.claim(state.actor, state.scope);
  assert.equal(claimed.status, "CLAIMED");
  state.lease = claimed.lease;
}

async function assertFreshAndCursorBinding(state, input, first, future) {
  const current = await reader.readLatestStates(readerActor, state.scope, {
    ...input,
    until: future,
    limit: 2,
  });
  assert.deepEqual(
    current.items.map((item) => item.payload.externalProductId),
    ["a-product", "z-product"],
  );
  assert.equal(current.items[1].payload.title, "新标题");
  await assert.rejects(
    reader.readLatestStates(readerActor, state.scope, {
      ...input,
      limit: 2,
      cursor: first.nextCursor,
    }),
    { code: "SOURCE_INPUT" },
  );
  await assert.rejects(
    reader.readLatestStates(readerActor, state.scope, {
      ...input,
      until: future,
      cursor: first.nextCursor,
    }),
    { code: "SOURCE_INPUT" },
  );
  assert.equal(
    await reader.readLatestStates(
      { userId: "unknown", merchantId: readerActor.merchantId },
      state.scope,
      input,
    ),
    null,
  );
}

async function stageAndPublishNext(t, state, input, original, future) {
  const staged = await context.worker.appendChunk(state.actor, state.lease, {
    expectedCheckpointHash: state.lease.checkpointHash,
    next: { processedThrough: future, sealed: true },
    events: [
      ...Array.from({ length: 10 }, (_, index) => ({
        ...product(state, "b", future, (record) => {
          record.title = "更新";
        }),
        ordinal: String(index),
      })),
      product(state, "c-new", future),
    ],
  });
  assert.equal(staged.status, "COMMITTED");
  const before = await measuredLatest(t, () =>
    reader.readLatestStates(readerActor, state.scope, input),
  );
  assert.equal(before.page.publication.certificateHash, original.certificateHash);
  assertEntitySeeks(before.plans);
  t.diagnostic("Staged hot history: entity/time seeks read at most one EntityVersion row each");
  await context.worker.publish(state.actor, state.lease, {
    expectedBaseRevision: state.lease.baseRevision,
    checkpointHash: staged.checkpointHash,
  });
}

async function assertInvalidLatestInputs(state, input, first) {
  for (const changed of [
    { kind: "ORDER" },
    { entityKey: first.items[0].entityKey },
    { cursor: first.nextCursor.slice(0, -1) + "!" },
    { until: "2025-02-30T00:00:00.000Z" },
    { limit: 0 },
    { extra: true },
  ])
    await assert.rejects(
      reader.readLatestStates(readerActor, state.scope, {
        ...input,
        cursor: first.nextCursor,
        ...changed,
      }),
      { code: "SOURCE_INPUT" },
    );
  for (const entityKey of ["nul\u0000key", "\ud800"])
    await assert.rejects(
      reader.readLatestStates(readerActor, state.scope, { ...input, entityKey }),
      { code: "SOURCE_INPUT" },
    );
  await assert.rejects(
    reader.readLatestStates(
      readerActor,
      { ...state.scope, generation: 1 },
      { ...input, cursor: first.nextCursor },
    ),
    { code: "SOURCE_INPUT" },
  );
  await assertLatestCursorCannotScan(state, input, first.nextCursor);
}

async function assertLatestCursorCannotScan(state, input, cursor) {
  await assert.rejects(
    reader.scanVersions(readerActor, state.scope, {
      since: input.until,
      until: input.until,
      limit: 1,
      cursor,
    }),
    { code: "SOURCE_INPUT" },
  );
}

test("latest-state pages advance across future-only keys and preserve the prior product snapshot", async () => {
  const state = await preparedAppend(context);
  await publishEvents(state, [
    product(state, "z-product", state.lease.targetTime, (record) => {
      record.skus[0].costPriceMinor = null;
      record.source.quality = { state: "PARTIAL", issues: ["COST_MISSING"] };
    }),
  ]);
  const until = state.lease.targetTime;
  const future = new Date(Date.parse(until) + 60_000).toISOString();
  await nextRelease(state, future);
  await publishEvents(state, [
    product(state, "a-product", future),
    product(state, "z-product", future, (record) => {
      record.title = "新标题";
    }),
  ]);

  const input = { kind: "PRODUCT", until, limit: 1 };
  const first = await reader.readLatestStates(readerActor, state.scope, input);
  assert.equal(first.publication.revision, "2");
  assert.deepEqual(first.items, []);
  assert.ok(first.nextCursor);
  assert.ok(first.nextCursor.length <= 1024);
  await reader.close();
  reader = source.createMockSourceReader(context.env);
  const second = await reader.readLatestStates(readerActor, state.scope, {
    ...input,
    cursor: first.nextCursor,
  });
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].payload.externalProductId, "z-product");
  assert.equal(second.items[0].payload.title, "产品");
  assert.equal(second.items[0].payload.status, "DELETED");
  assert.equal(second.items[0].payload.skus[0].costPriceMinor, null);
  assert.deepEqual(second.items[0].payload.source.quality, {
    state: "PARTIAL",
    issues: ["COST_MISSING"],
  });
  assert.equal(second.nextCursor, null);
  await assertFreshAndCursorBinding(state, input, first, future);
});

test("latest-state cursor pins publication across a new release and rechecks access", async (t) => {
  const state = await preparedAppend(context);
  const original = await publishEvents(state, [product(state, "a"), product(state, "b")]);
  const until = state.lease.targetTime;
  const input = { kind: "PRODUCT", until, limit: 1 };
  const first = await reader.readLatestStates(readerActor, state.scope, input);
  assert.ok(first.nextCursor);
  const future = new Date(Date.parse(until) + 60_000).toISOString();
  await nextRelease(state, future);
  await stageAndPublishNext(t, state, { ...input, cursor: first.nextCursor }, original, future);
  const measured = await measuredLatest(t, () =>
    reader.readLatestStates(readerActor, state.scope, {
      ...input,
      cursor: first.nextCursor,
    }),
  );
  assertEntitySeeks(measured.plans);
  t.diagnostic(
    "Later-published hot history: pinned entity/time seeks read at most one EntityVersion row each",
  );
  const resumed = measured.page;
  assert.equal(resumed.publication.certificateHash, original.certificateHash);
  assert.equal(resumed.items[0].payload.title, "产品");
  assert.equal(resumed.nextCursor, null);
  await context.admin.query('UPDATE "PlatformConnection" SET status=$1 WHERE id=$2', [
    "DISCONNECTED",
    state.scope.connectionId,
  ]);
  assert.equal(
    await reader.readLatestStates(readerActor, state.scope, {
      ...input,
      cursor: first.nextCursor,
    }),
    null,
  );
});

test("latest-state seeks skip hot histories and cap candidate work at thirty-two keys", async (t) => {
  const state = await preparedAppend(context);
  const hot = Array.from({ length: 59 }, (_, index) => ({
    ...product(state, "a-hot"),
    ordinal: String(index),
  }));
  const others = Array.from({ length: 40 }, (_, index) =>
    product(state, `b-${String(index).padStart(2, "0")}`),
  );
  await publishEvents(state, [...hot, ...others]);
  await context.rawAdmin.query('ANALYZE mock_platform."EntityVersion"');
  const input = { until: state.lease.targetTime, limit: 200 };
  const { page, plans } = await measuredLatest(t, () =>
    reader.readLatestStates(readerActor, state.scope, input),
  );
  assert.equal(page.items.length, 32);
  assert.equal(page.items[0].eventSeq, "59");
  assert.ok(page.nextCursor);
  assert.equal(plans.length, 65);
  assertEntitySeeks(plans);
  t.diagnostic(`Measured ${plans.length} indexed seeks for 32 candidates across 99 versions`);
  const resumed = await reader.readLatestStates(readerActor, state.scope, {
    ...input,
    cursor: page.nextCursor,
  });
  assert.equal(resumed.items.length, 9);
  assert.equal(resumed.nextCursor, null);
});

test("latest-state validates input and isolates signed cursors from scopes, filters and scans", async () => {
  const state = await preparedAppend(context);
  await publishEvents(state, [product(state, "a"), product(state, "b")]);
  const input = { kind: "PRODUCT", until: state.lease.targetTime, limit: 1 };
  const first = await reader.readLatestStates(readerActor, state.scope, input);
  await assertInvalidLatestInputs(state, input, first);
  const exact = await reader.readLatestStates(readerActor, state.scope, {
    ...input,
    entityKey: first.items[0].entityKey,
  });
  assert.deepEqual(exact.items, first.items);
  assert.equal(exact.nextCursor, null);
});

test("latest-state distinguishes unpublished and empty published scopes", async () => {
  const state = await preparedAppend(context);
  const input = { until: state.lease.targetTime, limit: 10 };
  assert.equal(await reader.readLatestStates(readerActor, state.scope, input), null);
  await publishEvents(state, []);
  const page = await reader.readLatestStates(readerActor, state.scope, input);
  assert.deepEqual(page.items, []);
  assert.equal(page.nextCursor, null);
  await assert.rejects(
    reader.readLatestStates(readerActor, state.scope, {
      ...input,
      until: new Date(Date.parse(input.until) + 1).toISOString(),
    }),
    { code: "SOURCE_INPUT" },
  );
});

test("compact latest cursors survive another process and preserve chain expiry on retries", async () => {
  const state = await preparedAppend(context);
  await publishEvents(state, [product(state, "a"), product(state, "b"), product(state, "c")]);
  const input = {
    until: state.lease.targetTime,
    kind: "PRODUCT",
    limit: 1,
    contextHash: "a".repeat(64),
  };
  const first = await reader.readLatestStates(readerActor, state.scope, input);
  const resumed = { ...input, cursor: first.nextCursor };
  const second = await restartedLatestRead(context.env, readerActor, state.scope, resumed);
  const retry = await reader.readLatestStates(readerActor, state.scope, resumed);
  assert.deepEqual(second, retry);
  const decode = (cursor) =>
    readLatestCursor(context.env.MOCK_SOURCE_CURSOR_KEY, cursor, state.scope, input);
  assert.equal(decode(first.nextCursor).expiresAt, decode(second.nextCursor).expiresAt);
  assert.equal(second.items[0].payload.externalProductId, "b");
  const last = await reader.readLatestStates(readerActor, state.scope, {
    ...input,
    cursor: second.nextCursor,
  });
  assert.equal(last.items[0].payload.externalProductId, "c");
  assert.equal(last.nextCursor, null);
});

test("a signed witness cannot resume against an entity from another scope", async () => {
  const original = await preparedAppend(context),
    foreign = await preparedAppend(context);
  const publication = await publishEvents(original, [
    product(original, "a"),
    product(original, "b"),
  ]);
  await publishEvents(foreign, [product(foreign, "a")]);
  const input = { until: original.lease.targetTime, kind: "PRODUCT", limit: 1 };
  const cursor = createLatestCursor(
    context.env.MOCK_SOURCE_CURSOR_KEY,
    foreign.scope,
    publication,
    input,
    { kind: "PRODUCT", entityKey: '["PRODUCT", "b"]', eventSeq: "2" },
    Date.now() + 60_000,
  );
  await assert.rejects(reader.readLatestStates(readerActor, foreign.scope, { ...input, cursor }), {
    code: "SOURCE_INTEGRITY",
  });
});

function publicationPin(publication) {
  const { revision, highEventSeq, certificateHash } = publication;
  return { revision, highEventSeq, certificateHash };
}

test("an explicit first-page pin keeps the discovered publication after a later release", async () => {
  const state = await preparedAppend(context);
  const original = await publishEvents(state, [product(state, "a"), product(state, "b")]);
  const until = state.lease.targetTime;
  const future = new Date(Date.parse(until) + 1000).toISOString();
  await nextRelease(state, future);
  const newer = await publishEvents(state, [product(state, "c-new", future)]);
  const input = { until, limit: 1, kind: "PRODUCT", publication: publicationPin(original) };
  const first = await reader.readLatestStates(readerActor, state.scope, input);
  assert.equal(first.publication.certificateHash, original.certificateHash);
  assert.equal(first.items[0].payload.externalProductId, "a");
  const second = await reader.readLatestStates(readerActor, state.scope, {
    ...input,
    cursor: first.nextCursor,
  });
  assert.equal(second.items[0].payload.externalProductId, "b");
  assert.equal(second.nextCursor, null);
  await assert.rejects(
    reader.readLatestStates(readerActor, state.scope, {
      ...input,
      cursor: first.nextCursor,
      publication: publicationPin(newer),
    }),
    { code: "SOURCE_INTEGRITY" },
  );
});

test("explicit pins reject malformed identities and missing certificates while retaining authorization", async () => {
  const state = await preparedAppend(context);
  const publication = await publishEvents(state, [product(state, "a")]);
  const pin = publicationPin(publication);
  const input = { until: state.lease.targetTime, limit: 1, publication: pin };
  for (const change of [
    { revision: "01" },
    { revision: "0" },
    { highEventSeq: "-1" },
    { certificateHash: "A".repeat(64) },
    { extra: true },
  ])
    await assert.rejects(
      reader.readLatestStates(readerActor, state.scope, {
        ...input,
        publication: { ...pin, ...change },
      }),
      { code: "SOURCE_INPUT" },
    );
  for (const change of [
    { revision: "99" },
    { highEventSeq: "0" },
    { certificateHash: "b".repeat(64) },
  ])
    await assert.rejects(
      reader.readLatestStates(readerActor, state.scope, {
        ...input,
        publication: { ...pin, ...change },
      }),
      { code: "SOURCE_INTEGRITY" },
    );
  await assert.rejects(
    reader.readLatestStates(readerActor, state.scope, {
      ...input,
      until: new Date(Date.parse(input.until) + 1).toISOString(),
    }),
    { code: "SOURCE_INPUT" },
  );
  await context.admin.query('UPDATE "PlatformConnection" SET status=$1 WHERE id=$2', [
    "DISCONNECTED",
    state.scope.connectionId,
  ]);
  assert.equal(await reader.readLatestStates(readerActor, state.scope, input), null);
});

test("structured exact keys select every kind including escaped identifiers and composite keys", async () => {
  const state = await preparedAppend(context);
  const at = state.lease.targetTime;
  const kinds = ["STORE", "PRODUCT", "ORDER", "REFUND", "INVENTORY", "MARKETING"];
  const events = kinds.map((kind) =>
    eventFor({ scope: state.scope, job: { targetTime: at } }, kind),
  );
  events[1] = product(state, 'quoted/"中文');
  await publishEvents(state, events);
  const input = { until: at, limit: 10 };
  const all = await reader.readLatestStates(readerActor, state.scope, input);
  assert.equal(all.items.length, 6);
  for (const item of all.items) {
    const entityKey = JSON.parse(item.entityKey);
    const exact = await reader.readLatestStates(readerActor, state.scope, {
      ...input,
      kind: item.kind,
      entityKey,
    });
    assert.deepEqual(exact.items, [item]);
    assert.equal(exact.nextCursor, null);
  }
  const absent = await reader.readLatestStates(readerActor, state.scope, {
    ...input,
    kind: "PRODUCT",
    entityKey: ["PRODUCT", "absent"],
  });
  assert.deepEqual(absent.items, []);
});

test("legal contract identities certify absence only under an authorized publication", async () => {
  const state = await preparedAppend(context);
  const input = { until: state.lease.targetTime, limit: 1, kind: "PRODUCT" };
  const entityKey = ["PRODUCT", "\ud800"];
  assert.equal(
    await reader.readLatestStates(readerActor, state.scope, { ...input, entityKey }),
    null,
  );
  const publication = await publishEvents(state, [product(state, 'quoted/"中文')]);
  for (const id of ["x".repeat(256), "界".repeat(256), "\ud800", "\udfff"]) {
    const page = await reader.readLatestStates(readerActor, state.scope, {
      ...input,
      entityKey: ["PRODUCT", id],
    });
    assert.deepEqual(page.items, []);
    assert.equal(page.publication.certificateHash, publication.certificateHash);
    assert.equal(page.nextCursor, null);
  }
  assert.equal(
    await reader.readLatestStates({ ...readerActor, userId: "unknown" }, state.scope, {
      ...input,
      entityKey,
    }),
    null,
  );
  const event = product(state, "\ud800");
  const { validateSnapshotEvent } = await import(
    "../../dist/src/mock-platform/publication-validation.js"
  );
  assert.throws(() => validateSnapshotEvent(event, state.scope), { code: "SOURCE_INPUT" });
});

test("explicit pins recheck authorization when revocation hides the certificate mid-read", async (t) => {
  const state = await preparedAppend(context);
  const publication = await publishEvents(state, [product(state, "a")]);
  const input = {
    until: state.lease.targetTime,
    limit: 1,
    publication: publicationPin(publication),
  };
  const original = pg.Client.prototype.query;
  let revoked = false;
  const spy = t.mock.method(pg.Client.prototype, "query", async function (sql, ...args) {
    if (typeof sql === "string" && sql.startsWith("WITH certificate AS") && !revoked) {
      revoked = true;
      await context.admin.query(
        'UPDATE "OrganizationMember" SET status=$1 WHERE "organizationId"=$2 AND "userId"=$3',
        ["INACTIVE", state.scope.organizationId, readerActor.userId],
      );
    }
    return original.call(this, sql, ...args);
  });
  try {
    assert.equal(await reader.readLatestStates(readerActor, state.scope, input), null);
    assert.equal(revoked, true);
  } finally {
    spy.mock.restore();
    await context.admin.query(
      'UPDATE "OrganizationMember" SET status=$1 WHERE "organizationId"=$2 AND "userId"=$3',
      ["ACTIVE", state.scope.organizationId, readerActor.userId],
    );
  }
});

test("authorized restart refreshes an expired checkpoint without changing its immutable snapshot", async () => {
  const state = await preparedAppend(context);
  const publication = await publishEvents(state, [product(state, "a"), product(state, "z")]);
  const input = { until: publication.targetTime, kind: "PRODUCT", limit: 1 };
  const first = await reader.readLatestStates(readerActor, state.scope, input);
  const position = { ...first.items[0], eventSeq: first.items[0].eventSeq };
  const oldNow = Date.now() - 20 * 60_000;
  const expired = createLatestCursor(
    context.env.MOCK_SOURCE_CURSOR_KEY,
    state.scope,
    publication,
    input,
    position,
    oldNow + 60_000,
    oldNow,
  );
  await assert.rejects(
    reader.readLatestStates(readerActor, state.scope, { ...input, cursor: expired }),
    { code: "SOURCE_INPUT" },
  );
  const restarted = source.createMockSourceReader(context.env);
  try {
    const cursor = await restarted.refreshLatestCheckpoint(readerActor, state.scope, {
      ...input,
      cursor: expired,
    });
    assert.equal(typeof cursor, "string");
    const recovered = readLatestCursor(
      context.env.MOCK_SOURCE_CURSOR_KEY,
      cursor,
      state.scope,
      input,
    );
    assert.equal(recovered.certificateHash, publication.certificateHash);
    assert.equal(recovered.highEventSeq, publication.highEventSeq);
    assert.equal(recovered.afterEventSeq, position.eventSeq);
    const next = await restarted.readLatestStates(readerActor, state.scope, { ...input, cursor });
    assert.deepEqual(
      next.items.map((item) => item.payload.externalProductId),
      ["z"],
    );
    assert.equal(next.nextCursor, null);
    for (const change of [{ limit: 2 }, { kind: "ORDER" }, { cursor: expired + "!" }])
      await assert.rejects(
        restarted.refreshLatestCheckpoint(readerActor, state.scope, {
          ...input,
          cursor: expired,
          ...change,
        }),
        { code: "SOURCE_INPUT" },
      );
    assert.equal(
      await restarted.refreshLatestCheckpoint({ ...readerActor, userId: "unknown" }, state.scope, {
        ...input,
        cursor: expired,
      }),
      null,
    );
  } finally {
    await restarted.close();
  }
});

import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { URL } from "node:url";
import pg from "pg";
import { isolatedPostgres } from "../helpers/isolated-postgres.mjs";
import {
  migrateSource,
  sourceFixtures,
  loginUrl,
  grantSource,
} from "../helpers/mock-platform-fixture.mjs";
import {
  sqlError,
  sourceTransaction,
  leaseOf,
  change,
  jobFor,
  newScope,
  claim,
  scopeValues,
} from "../helpers/mock-source-lease-fixture.mjs";
import {
  kinds,
  utc,
  nextFor,
  eventFor,
  appendSettings,
  insertEvent,
  insertVersion,
  updateAppend,
  append,
  freshAppend,
  snapshot,
  rejectedAppend,
  suppression,
  uniqueSuffix,
  insertBatch,
  batchAppend,
  largeProduct,
  eventSql,
  appendSql,
} from "../helpers/mock-source-append-fixture.mjs";
import * as schemas from "../../../contracts/dist/index.js";
import { codecSchemas } from "../helpers/mock-source-codec-fixture.mjs";
import {
  operatorControl,
  beginWorker,
  waitLock,
  rawInsert,
  rawValues,
} from "../helpers/mock-source-control-fixture.mjs";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

let server, admin, worker, reader;
const clients = [];
pg.types.setTypeParser(1114, (value) => new Date(value + "Z"));
async function login(url, name) {
  const client = new pg.Client({ connectionString: loginUrl(url, name) });
  await client.connect();
  clients.push(client);
  return client;
}
before(async () => {
  server = await isolatedPostgres();
  const url = new URL(server.url);
  admin = await login(server.url, url.username);
  await admin.query('CREATE DATABASE "shopmate_tenant_test_sourceappend"');
  url.pathname = "/shopmate_tenant_test_sourceappend";
  admin = await login(url.toString(), url.username);
  await migrateSource(admin);
  await sourceFixtures(admin);
  worker = await login(url.toString(), "source_worker_login");
  reader = await login(url.toString(), "source_read_login");
});
after(async () => {
  for (const client of clients.reverse()) await client.end();
  if (server) {
    const cleanup = new pg.Client({ connectionString: server.url });
    await cleanup.connect();
    try {
      await cleanup.query('DROP DATABASE IF EXISTS "shopmate_tenant_test_sourceappend"');
    } finally {
      await cleanup.end();
    }
    await server.stop();
  }
});
const fresh = (suffix, namespace) => freshAppend(admin, worker, suffix, namespace);
const reject = (context, events, code = "SM005", options = {}, next = nextFor(context.job)) =>
  rejectedAppend(admin, worker, context, events, next, options, sqlError(code));
for (const kind of kinds)
  test(`${kind} derives exact stored event and one version`, async () => {
    const context = await fresh(kind.toLowerCase()),
      event = eventFor(context, kind);
    const job = (await append(worker, context, [event])).rows[0];
    const rows = await snapshot(admin, context),
      stored = rows.events[0],
      version = rows.versions[0];
    assert.equal(job.highEventSeq, "1");
    assert.equal(job.eventCount, "1");
    assert.equal(job.versionCount, "1");
    assert.equal(job.checkpoint.chunkIndex, "1");
    assert.equal(stored.eventSeq, 1);
    assert.equal(stored.appendIndex, 1);
    assert.equal(stored.acceptedFence, 1);
    assert.equal(stored.payload.source.version, "mock-runtime-v2:g:0:e:1");
    assert.deepEqual(stored.payload, version.payload);
    assert.equal(stored.kind, kind);
    assert.ok(schemas[codecSchemas[kind]].safeParse(stored.payload).success);
    assert.deepEqual(stored.manifest, [
      {
        kind,
        entityKey: JSON.parse(stored.entityKey),
        eventSeq: "1",
        versionHash: version.versionHash,
      },
    ]);
    assert.match(stored.eventId, /^[a-f0-9]{64}$/u);
    assert.match(stored.envelopeHash, /^[a-f0-9]{64}$/u);
  });
test("declared legitimate empty initial seal commits without physical rows", async () => {
  const context = await fresh("empty-seal");
  const job = (await append(worker, context, [], nextFor(context.job, true))).rows[0];
  assert.equal(job.checkpoint.sealed, true);
  assert.equal(job.checkpoint.chunkIndex, "1");
  assert.equal(job.eventCount, "0");
  assert.equal(job.lastAppendEventCount, 0);
  assert.equal(job.lastAppendStartSeq, "1");
  assert.match(job.lastAppendHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual((await snapshot(admin, context)).events, []);
});
async function rawCountAppend(context, spelling, events, next) {
  return sourceTransaction(
    worker,
    context.scope,
    "APPEND",
    async () => {
      await appendSettings(worker, context.job, events, next);
      await worker.query("SELECT set_config('mock.source_append',$1,true)", [
        `{"eventCount":${spelling},"next":${JSON.stringify(next)}}`,
      ]);
      const raw = await worker.query(
        "SELECT (current_setting('mock.source_append')::jsonb->'eventCount')::text AS spelling",
      );
      assert.equal(raw.rows[0].spelling, spelling);
      for (const event of events) {
        const inserted = await insertEvent(worker, context, event);
        await insertVersion(worker, context, inserted.rows[0].eventSeq);
      }
      return updateAppend(worker, context, next);
    },
    leaseOf(context.job),
    context.grant,
  );
}
function assertDecimalProgress(job, previous, count, next, lastEvent = null) {
  assert.equal(job.highEventSeq, String(count));
  assert.equal(job.eventCount, String(count));
  assert.equal(job.versionCount, String(count));
  assert.deepEqual(job.checkpoint, {
    codec: "source-checkpoint-v1",
    chunkIndex: "1",
    highEventSeq: String(count),
    processedThrough: next.processedThrough,
    lastEvent,
    sealed: next.sealed,
  });
  assert.equal(utc(job.processedThrough), next.processedThrough);
  assert.equal(job.lastAppendExpectedHash, previous.checkpointHash);
  assert.equal(job.lastAppendStartSeq, "1");
  assert.equal(job.lastAppendEventCount, count);
  assert.notEqual(job.checkpointHash, previous.checkpointHash);
  assert.equal(job.leaseOwner, previous.leaseOwner);
  assert.equal(job.fence, previous.fence);
  assert.equal(job.state, "BUILDING");
}
async function decimalHashes(context, job, next) {
  const result = await admin.query(
    `SELECT mock_platform.hash_jsonb(jsonb_build_object('codec','source-checkpoint-hash-v1','scope',mock_platform.source_scope(to_jsonb(j)),
      'revision',j.revision::text,'checkpoint',j.checkpoint)) AS checkpoint,
      mock_platform.hash_jsonb(jsonb_build_object('codec','source-chunk-v1','scope',mock_platform.source_scope(to_jsonb(j)),
      'revision',j.revision::text,'expectedCheckpointHash',$2::text,'next',$3::jsonb,
      'eventEnvelopeHashes',coalesce((SELECT jsonb_agg(e."envelopeHash" ORDER BY e."eventSeq") FROM mock_platform."SourceEvent" e WHERE e."sessionId"=j."sessionId"),'[]'::jsonb))) AS chunk,
      coalesce((SELECT jsonb_agg(jsonb_build_object('eventId',mock_platform.hash_jsonb(jsonb_build_object('codec','source-event-id-v1',
        'scope',mock_platform.source_scope(to_jsonb(e)),'kind',e.kind,'occurredAt',mock_platform.canonical_utc(e."occurredAt"),'entityKey',e."entityKey"::jsonb,'ordinal',e.ordinal::text)),
        'versionHash',mock_platform.hash_jsonb(mock_platform.version_envelope(e)),
        'envelopeHash',mock_platform.hash_jsonb(mock_platform.event_envelope(e))) ORDER BY e."eventSeq")
        FROM mock_platform."SourceEvent" e WHERE e."sessionId"=j."sessionId"),'[]'::jsonb) AS facts
      FROM mock_platform."BuildJob" j WHERE j."sessionId"=$1`,
    [context.scope.sessionId, context.job.checkpointHash, JSON.stringify(next)],
  );
  assert.equal(job.checkpointHash, result.rows[0].checkpoint);
  assert.equal(job.lastAppendHash, result.rows[0].chunk);
  return result.rows[0].facts;
}
function assertDecimalFacts(context, event, rows, hashes) {
  assert.equal(rows.events.length, 1);
  assert.equal(rows.versions.length, 1);
  const stored = rows.events[0],
    hash = hashes[0],
    payload = globalThis.structuredClone(event.after),
    entityKey = ["STORE", context.scope.externalStoreId];
  assert.equal(utc(stored.occurredAt + "Z"), event.occurredAt);
  payload.source.version = "mock-runtime-v2:g:0:e:1";
  const common = {
    ...context.scope,
    releaseRevision: 1,
    eventSeq: 1,
    kind: "STORE",
    entityKey: stored.entityKey,
    occurredAt: stored.occurredAt,
    payload,
  };
  assert.deepEqual(JSON.parse(stored.entityKey), entityKey);
  assert.deepEqual(rows.versions[0], { ...common, versionHash: hash.versionHash });
  assert.deepEqual(stored, {
    ...common,
    eventId: hash.eventId,
    appendIndex: 1,
    acceptedFence: 1,
    phaseRank: 0,
    ordinal: 0,
    envelopeHash: hash.envelopeHash,
    manifest: [{ kind: "STORE", entityKey, eventSeq: "1", versionHash: hash.versionHash }],
  });
}
test("raw integral JSONB eventCount 0.0 commits an exact empty seal", async () => {
  const context = await fresh("decimal-empty"),
    next = nextFor(context.job, true),
    job = (await rawCountAppend(context, "0.0", [], next)).rows[0];
  assertDecimalProgress(job, context.job, 0, next);
  assert.deepEqual(await jobFor(admin, context), job);
  const rows = await snapshot(admin, context);
  assert.deepEqual(rows.events, []);
  assert.deepEqual(rows.versions, []);
  assert.deepEqual(await decimalHashes(context, job, next), []);
});
test("raw integral JSONB eventCount 1.0 commits exact event version and progress", async () => {
  const context = await fresh("decimal-nonempty"),
    event = eventFor(context),
    next = nextFor(context.job),
    job = (await rawCountAppend(context, "1.0", [event], next)).rows[0];
  assertDecimalProgress(job, context.job, 1, next, {
    kind: event.kind,
    occurredAt: event.occurredAt,
    entityKey: ["STORE", context.scope.externalStoreId],
    ordinal: event.ordinal,
  });
  assert.deepEqual(await jobFor(admin, context), job);
  assertDecimalFacts(
    context,
    event,
    await snapshot(admin, context),
    await decimalHashes(context, job, next),
  );
});
test("raw fractional JSONB eventCount 1.5 rejects with fixed integrity and exact rollback", async () => {
  const context = await fresh("decimal-fraction"),
    before = await snapshot(admin, context);
  await assert.rejects(
    rawCountAppend(context, "1.5", [eventFor(context)], nextFor(context.job)),
    (error) => error.code === "SM005" && error.message === "Invalid source integrity",
  );
  assert.deepEqual(await snapshot(admin, context), before);
});
for (const [label, options] of [
  ["event-only", { versions: false, update: false }],
  ["missing version", { versions: false }],
  ["missing job update", { update: false }],
])
  test(`${label} rolls back rows and exact progress`, async () => {
    const context = await fresh(label.replaceAll(" ", "-"));
    await rejectedAppend(
      admin,
      worker,
      context,
      [eventFor(context)],
      nextFor(context.job),
      options,
      sqlError("SM005"),
    );
  });
for (const table of ["SourceEvent", "EntityVersion", "BuildJob"])
  test(`operator suppression of ${table} cannot commit a declared nonempty append`, async () => {
    const context = await fresh(`suppress-${table.toLowerCase()}`);
    await suppression(admin, table, () =>
      rejectedAppend(
        admin,
        worker,
        context,
        [eventFor(context)],
        nextFor(context.job),
        {},
        sqlError("SM005"),
      ),
    );
  });
for (const namespace of ["商".repeat(200), "e\u0301".repeat(100), "😀".repeat(100)])
  test(`all six staged streams preserve ${namespace.length} UTF16 unit namespace`, async () => {
    const context = await fresh(uniqueSuffix(), namespace),
      events = kinds.map((kind) => eventFor(context, kind));
    await append(worker, context, events);
    const result = await snapshot(admin, context);
    assert.equal(result.events.length, 6);
    assert.equal(result.versions.length, 6);
    for (const row of [...result.events, ...result.versions]) {
      assert.equal(row.externalStoreId, namespace);
      assert.equal(row.payload.externalStoreId, namespace);
    }
    assert.deepEqual(JSON.parse(result.events[0].entityKey), ["STORE", namespace]);
  });
test("private unsealed target frontier permits strictly later same-time tuples", async () => {
  const context = await fresh("continuation");
  const first = (await append(worker, context, [eventFor(context, "STORE", "0")])).rows[0];
  const second = (
    await append(worker, { ...context, job: first }, [eventFor(context, "STORE", "1")])
  ).rows[0];
  assert.equal(second.highEventSeq, "2");
  assert.equal(second.checkpoint.lastEvent.ordinal, "1");
  await rejectedAppend(
    admin,
    worker,
    { ...context, job: second },
    [eventFor(context, "STORE", "1")],
    nextFor(second),
    {},
    sqlError("SM004"),
  );
  const sealed = (await append(worker, { ...context, job: second }, [], nextFor(second, true)))
    .rows[0];
  await rejectedAppend(
    admin,
    worker,
    { ...context, job: sealed },
    [eventFor(context, "STORE", "2")],
    nextFor(sealed),
    {},
    sqlError("SM004"),
  );
});
test("empty unchanged unsealed chunk conflicts atomically", async () => {
  const context = await fresh("empty-no-progress");
  await rejectedAppend(admin, worker, context, [], nextFor(context.job), {}, sqlError("SM004"));
});
for (const [label, options] of [
  ["count mismatch", { declaration: { eventCount: 0, next: null } }],
  ["forged expected hash", { expected: "0".repeat(64) }],
])
  test(`${label} rolls back inserted facts`, async () => {
    const context = await fresh(label.replaceAll(" ", "-")),
      next = nextFor(context.job);
    const input = options.declaration ? { declaration: { ...options.declaration, next } } : options;
    await rejectedAppend(
      admin,
      worker,
      context,
      [eventFor(context)],
      next,
      input,
      sqlError(label === "count mismatch" ? "SM005" : "SM004"),
    );
  });
test("PUBLISH requires a declaration even after a sealed append", async () => {
  const context = await fresh("publish-closed");
  const job = (await append(worker, context, [], nextFor(context.job, true))).rows[0];
  await assert.rejects(
    change(worker, context, job, "PUBLISH", { state: "PUBLISHED" }),
    sqlError("SM005"),
  );
  assert.deepEqual(await jobFor(admin, context), job);
});
test("second job mutation after append rolls back its entire chunk", async () => {
  const context = await fresh("second-mutation"),
    before = await snapshot(admin, context),
    events = [eventFor(context)],
    next = nextFor(context.job);
  await assert.rejects(
    sourceTransaction(
      worker,
      context.scope,
      "APPEND",
      async () => {
        await appendSettings(worker, context.job, events, next);
        const event = (await insertEvent(worker, context, events[0])).rows[0];
        await insertVersion(worker, context, event.eventSeq);
        await updateAppend(worker, context, next);
        await updateAppend(worker, context, next);
      },
      leaseOf(context.job),
      context.grant,
    ),
    sqlError("SM005"),
  );
  assert.deepEqual(await snapshot(admin, context), before);
});
test("SET CONSTRAINTS IMMEDIATE after complete append cannot admit later facts", async () => {
  const context = await fresh("immediate"),
    before = await snapshot(admin, context),
    events = [eventFor(context)],
    next = nextFor(context.job);
  await assert.rejects(
    sourceTransaction(
      worker,
      context.scope,
      "APPEND",
      async () => {
        await appendSettings(worker, context.job, events, next);
        const event = (await insertEvent(worker, context, events[0])).rows[0];
        await insertVersion(worker, context, event.eventSeq);
        await updateAppend(worker, context, next);
        await worker.query("SET CONSTRAINTS ALL IMMEDIATE");
        await insertEvent(worker, context, eventFor(context, "STORE", "1"));
      },
      leaseOf(context.job),
      context.grant,
    ),
    sqlError("SM005"),
  );
  assert.deepEqual(await snapshot(admin, context), before);
});

async function receiptMatches(context, input) {
  return sourceTransaction(
    worker,
    context.scope,
    "RENEW",
    async () => {
      const result = await worker.query(
        'SELECT mock_platform.saved_append_matches(j,$2::jsonb) AS matches FROM mock_platform."BuildJob" j WHERE "sessionId"=$1',
        [context.scope.sessionId, JSON.stringify(input)],
      );
      return result.rows[0].matches;
    },
    leaseOf(context.job),
    context.grant,
  );
}
test("latest receipt compares full exact input and reconstructs derived source version", async () => {
  const context = await fresh("receipt"),
    event = eventFor(context),
    next = nextFor(context.job);
  const input = { expectedCheckpointHash: context.job.checkpointHash, next, events: [event] };
  const first = (await append(worker, context, [event], next)).rows[0];
  assert.equal(await receiptMatches(context, input), true);
  const renewed = (await change(worker, context, first, "RENEW")).rows[0];
  assert.equal(await receiptMatches({ ...context, job: renewed }, input), true);
  const second = (
    await append(worker, { ...context, job: renewed }, [eventFor(context, "STORE", "1")])
  ).rows[0];
  assert.equal(await receiptMatches({ ...context, job: second }, input), false);
  assert.equal(second.lastAppendStartSeq, "2");
  assert.equal(second.lastAppendEventCount, 1);
});
const receiptChanges = [
  [
    "timestamp",
    (v) => {
      v.events[0].occurredAt = "2026-01-01T00:00:00.000Z";
    },
  ],
  [
    "kind",
    (v) => {
      v.events[0].kind = "PRODUCT";
    },
  ],
  [
    "identity",
    (v) => {
      v.events[0].after.externalStoreId += "x";
    },
  ],
  [
    "ordinal",
    (v) => {
      v.events[0].ordinal = "1";
    },
  ],
  [
    "record",
    (v) => {
      v.events[0].after.name = "changed";
    },
  ],
  [
    "quality",
    (v) => {
      v.events[0].after.source.quality = { state: "PARTIAL", issues: ["SOURCE_INCONSISTENT"] };
    },
  ],
  [
    "frontier",
    (v) => {
      v.next.processedThrough = "2026-01-01T00:00:00.000Z";
    },
  ],
  [
    "seal",
    (v) => {
      v.next.sealed = true;
    },
  ],
  [
    "count",
    (v) => {
      v.events = [];
    },
  ],
  [
    "version",
    (v) => {
      v.events[0].after.source.version = "forged";
    },
  ],
];
for (const [label, mutate] of receiptChanges)
  test(`receipt rejects changed ${label} with saved hash`, async () => {
    const context = await fresh(`receipt-${label}`),
      event = eventFor(context),
      next = nextFor(context.job);
    const input = { expectedCheckpointHash: context.job.checkpointHash, next, events: [event] };
    const job = (await append(worker, context, [event], next)).rows[0],
      before = await snapshot(admin, context);
    mutate(input);
    assert.equal(await receiptMatches({ ...context, job }, input), false);
    assert.deepEqual(await snapshot(admin, context), before);
  });
test("historical accepted fences survive FAILED takeover and subsequent append", async () => {
  const context = await fresh("takeover"),
    firstEvent = eventFor(context),
    next = nextFor(context.job);
  const input = { expectedCheckpointHash: context.job.checkpointHash, next, events: [firstEvent] };
  const first = (await append(worker, context, [firstEvent])).rows[0];
  const failed = (
    await change(worker, context, first, "FAIL", { state: "FAILED", failure: "INTERRUPTED" })
  ).rows[0];
  const grant = "append-takeover-replacement";
  await grantSource(admin, context.scope, grant);
  const replacement = { ...context, grant },
    taken = (
      await change(worker, replacement, failed, "CLAIM", { state: "BUILDING", owner: randomUUID() })
    ).rows[0];
  assert.equal(taken.fence, "2");
  assert.deepEqual(taken.checkpoint, first.checkpoint);
  assert.equal(await receiptMatches({ ...replacement, job: taken }, input), true);
  await reject({ ...context, job: first }, [eventFor(context, "STORE", "1")], "SM003");
  const last = (
    await append(worker, { ...replacement, job: taken }, [eventFor(context, "STORE", "1")])
  ).rows[0];
  const rows = await snapshot(admin, context);
  assert.deepEqual(
    rows.events.map((event) => event.acceptedFence),
    [1, 2],
  );
  assert.equal(last.highEventSeq, "2");
  await reject({ ...context, job: last }, [eventFor(context, "STORE", "2")], "SM003");
});
async function advance(scope, at) {
  return operatorControl(
    admin,
    'UPDATE demo."DemoCommerceSession" SET "clockNow"=$1::timestamp,"clockRevision"="clockRevision"+1,revision=revision+1 WHERE id=$2',
    [at, scope.sessionId],
    scope,
  );
}
test("first job includes opening and later target and permits empty frontier progress", async () => {
  const context = await newScope(admin, worker, "append-time-window"),
    target = "2026-01-01T16:00:00.000Z";
  await advance(context.scope, target);
  const job = (await claim(worker, context)).rows[0],
    active = { ...context, job };
  const opening = eventFor(active, "STORE", "0", job.checkpoint.processedThrough);
  const first = (
    await append(worker, active, [opening], {
      processedThrough: job.checkpoint.processedThrough,
      sealed: false,
    })
  ).rows[0];
  const middle = (
    await append(worker, { ...active, job: first }, [], {
      processedThrough: "2026-01-01T00:00:00.000Z",
      sealed: false,
    })
  ).rows[0];
  const last = (
    await append(worker, { ...active, job: middle }, [eventFor(active, "STORE", "0", target)], {
      processedThrough: target,
      sealed: true,
    })
  ).rows[0];
  assert.equal(last.highEventSeq, "2");
  assert.equal(last.checkpoint.chunkIndex, "3");
  assert.equal(last.checkpoint.sealed, true);
});
for (const [label, nextChange] of [
  ["before opening", () => ({ processedThrough: "2025-12-31T15:59:59.999Z", sealed: false })],
  ["after target", () => ({ processedThrough: "2026-01-01T00:00:00.000Z", sealed: false })],
  ["invalid date", () => ({ processedThrough: "2026-02-30T00:00:00.000Z", sealed: false })],
  ["unknown next field", (job) => ({ ...nextFor(job), highEventSeq: "999" })],
  ["full checkpoint", (job) => job.checkpoint],
  ["null seal", (job) => ({ ...nextFor(job), sealed: null })],
])
  test(`append rejects ${label} proposal atomically`, async () => {
    const context = await fresh(`proposal-${uniqueSuffix()}`),
      next = nextChange(context.job);
    await rejectedAppend(
      admin,
      worker,
      context,
      [],
      next,
      {},
      sqlError(["before opening", "after target"].includes(label) ? "SM004" : "SM005"),
    );
  });
for (const [label, declaration] of [
  ["null count", { eventCount: null }],
  ["object count", { eventCount: {} }],
  ["fraction count", { eventCount: 0.5 }],
  ["negative count", { eventCount: -1 }],
  ["101 count", { eventCount: 101 }],
  ["unknown declaration", { eventCount: 0, private: true }],
])
  test(`bounded declaration rejects ${label}`, async () => {
    const context = await fresh(`declaration-${uniqueSuffix()}`),
      next = nextFor(context.job, true);
    await rejectedAppend(
      admin,
      worker,
      context,
      [],
      next,
      { declaration: { ...declaration, next } },
      sqlError("SM005"),
    );
  });
for (const at of ["2025-12-31T15:59:59.999Z", "2026-01-01T00:00:00.000Z"])
  test(`first job rejects event outside inclusive interval ${at}`, async () => {
    const context = await fresh(uniqueSuffix());
    await rejectedAppend(
      admin,
      worker,
      context,
      [eventFor(context, "STORE", "0", at)],
      nextFor(context.job),
      {},
      sqlError("SM004"),
    );
  });
for (const kind of kinds)
  test(`${kind} supported partial record stages exactly`, async () => {
    const context = await fresh(`partial-${kind.toLowerCase()}`);
    const event = eventFor(context, kind, "0", utc(context.job.targetTime), (record) => {
      const field = {
        STORE: "category",
        PRODUCT: "category",
        ORDER: "paidMinor",
        REFUND: "succeededMinor",
        INVENTORY: "available",
        MARKETING: "clicks",
      }[kind];
      const issue = {
        STORE: "CATEGORY_MISSING",
        PRODUCT: "CATEGORY_MISSING",
        ORDER: "PAYMENT_UNKNOWN",
        REFUND: "REFUND_UNKNOWN",
        INVENTORY: "INVENTORY_UNKNOWN",
        MARKETING: "MARKETING_UNKNOWN",
      }[kind];
      record[field] = null;
      record.source.quality = { state: "PARTIAL", issues: [issue] };
      if (kind === "ORDER") record.paidAt = null;
      if (kind === "REFUND") record.succeededAt = null;
    });
    await append(worker, context, [event]);
    const stored = (await snapshot(admin, context)).events[0].payload;
    assert.ok(schemas[codecSchemas[kind]].safeParse(stored).success);
    assert.deepEqual({ ...stored, source: { ...stored.source, version: null } }, event.after);
  });
test("restricted reader hides every staged event/version and private job column", async () => {
  const context = await fresh("reader");
  await append(
    worker,
    context,
    kinds.map((kind) => eventFor(context, kind)),
  );
  await reader.query("BEGIN");
  try {
    await reader.query(
      "SELECT set_config('app.user_id','source-human',true),set_config('app.merchant_id','source-merchant-a',true)",
    );
    const versions = await reader.query(
      'SELECT * FROM mock_platform."EntityVersion" WHERE "sessionId"=$1',
      [context.scope.sessionId],
    );
    const jobs = await reader.query(
      'SELECT revision FROM mock_platform."BuildJob" WHERE "sessionId"=$1',
      [context.scope.sessionId],
    );
    assert.equal(versions.rowCount, 0);
    assert.equal(jobs.rowCount, 0);
    await assert.rejects(
      reader.query('SELECT checkpoint FROM mock_platform."BuildJob"'),
      sqlError("42501"),
    );
  } finally {
    await reader.query("ROLLBACK");
  }
  await assert.rejects(
    reader.query('SELECT * FROM mock_platform."SourceEvent"'),
    sqlError("42501"),
  );
});
async function rejectedBatches(context, batches, declared = 100) {
  const before = await snapshot(admin, context);
  await assert.rejects(
    sourceTransaction(
      worker,
      context.scope,
      "APPEND",
      async () => {
        const next = nextFor(context.job);
        await appendSettings(worker, context.job, [], next, {
          declaration: { eventCount: declared, next },
        });
        for (const events of batches) await insertBatch(worker, context, events, false);
        assert.fail("Pending capacity must reject the INSERT before job update or deferred commit");
      },
      leaseOf(context.job),
      context.grant,
    ),
    sqlError("SM005"),
  );
  assert.deepEqual(await snapshot(admin, context), before);
}
test("100 ordered events and versions consume exactly one bounded append", async (t) => {
  const context = await fresh("hundred"),
    events = Array.from({ length: 100 }, (_, ordinal) =>
      eventFor(context, "STORE", String(ordinal)),
    );
  const timings = {};
  const result = (await batchAppend(worker, context, [events], nextFor(context.job), 100, timings))
    .rows[0];
  t.diagnostic(JSON.stringify(timings));
  assert.equal(result.highEventSeq, "100");
  assert.equal(result.lastAppendEventCount, 100);
  const rows = await snapshot(admin, context);
  assert.equal(rows.events.length, 100);
  assert.equal(rows.versions.length, 100);
  assert.deepEqual(
    rows.events.map((event) => event.eventSeq),
    Array.from({ length: 100 }, (_, index) => index + 1),
  );
});
for (const split of [false, true])
  test(`101 actual rows cannot evade ${split ? "cumulative" : "statement"} limit`, async () => {
    const context = await fresh(`over-count-${split}`),
      events = Array.from({ length: 101 }, (_, ordinal) =>
        eventFor(context, "STORE", String(ordinal)),
      );
    await rejectedBatches(context, split ? [events.slice(0, 50), events.slice(50)] : [events]);
  });
for (const split of [false, true])
  test(`pending input and envelope bytes cannot evade ${split ? "cumulative" : "statement"} 2MiB limit`, async () => {
    const context = await fresh(`over-bytes-${split}`),
      events = Array.from({ length: 6 }, (_, index) => largeProduct(context, index));
    assert.ok(Buffer.byteLength(JSON.stringify(events[0].after)) < 262144);
    await rejectedBatches(context, split ? [events.slice(0, 3), events.slice(3)] : [events], 6);
  });
async function jsonbBytes(value) {
  return (
    await admin.query("SELECT octet_length($1::jsonb::text) AS bytes", [JSON.stringify(value)])
  ).rows[0].bytes;
}
test("source version expansion must still fit the 256KiB stored payload bound", async () => {
  const context = await fresh("stored-bound"),
    event = largeProduct(context);
  event.after.skus = Array.from({ length: 27 }, (_, index) => ({
    ...event.after.skus[0],
    externalSkuId: `sku-${index}`,
    attributes: [...event.after.skus[0].attributes],
  }));
  let bytes = await jsonbBytes(event.after);
  while (bytes > 262130) {
    event.after.skus.at(-1).attributes.pop();
    bytes = await jsonbBytes(event.after);
  }
  event.after.description += "x".repeat(262130 - bytes);
  assert.equal(await jsonbBytes(event.after), 262130);
  await rejectedAppend(
    admin,
    worker,
    context,
    [event],
    nextFor(context.job),
    {},
    sqlError("SM005"),
  );
});
test("deferred access loss rolls back a complete chunk without locking authorization rows", async () => {
  const context = await fresh("deferred-revoke"),
    before = await snapshot(admin, context),
    events = [eventFor(context)],
    next = nextFor(context.job);
  try {
    await assert.rejects(
      sourceTransaction(
        worker,
        context.scope,
        "APPEND",
        async () => {
          await appendSettings(worker, context.job, events, next);
          await insertBatch(worker, context, events);
          await updateAppend(worker, context, next);
          await admin.query('UPDATE demo."MockWorkerGrant" SET status=$1 WHERE id=$2', [
            "REVOKED",
            context.grant,
          ]);
        },
        leaseOf(context.job),
        context.grant,
      ),
      sqlError("SM001"),
    );
    assert.deepEqual(await snapshot(admin, context), before);
  } finally {
    await admin.query('UPDATE demo."MockWorkerGrant" SET status=$1 WHERE id=$2', [
      "ACTIVE",
      context.grant,
    ]);
  }
});
test("real wall lease expiry during deferred commit rolls back all new rows and progress", async () => {
  const context = await fresh("wall-expiry"),
    before = await snapshot(admin, context),
    events = [eventFor(context)],
    next = nextFor(context.job);
  await assert.rejects(
    sourceTransaction(
      worker,
      context.scope,
      "APPEND",
      async () => {
        await appendSettings(worker, context.job, events, next);
        await insertBatch(worker, context, events);
        await updateAppend(worker, context, next);
        await worker.query("SELECT pg_sleep(30.05)");
      },
      leaseOf(context.job),
      context.grant,
    ),
    sqlError("SM003"),
  );
  assert.deepEqual(await snapshot(admin, context), before);
});
async function mutationRejected(context, action, code = "SM005") {
  const before = await snapshot(admin, context);
  await assert.rejects(
    sourceTransaction(
      worker,
      context.scope,
      "APPEND",
      async () => {
        await appendSettings(worker, context.job, [eventFor(context)], nextFor(context.job));
        await action();
      },
      leaseOf(context.job),
      context.grant,
    ),
    sqlError(code),
  );
  assert.deepEqual(await snapshot(admin, context), before);
}
test("minimal rights reject caller allocated event metadata and job high count", async () => {
  const context = await fresh("column-rights");
  await mutationRejected(
    context,
    () =>
      worker.query('UPDATE mock_platform."BuildJob" SET "highEventSeq"=999 WHERE "sessionId"=$1', [
        context.scope.sessionId,
      ]),
    "42501",
  );
  const sql = eventSql
    .replace("ordinal,payload)", 'ordinal,payload,"eventId")')
    .replace("$12::jsonb)", "$12::jsonb,$13)");
  const event = eventFor(context);
  await mutationRejected(
    context,
    () =>
      worker.query(sql, [
        ...scopeValues(context.scope),
        context.job.revision,
        event.kind,
        event.occurredAt,
        event.ordinal,
        JSON.stringify(event.after),
        "0".repeat(64),
      ]),
    "42501",
  );
});
test("accidental metadata privileges cannot forge event manifest or envelope hash", async () => {
  const context = await fresh("forged-event"),
    event = eventFor(context);
  await admin.query(
    'GRANT INSERT (manifest,"envelopeHash") ON mock_platform."SourceEvent" TO shopmate_mock_source_worker',
  );
  try {
    const sql = eventSql
      .replace("ordinal,payload)", 'ordinal,payload,manifest,"envelopeHash")')
      .replace("$12::jsonb)", "$12::jsonb,$13::jsonb,$14)");
    await mutationRejected(context, () =>
      worker.query(sql, [
        ...scopeValues(context.scope),
        context.job.revision,
        event.kind,
        event.occurredAt,
        event.ordinal,
        JSON.stringify(event.after),
        "[]",
        "0".repeat(64),
      ]),
    );
  } finally {
    await admin.query(
      'REVOKE INSERT (manifest,"envelopeHash") ON mock_platform."SourceEvent" FROM shopmate_mock_source_worker',
    );
  }
});
test("accidental high/count rights cannot alter the derived job proposal", async () => {
  const context = await fresh("forged-high");
  await admin.query(
    'GRANT UPDATE ("highEventSeq","eventCount") ON mock_platform."BuildJob" TO shopmate_mock_source_worker',
  );
  try {
    const sql = appendSql.replace(
      "checkpoint=$4::jsonb",
      'checkpoint=$4::jsonb,"highEventSeq"=999,"eventCount"=999',
    );
    await mutationRejected(
      context,
      () =>
        worker.query(sql, [
          context.scope.sessionId,
          0,
          context.job.revision,
          JSON.stringify(nextFor(context.job)),
        ]),
      "SM004",
    );
  } finally {
    await admin.query(
      'REVOKE UPDATE ("highEventSeq","eventCount") ON mock_platform."BuildJob" FROM shopmate_mock_source_worker',
    );
  }
});
test("version sequence missing its exact pending event cannot commit", async () => {
  const context = await fresh("version-only");
  await mutationRejected(context, () => insertVersion(worker, context, "1"));
});
test("SET CONSTRAINTS IMMEDIATE before job advancement rejects pending facts", async () => {
  const context = await fresh("immediate-before-job");
  await mutationRejected(context, async () => {
    await insertBatch(worker, context, [eventFor(context)]);
    await worker.query("SET CONSTRAINTS ALL IMMEDIATE");
  });
});
test("suppression hooks are removed and temporary metadata rights are revoked", async () => {
  const hooks = await admin.query(
    "SELECT count(*)::integer AS count FROM pg_trigger WHERE tgname='zzz_test_suppress_append'",
  );
  assert.equal(hooks.rows[0].count, 0);
  const grants = await admin.query(
    "SELECT has_column_privilege('shopmate_mock_source_worker','mock_platform.\"BuildJob\"','highEventSeq','UPDATE') AS high,has_column_privilege('shopmate_mock_source_worker','mock_platform.\"SourceEvent\"','manifest','INSERT') AS manifest",
  );
  assert.deepEqual(grants.rows[0], { high: false, manifest: false });
});
test("revoked current grant denies a raw append before any rows are staged", async () => {
  const context = await fresh("pre-revoke");
  try {
    await admin.query('UPDATE demo."MockWorkerGrant" SET status=$1 WHERE id=$2', [
      "REVOKED",
      context.grant,
    ]);
    await reject(context, [eventFor(context)], "SM001");
  } finally {
    await admin.query('UPDATE demo."MockWorkerGrant" SET status=$1 WHERE id=$2', [
      "ACTIVE",
      context.grant,
    ]);
  }
});
for (const [label, mutate] of [
  [
    "unknown payload key",
    (record) => {
      record.private = true;
    },
  ],
  [
    "nonnull source version",
    (record) => {
      record.source.version = "forged";
    },
  ],
  [
    "source time mismatch",
    (record) => {
      record.source.updatedAt = "2026-01-01T00:00:00.000Z";
    },
  ],
  [
    "NFD display text",
    (record) => {
      record.name = "e\u0301";
    },
  ],
  [
    "201 BMP namespace",
    (record) => {
      record.externalStoreId = "商".repeat(201);
    },
  ],
  [
    "101 supplementary namespace",
    (record) => {
      record.externalStoreId = "😀".repeat(101);
    },
  ],
  [
    "unsafe generic numeric",
    (record) => {
      record.private = 9007199254740992;
    },
  ],
  [
    "oversized payload",
    (record) => {
      record.name = "x".repeat(262144);
    },
  ],
])
  test(`direct event rejects ${label} before staging`, async () => {
    const context = await fresh(`invalid-${uniqueSuffix()}`);
    await reject(context, [eventFor(context, "STORE", "0", utc(context.job.targetTime), mutate)]);
  });
for (const field of ["revision", "fence"])
  test(`valid authorized scope with replaced lease ${field} is fenced`, async () => {
    const context = await fresh(`wrong-${field}`);
    const lease = { ...leaseOf(context.job), [field]: "2" };
    await reject(context, [eventFor(context)], "SM003", { lease });
  });
for (const [label, raw, zeroCandidates] of [
  ["missing", "", true],
  ["malformed JSON", "{", false],
  ["oversized", " ".repeat(1025), true],
  [
    "numeric revision",
    '{"revision":1,"fence":"1","ownerId":"00000000-0000-4000-8000-000000000000"}',
    false,
  ],
  [
    "uppercase owner",
    '{"revision":"1","fence":"1","ownerId":"AAAAAAAA-0000-4000-8000-000000000000"}',
    false,
  ],
  [
    "zero revision",
    '{"revision":"0","fence":"1","ownerId":"00000000-0000-4000-8000-000000000000"}',
    false,
  ],
])
  test(`append lease parser rejects ${label} before ${zeroCandidates ? "zero candidates" : "staging"}`, async () => {
    const context = await fresh(`parser-${uniqueSuffix()}`);
    await mutationRejected(context, async () => {
      await worker.query("SELECT set_config('mock.source_lease',$1,true)", [raw]);
      if (zeroCandidates)
        await worker.query(
          'INSERT INTO mock_platform."SourceEvent" ("sessionId") SELECT $1 WHERE false',
          [context.scope.sessionId],
        );
      else await insertEvent(worker, context, eventFor(context));
    });
  });
test("scope authorized without a claimed job has no append lease", async () => {
  const context = await newScope(admin, worker, "append-without-job");
  context.job = {
    revision: "1",
    fence: "1",
    leaseOwner: randomUUID(),
    checkpointHash: "0".repeat(64),
    targetTime: "2025-12-31T16:00:00.000Z",
  };
  await reject(context, [eventFor(context)], "SM003");
});
test("oversized declaration and invalid expected hash fail before fact candidates", async () => {
  const context = await fresh("setting-bounds");
  await reject(context, [], "SM005", {
    declaration: { eventCount: 0, next: nextFor(context.job, true), private: "x".repeat(4096) },
  });
  await mutationRejected(context, async () => {
    await worker.query("SELECT set_config('mock.expected_checkpoint_hash','',true)");
    await insertEvent(worker, context, eventFor(context));
  });
});
test("safe monetary maximum stages without arithmetic rounding", async () => {
  const context = await fresh("monetary-max");
  const event = eventFor(context, "ORDER", "0", utc(context.job.targetTime), (record) => {
    Object.assign(record.items[0], {
      quantity: 1,
      unitPriceMinor: 9007199254740991,
      grossMinor: 9007199254740991,
      discountMinor: 0,
      netMinor: 9007199254740991,
    });
    Object.assign(record, {
      grossMinor: 9007199254740991,
      discountMinor: 0,
      shippingMinor: 0,
      payableMinor: 9007199254740991,
      paidMinor: 9007199254740991,
    });
  });
  await append(worker, context, [event]);
  assert.equal((await snapshot(admin, context)).versions[0].payload.paidMinor, 9007199254740991);
});
async function beginRawAppend(context, events) {
  await beginWorker(worker, context.scope, context.grant);
  await worker.query(
    "SELECT set_config('mock.source_op','APPEND',true),set_config('mock.source_lease',$1,true)",
    [JSON.stringify(leaseOf(context.job))],
  );
  await appendSettings(worker, context.job, events, nextFor(context.job));
}
test("raw VALUES waits on statement CONTROL then observes committed grant revocation", async () => {
  const context = await fresh("control-wait"),
    before = await snapshot(admin, context),
    event = eventFor(context);
  const pid = (await worker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  await admin.query("BEGIN");
  await admin.query("SELECT demo.lock_source_control($1)", [context.scope.sessionId]);
  try {
    await beginRawAppend(context, [event]);
    const pending = insertEvent(worker, context, event);
    const denied = assert.rejects(pending, sqlError("SM001"));
    await waitLock(admin, 1397575508, false, pid);
    await admin.query('UPDATE demo."MockWorkerGrant" SET status=$1 WHERE id=$2', [
      "REVOKED",
      context.grant,
    ]);
    await admin.query("COMMIT");
    await denied;
    await worker.query("ROLLBACK");
    assert.deepEqual(await snapshot(admin, context), before);
  } finally {
    await worker.query("ROLLBACK");
    await admin.query("ROLLBACK");
    await admin.query('UPDATE demo."MockWorkerGrant" SET status=$1 WHERE id=$2', [
      "ACTIVE",
      context.grant,
    ]);
  }
});
function productKey(context, key) {
  return eventFor(context, "PRODUCT", "0", utc(context.job.targetTime), (record) => {
    record.externalProductId = key;
    record.skus[0].externalProductId = key;
  });
}
test("same-time phase cannot regress within a raw batch", async () => {
  const context = await fresh("phase-regression");
  await mutationRejected(
    context,
    () => insertBatch(worker, context, [eventFor(context, "PRODUCT"), eventFor(context, "STORE")]),
    "SM004",
  );
});
test("same-time entity key cannot regress within a raw batch", async () => {
  const context = await fresh("key-regression");
  await mutationRejected(
    context,
    () => insertBatch(worker, context, [productKey(context, "b"), productKey(context, "a")]),
    "SM004",
  );
});
test("same-key ordinals compare as bigint within and across chunks", async () => {
  const context = await fresh("ordinal-chronology");
  const job = (
    await batchAppend(worker, context, [
      [eventFor(context, "STORE", "9"), eventFor(context, "STORE", "10")],
    ])
  ).rows[0];
  assert.equal(job.checkpoint.lastEvent.ordinal, "10");
  await reject({ ...context, job }, [eventFor(context, "STORE", "2")], "SM004");
  const last = (
    await append(worker, { ...context, job }, [eventFor(context, "STORE", "9223372036854775807")])
  ).rows[0];
  assert.equal(last.checkpoint.lastEvent.ordinal, "9223372036854775807");
});
test("C byte order preserves supplementary and BMP identity keys across chunks", async () => {
  const context = await fresh("c-chronology"),
    first = productKey(context, "\ue000"),
    second = productKey(context, "😀");
  const job = (await append(worker, context, [first])).rows[0];
  const last = (await append(worker, { ...context, job }, [second])).rows[0];
  assert.deepEqual(last.checkpoint.lastEvent.entityKey, ["PRODUCT", "😀"]);
  await reject({ ...context, job: last }, [first], "SM004");
});
test("nullable event ordinal and version sequence reject UNKNOWN rather than deriving defaults", async () => {
  const context = await fresh("null-facts");
  await reject(context, [eventFor(context, "STORE", null)]);
  await mutationRejected(context, () => insertVersion(worker, context, null));
});
for (const newJob of [false, true])
  test(`reset denies old-generation VALUES before ${newJob ? "replacement" : "missing"} lease interpretation`, async () => {
    const context = await fresh(`reset-order-${newJob}`);
    await operatorControl(
      admin,
      'UPDATE public."PlatformConnection" SET generation=1 WHERE id=$1',
      [context.scope.connectionId],
      context.scope,
    );
    const scope = { ...context.scope, generation: 1 },
      current = { ...context, scope };
    await sourceTransaction(
      worker,
      scope,
      "CLAIM",
      () => worker.query(rawInsert, rawValues(scope)),
      null,
      context.grant,
    );
    if (newJob) await claim(worker, current);
    await reject(context, [eventFor(context)], "SM001");
  });

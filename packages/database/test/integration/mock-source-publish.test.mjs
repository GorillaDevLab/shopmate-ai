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
  freshAppend,
  eventFor,
  kinds,
  append,
  nextFor,
  snapshot,
  suppression,
  batchAppend,
} from "../helpers/mock-source-append-fixture.mjs";
import {
  publish,
  seal,
  certificates,
  visibleVersions,
  readerTransaction,
  rejectedPublish,
  corruption,
  advance,
  publicationOf,
  publishSettings,
  updatePublish,
  deferredTamper,
} from "../helpers/mock-source-publish-fixture.mjs";
import {
  sqlError,
  sourceTransaction,
  leaseOf,
  change,
  newScope,
  claim,
  scopeValues,
} from "../helpers/mock-source-lease-fixture.mjs";
import { codecSchemas, partial } from "../helpers/mock-source-codec-fixture.mjs";
import * as schemas from "../../../contracts/dist/index.js";
import { randomUUID } from "node:crypto";
import { validateScope } from "../../dist/src/mock-platform/validation.js";
import { validatePublication } from "../../dist/src/mock-platform/publication-validation.js";

let server, admin, worker, reader, databaseUrl;
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
  await admin.query('CREATE DATABASE "shopmate_tenant_test_sourcepublish"');
  url.pathname = "/shopmate_tenant_test_sourcepublish";
  databaseUrl = url.toString();
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
      await cleanup.query('DROP DATABASE IF EXISTS "shopmate_tenant_test_sourcepublish"');
    } finally {
      await cleanup.end();
    }
    await server.stop();
  }
});
const fresh = (suffix, namespace) => freshAppend(admin, worker, suffix, namespace);
for (const empty of [false, true])
  test(`${empty ? "empty" : "nonempty"} sealed job publishes a reader certificate`, async () => {
    const context = await fresh(`initial-${empty}`);
    await seal(worker, context, empty ? [] : [eventFor(context)]);
    assert.equal((await visibleVersions(reader, context)).rowCount, 0);
    const job = (await publish(worker, context)).rows[0];
    assert.equal(job.state, "PUBLISHED");
    assert.equal((await certificates(reader, context)).rowCount, 1);
    assert.equal((await visibleVersions(reader, context)).rowCount, empty ? 0 : 1);
    assert.equal(job.processedThrough.toISOString(), job.targetTime.toISOString());
    assert.match(job.certificateHash, /^[a-f0-9]{64}$/u);
  });
for (const kind of kinds)
  test(`${kind} COMPLETE publication has one exact schema-valid visible version`, async () => {
    const context = await fresh(`complete-${kind}`),
      event = eventFor(context, kind);
    await seal(worker, context, [event]);
    const job = (await publish(worker, context)).rows[0];
    const row = (await visibleVersions(reader, context)).rows[0];
    assert.ok(schemas[codecSchemas[kind]].safeParse(row.payload).success);
    assert.deepEqual(row.payload, (await snapshot(admin, context)).events[0].payload);
    assert.equal(row.releaseRevision, job.revision);
    assert.equal(row.payload.source.version, "mock-runtime-v2:g:0:e:1");
    if (kind === "PRODUCT") assert.equal(row.payload.status, "DELETED");
    if (kind === "INVENTORY")
      assert.deepEqual(JSON.parse(row.entityKey), [kind, "sku", "location"]);
    if (kind === "MARKETING")
      assert.deepEqual(JSON.parse(row.entityKey), [kind, "campaign", "2024-02-29"]);
  });
const partialChanges = {
  STORE: (r) => {
    r.category = null;
    partial(r, ["CATEGORY_MISSING"]);
  },
  PRODUCT: (r) => {
    r.category = null;
    r.skus[0].costPriceMinor = null;
    partial(r, ["CATEGORY_MISSING", "COST_MISSING"]);
  },
  ORDER: (r) => {
    r.paidMinor = null;
    r.paidAt = null;
    r.refundedMinor = null;
    partial(r, ["PAYMENT_UNKNOWN", "REFUND_UNKNOWN"]);
  },
  REFUND: (r) => {
    r.succeededMinor = null;
    r.succeededAt = null;
    partial(r, ["REFUND_UNKNOWN"]);
  },
  INVENTORY: (r) => {
    r.available = null;
    r.reserved = null;
    r.onHand = null;
    partial(r, ["INVENTORY_UNKNOWN"]);
  },
  MARKETING: (r) => {
    r.clicks = null;
    partial(r, ["MARKETING_UNKNOWN"]);
  },
};
for (const kind of kinds)
  test(`${kind} PARTIAL publication retains quality and nullable values`, async () => {
    const context = await fresh(`partial-${kind}`);
    await seal(worker, context, [eventFor(context, kind, "0", undefined, partialChanges[kind])]);
    await publish(worker, context);
    const row = (await visibleVersions(reader, context)).rows[0];
    assert.ok(schemas[codecSchemas[kind]].safeParse(row.payload).success);
    assert.equal(row.payload.source.quality.state, "PARTIAL");
    assert.deepEqual(row.payload, (await snapshot(admin, context)).events[0].payload);
  });
const namespaces = ["商".repeat(200), "e\u0301".repeat(100), "𠮷".repeat(100)];
for (const [index, namespace] of namespaces.entries())
  test(`Unicode namespace ${index} publishes all six streams with exact identities`, async () => {
    const context = await fresh(`unicode-${index}`, namespace);
    await seal(
      worker,
      context,
      kinds.map((kind) => eventFor(context, kind)),
    );
    const job = (await publish(worker, context)).rows[0];
    assert.equal(job.externalStoreId, namespace);
    const cert = (await certificates(reader, context)).rows[0];
    assert.equal(cert.externalStoreId, namespace);
    const rows = (await visibleVersions(reader, context)).rows;
    assert.equal(rows.length, 6);
    for (const row of rows) {
      assert.equal(row.externalStoreId, namespace);
      assert.equal(row.payload.externalStoreId, namespace);
      assert.ok(schemas[codecSchemas[row.kind]].safeParse(row.payload).success);
    }
    assert.deepEqual(JSON.parse(rows[0].entityKey), ["STORE", namespace]);
    const stored = await snapshot(admin, context);
    assert.ok(stored.events.every((event) => event.externalStoreId === namespace));
    assert.equal(
      (
        await admin.query(
          'SELECT "externalStoreId" FROM mock_platform."Runtime" WHERE "sessionId"=$1',
          [context.scope.sessionId],
        )
      ).rows[0].externalStoreId,
      namespace,
    );
  });
test("NFD and NFC store namespaces authorize different scopes", async () => {
  const nfd = await fresh("nfd-distinct", namespaces[1]),
    nfc = await fresh("nfc-distinct", namespaces[1].normalize("NFC"));
  await seal(worker, nfd, [eventFor(nfd)]);
  await seal(worker, nfc, [eventFor(nfc)]);
  await publish(worker, nfd);
  await publish(worker, nfc);
  assert.notEqual(
    (await certificates(reader, nfd)).rows[0].externalStoreId,
    (await certificates(reader, nfc)).rows[0].externalStoreId,
  );
  const result = await sourceTransaction(
    worker,
    nfd.scope,
    "PUBLISH",
    () =>
      worker.query(
        "SELECT mock_platform.has_worker_access($3,$4,$5,$1,$6,$7,$2) AS allowed",
        scopeValues({ ...nfd.scope, externalStoreId: nfc.scope.externalStoreId }),
      ),
    leaseOf(nfd.job),
    nfd.grant,
  );
  assert.equal(result.rows[0].allowed, false);
});
for (const [label, options, code] of [
  ["changed expected base", { base: "1" }, "SM004"],
  ["changed expected checkpoint", { hash: "a".repeat(64) }, "SM004"],
  ["leading zero base", { base: "00" }, "SM005"],
  ["overflow base", { base: "9223372036854775808" }, "SM005"],
  ["oversized base", { base: "1".repeat(5000) }, "SM005"],
  ["oversized hash", { hash: "a".repeat(5000) }, "SM005"],
])
  test(`PUBLISH rejects ${label} without changes`, async () => {
    const context = await fresh(`reject-${label.replaceAll(" ", "-")}`);
    await seal(worker, context);
    await rejectedPublish(admin, worker, context, sqlError(code), options);
  });
test("unsealed target frontier cannot publish", async () => {
  const context = await fresh("unsealed");
  context.job = (await append(worker, context, [eventFor(context)])).rows[0];
  await rejectedPublish(admin, worker, context, sqlError("SM004"));
});
const corruptions = [
  [
    "missing version",
    'DELETE FROM mock_platform."EntityVersion" WHERE "sessionId"=$1 AND "eventSeq"=1',
  ],
  [
    "missing event",
    'DELETE FROM mock_platform."SourceEvent" WHERE "sessionId"=$1 AND "eventSeq"=1',
  ],
  [
    "range hole",
    'DELETE FROM mock_platform."EntityVersion" WHERE "sessionId"=$1 AND "eventSeq"=1; DELETE FROM mock_platform."SourceEvent" WHERE "sessionId"=$1 AND "eventSeq"=1',
  ],
  [
    "mismatched version payload",
    `UPDATE mock_platform."EntityVersion" SET payload=jsonb_set(payload,'{name}','"changed"') WHERE "sessionId"=$1 AND "eventSeq"=1`,
  ],
  [
    "mismatched version hash",
    `UPDATE mock_platform."EntityVersion" SET "versionHash"=repeat('a',64) WHERE "sessionId"=$1 AND "eventSeq"=1`,
  ],
  [
    "mismatched version key",
    `UPDATE mock_platform."EntityVersion" SET "entityKey"='["STORE", "wrong"]' WHERE "sessionId"=$1 AND "eventSeq"=1`,
  ],
  [
    "mismatched version revision",
    'UPDATE mock_platform."EntityVersion" SET "releaseRevision"=2 WHERE "sessionId"=$1 AND "eventSeq"=1',
  ],
  [
    "mismatched version scope",
    `UPDATE mock_platform."EntityVersion" SET "externalStoreId"='wrong' WHERE "sessionId"=$1 AND "eventSeq"=1`,
  ],
  [
    "mismatched version time",
    'UPDATE mock_platform."EntityVersion" SET "occurredAt"="occurredAt"-interval \'1 millisecond\' WHERE "sessionId"=$1 AND "eventSeq"=1',
  ],
  [
    "mismatched manifest",
    `UPDATE mock_platform."SourceEvent" SET manifest='[]'::jsonb WHERE "sessionId"=$1 AND "eventSeq"=1`,
  ],
  [
    "mismatched envelope",
    `UPDATE mock_platform."SourceEvent" SET "envelopeHash"=repeat('a',64) WHERE "sessionId"=$1 AND "eventSeq"=1`,
  ],
  [
    "mismatched identity hash",
    `UPDATE mock_platform."SourceEvent" SET "eventId"=repeat('a',64) WHERE "sessionId"=$1 AND "eventSeq"=1`,
  ],
  [
    "mismatched event phase",
    'UPDATE mock_platform."SourceEvent" SET "phaseRank"=10 WHERE "sessionId"=$1 AND "eventSeq"=1',
  ],
  [
    "future fence",
    'UPDATE mock_platform."SourceEvent" SET "acceptedFence"=2 WHERE "sessionId"=$1 AND "eventSeq"=1',
  ],
  [
    "future chunk",
    'UPDATE mock_platform."SourceEvent" SET "appendIndex"=2 WHERE "sessionId"=$1 AND "eventSeq"=1',
  ],
  [
    "changed counters",
    'UPDATE mock_platform."BuildJob" SET "highEventSeq"=3,"eventCount"=3,"versionCount"=3 WHERE "sessionId"=$1',
  ],
  [
    "changed base",
    'UPDATE mock_platform."BuildJob" SET "baseHighEventSeq"=1,"highEventSeq"=3 WHERE "sessionId"=$1',
  ],
  [
    "changed checkpoint cursor",
    `UPDATE mock_platform."BuildJob" SET checkpoint=jsonb_set(checkpoint,'{lastEvent,ordinal}','"99"') WHERE "sessionId"=$1`,
  ],
  [
    "changed checkpoint hash",
    `UPDATE mock_platform."BuildJob" SET "checkpointHash"=repeat('b',64) WHERE "sessionId"=$1`,
  ],
  [
    "extra version",
    `INSERT INTO mock_platform."EntityVersion" SELECT (jsonb_populate_record(NULL::mock_platform."EntityVersion",to_jsonb(v)||'{"eventSeq":3}'::jsonb)).* FROM mock_platform."EntityVersion" v WHERE "sessionId"=$1 AND "eventSeq"=1`,
  ],
];
async function corruptSql(sql, context) {
  // This fixture inventory contains fixed SQL only; parameters remain bound separately.
  for (const statement of sql.split(";")) await admin.query(statement, [context.scope.sessionId]);
}
for (const [index, [label, sql]] of corruptions.entries())
  test(`whole-job proof rejects ${label} and restores operator fixture`, async () => {
    const context = await fresh(`corruption-${index}`);
    await seal(worker, context, [eventFor(context), eventFor(context, "STORE", "1")]);
    await corruption(
      admin,
      context,
      () => corruptSql(sql, context),
      async () => {
        if (label === "changed checkpoint hash") context.job.checkpointHash = "b".repeat(64);
        await rejectedPublish(admin, worker, context, sqlError("SM005"));
        assert.equal((await visibleVersions(reader, context)).rowCount, 0);
      },
    );
  });
test("certificate hash is exactly the DB JSONB recipe in a non-UTC session", async () => {
  const context = await fresh("certificate-hash");
  await seal(worker, context, [eventFor(context)]);
  const before = Date.now(),
    job = (await publish(worker, context)).rows[0],
    after = Date.now();
  const certificate = publicationOf(job, context.scope);
  validatePublication({ ...certificate, certificateHash: job.certificateHash });
  const expected = (
    await admin.query(
      "SELECT mock_platform.hash_jsonb(jsonb_build_object('codec','source-certificate-v1','certificate',$1::jsonb)) AS hash",
      [JSON.stringify(certificate)],
    )
  ).rows[0].hash;
  assert.equal(job.certificateHash, expected);
  assert.ok(job.publishedAt.getTime() >= before && job.publishedAt.getTime() <= after);
  assert.match(certificate.publishedAt, /^\d{4}-\d{2}-\d{2}T.*\.\d{3}Z$/u);
  assert.equal((await worker.query("SHOW timezone")).rows[0].TimeZone, "Pacific/Auckland");
  const reader2 = await login(databaseUrl, "source_read_login");
  assert.deepEqual(
    (await certificates(reader2, context)).rows,
    (await certificates(reader, context)).rows,
  );
  await rejectedPublish(admin, worker, { ...context, job }, sqlError("SM004"));
});
for (const column of [
  "checkpoint",
  "checkpointHash",
  "leaseOwner",
  "leaseUntil",
  "leaseGrantId",
  "fence",
  "lastAppendHash",
  "failureCode",
  "mutationXid",
  "*",
])
  test(`reader cannot select private ${column}`, async () => {
    const context = await fresh(`private-${column === "*" ? "all" : column}`);
    await seal(worker, context);
    await publish(worker, context);
    await assert.rejects(
      readerTransaction(reader, context, () =>
        reader.query(
          `SELECT ${column === "*" ? "*" : '"' + column + '"'} FROM mock_platform."BuildJob" WHERE "sessionId"=$1`,
          [context.scope.sessionId],
        ),
      ),
      sqlError("42501"),
    );
  });
async function immutableAttempt(sql, context) {
  return sourceTransaction(
    worker,
    context.scope,
    "PUBLISH",
    async () => {
      await publishSettings(worker, context.job);
      return worker.query(sql, sql.startsWith("TRUNCATE") ? [] : [context.scope.sessionId]);
    },
    leaseOf(context.job),
    context.grant,
  );
}
test("published certificate stays immutable under accidental destructive and metadata rights", async () => {
  const context = await fresh("immutable");
  await seal(worker, context, [eventFor(context)]);
  context.job = (await publish(worker, context)).rows[0];
  const before = await snapshot(admin, context);
  await admin.query(
    'GRANT UPDATE("certificateHash"),DELETE,TRUNCATE ON mock_platform."BuildJob" TO shopmate_mock_source_worker',
  );
  await admin.query(
    'GRANT TRUNCATE ON mock_platform."SourceEvent",mock_platform."EntityVersion" TO shopmate_mock_source_worker',
  );
  try {
    for (const sql of [
      'UPDATE mock_platform."BuildJob" SET "certificateHash"=repeat(\'a\',64) WHERE "sessionId"=$1',
      'DELETE FROM mock_platform."BuildJob" WHERE "sessionId"=$1',
      'TRUNCATE mock_platform."BuildJob",mock_platform."SourceEvent",mock_platform."EntityVersion"',
    ])
      await assert.rejects(
        immutableAttempt(sql, context),
        sqlError(sql.startsWith("UPDATE") ? "SM004" : "SM005"),
      );
  } finally {
    await admin.query(
      'REVOKE UPDATE("certificateHash"),DELETE,TRUNCATE ON mock_platform."BuildJob" FROM shopmate_mock_source_worker',
    );
    await admin.query(
      'REVOKE TRUNCATE ON mock_platform."SourceEvent",mock_platform."EntityVersion" FROM shopmate_mock_source_worker',
    );
  }
  assert.deepEqual(await snapshot(admin, context), before);
});
test("target equals opening accepts separate private target-time chunks before publish", async () => {
  const context = await fresh("same-target"),
    initial = context.job;
  context.job = (await append(worker, context, [eventFor(context)])).rows[0];
  assert.equal(context.job.processedThrough.toISOString(), initial.targetTime.toISOString());
  assert.equal((await visibleVersions(reader, context)).rowCount, 0);
  context.job = (await append(worker, context, [eventFor(context, "STORE", "1")])).rows[0];
  await seal(worker, context);
  await publish(worker, context);
  assert.equal((await visibleVersions(reader, context)).rowCount, 2);
});
test("historical fence facts survive FAILED takeover and full publication", async () => {
  const context = await fresh("historical-fence"),
    old = context.job;
  context.job = (await append(worker, context, [eventFor(context)])).rows[0];
  const originalFacts = (await snapshot(admin, context)).events;
  context.job = (
    await change(worker, context, context.job, "FAIL", { state: "FAILED", failure: "INTERRUPTED" })
  ).rows[0];
  const replacementGrant = "publish-takeover-grant";
  await grantSource(admin, context.scope, replacementGrant);
  context.grant = replacementGrant;
  context.job = (
    await change(worker, context, context.job, "CLAIM", { state: "BUILDING", owner: randomUUID() })
  ).rows[0];
  await rejectedPublish(admin, worker, context, sqlError("SM003"), { lease: leaseOf(old) });
  await seal(worker, context, [eventFor(context, "STORE", "1")]);
  context.job = (await publish(worker, context)).rows[0];
  const facts = (await snapshot(admin, context)).events;
  assert.deepEqual(facts[0], originalFacts[0]);
  assert.deepEqual(
    facts.map((fact) => fact.acceptedFence),
    [1, 2],
  );
  assert.equal((await visibleVersions(reader, context)).rowCount, 2);
});
test("opening and target are inclusive and previous published frontier is exclusive", async () => {
  const context = await newScope(admin, worker, "publish-inclusive");
  await advance(admin, context, "2026-01-01T16:00:00.000Z");
  context.job = (await claim(worker, context)).rows[0];
  const opening = context.job.checkpoint.processedThrough;
  context.job = (
    await append(worker, context, [eventFor(context, "STORE", "0", opening)], {
      processedThrough: opening,
      sealed: false,
    })
  ).rows[0];
  await seal(worker, context, [eventFor(context)]);
  await publish(worker, context);
  const first = (await certificates(reader, context)).rows[0];
  await advance(admin, context, "2026-01-02T16:00:00.000Z");
  context.job = (await claim(worker, context)).rows[0];
  assert.equal(context.job.baseRevision, "1");
  assert.equal(context.job.baseHighEventSeq, "2");
  for (const at of [opening, first.processedThrough.toISOString()])
    await assert.rejects(
      append(worker, context, [eventFor(context, "STORE", "1", at)]),
      sqlError("SM004"),
    );
  await seal(worker, context, [eventFor(context)]);
  await publish(worker, context);
  assert.equal((await visibleVersions(reader, context)).rowCount, 3);
  assert.deepEqual((await certificates(reader, context)).rows[0], first);
});
test("frozen earlier target publishes after authorized advance and next claim freezes latest", async () => {
  const context = await fresh("frozen-target");
  const runtime = (
    await admin.query(
      'SELECT to_jsonb(r) AS value FROM mock_platform."Runtime" r WHERE "sessionId"=$1',
      [context.scope.sessionId],
    )
  ).rows[0].value;
  const frozen = context.job.targetTime.toISOString();
  await advance(admin, context, "2026-01-02T16:00:00.000Z");
  await seal(worker, context, [eventFor(context)]);
  const published = (await publish(worker, context)).rows[0];
  assert.equal(published.targetTime.toISOString(), frozen);
  assert.equal(published.targetClockRevision, context.job.targetClockRevision);
  const certified = await snapshot(admin, context);
  const second = (await claim(worker, context)).rows[0];
  assert.equal(second.targetTime.toISOString(), "2026-01-02T16:00:00.000Z");
  assert.equal(second.targetClockRevision, published.targetClockRevision + 1);
  assert.equal(second.baseRevision, published.revision);
  const afterClaim = await snapshot(admin, context);
  assert.deepEqual(afterClaim.jobs[0], certified.jobs[0]);
  assert.deepEqual(afterClaim.events, certified.events);
  assert.deepEqual(afterClaim.versions, certified.versions);
  assert.deepEqual(
    (
      await admin.query(
        'SELECT to_jsonb(r) AS value FROM mock_platform."Runtime" r WHERE "sessionId"=$1',
        [context.scope.sessionId],
      )
    ).rows[0].value,
    runtime,
  );
});
test("maximum calendar target publishes exactly without a sentinel or added millisecond", async () => {
  const context = await newScope(admin, worker, "publish-calendar-max"),
    at = "9999-12-31T23:59:59.999Z";
  await advance(admin, context, at);
  context.job = (await claim(worker, context)).rows[0];
  await seal(worker, context, [eventFor(context)]);
  const job = (await publish(worker, context)).rows[0];
  assert.equal(job.targetTime.toISOString(), at);
  assert.equal(job.processedThrough.toISOString(), at);
  assert.equal((await visibleVersions(reader, context)).rows[0].occurredAt.toISOString(), at);
  assert.equal((await claim(worker, context)).rowCount, 0);
});
async function installLaterCertificate(context) {
  return admin.query(
    `WITH shaped AS (SELECT jsonb_populate_record(NULL::mock_platform."BuildJob",to_jsonb(j)||
    jsonb_build_object('revision',2,'targetClockRevision',1,'baseRevision',1,'baseHighEventSeq',j."highEventSeq",'eventCount',0,'versionCount',0,'state','PUBLISHED','publishedAt',clock_timestamp(),'certificateHash',repeat('a',64))) AS job
    FROM mock_platform."BuildJob" j WHERE "sessionId"=$1), certified AS
    (SELECT jsonb_populate_record(job,jsonb_build_object('certificateHash',mock_platform.hash_jsonb(jsonb_build_object('codec','source-certificate-v1','certificate',mock_platform.publication_certificate(job))))) AS job FROM shaped)
    INSERT INTO mock_platform."BuildJob" SELECT (job).* FROM certified`,
    [context.scope.sessionId],
  );
}
test("reader requires its own PUBLISHED certificate even with a later published head", async () => {
  const context = await fresh("own-certificate-hole");
  await seal(worker, context, [eventFor(context)]);
  await corruption(
    admin,
    context,
    () => installLaterCertificate(context),
    async () => {
      const rows = (await certificates(reader, context)).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].revision, "2");
      assert.equal((await visibleVersions(reader, context)).rowCount, 0);
      assert.equal((await snapshot(admin, context)).versions.length, 1);
      await rejectedPublish(admin, worker, context, sqlError("SM005"));
    },
  );
});
for (const [label, setting, value, code] of [
  ["changed hash", "mock.expected_checkpoint_hash", "a".repeat(64), "SM004"],
  ["changed operation", "mock.source_op", "RENEW", "SM004"],
  [
    "changed lease",
    "mock.source_lease",
    JSON.stringify({ revision: "1", fence: "2", ownerId: "00000000-0000-4000-8000-000000000000" }),
    "SM003",
  ],
])
  test(`deferred PUBLISH rejects ${label} and rolls back certificate`, async () => {
    const context = await fresh(`final-${label.replaceAll(" ", "-")}`);
    await seal(worker, context, [eventFor(context)]);
    const before = await snapshot(admin, context);
    await assert.rejects(
      sourceTransaction(
        worker,
        context.scope,
        "PUBLISH",
        async () => {
          await publishSettings(worker, context.job);
          await updatePublish(worker, context);
          await worker.query("SELECT set_config($1,$2,true)", [setting, value]);
        },
        leaseOf(context.job),
        context.grant,
      ),
      sqlError(code),
    );
    assert.deepEqual(await snapshot(admin, context), before);
  });
test("deferred PUBLISH observes fresh grant revocation and rolls back certificate", async () => {
  const context = await fresh("final-revocation");
  await seal(worker, context, [eventFor(context)]);
  const before = await snapshot(admin, context);
  try {
    await assert.rejects(
      sourceTransaction(
        worker,
        context.scope,
        "PUBLISH",
        async () => {
          await publishSettings(worker, context.job);
          await updatePublish(worker, context);
          await admin.query("UPDATE demo.\"MockWorkerGrant\" SET status='REVOKED' WHERE id=$1", [
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
    await admin.query("UPDATE demo.\"MockWorkerGrant\" SET status='ACTIVE' WHERE id=$1", [
      context.grant,
    ]);
  }
});
test("deferred PUBLISH rejects real wall lease expiry and preserves staged facts", async () => {
  const context = await fresh("final-expiry");
  await seal(worker, context, [eventFor(context)]);
  const before = await snapshot(admin, context);
  await assert.rejects(
    sourceTransaction(
      worker,
      context.scope,
      "PUBLISH",
      async () => {
        await publishSettings(worker, context.job);
        await updatePublish(worker, context);
        await worker.query("SELECT pg_sleep(30.05)");
      },
      leaseOf(context.job),
      context.grant,
    ),
    sqlError("SM003"),
  );
  assert.deepEqual(await snapshot(admin, context), before);
  context.job = (
    await change(worker, context, context.job, "CLAIM", { owner: randomUUID() })
  ).rows[0];
  assert.equal(context.job.fence, "2");
  await publish(worker, context);
  assert.deepEqual((await snapshot(admin, context)).events, before.events);
  assert.equal((await visibleVersions(reader, context)).rowCount, 1);
});
const proposals = [
  ["caller certificate hash", '"certificateHash"', "repeat('a',64)"],
  ["caller published time", '"publishedAt"', "clock_timestamp()"],
  ["caller counters", '"eventCount","versionCount","highEventSeq"', "2"],
  ["caller frozen target", '"targetTime"', "\"targetTime\"+interval '1 millisecond'"],
  ["caller base", '"baseRevision"', "1"],
  ["caller checkpoint", "checkpoint", "'{}'::jsonb"],
  ["caller fence", "fence", "2"],
];
async function rejectProposal(context, columns, value) {
  const assignments = columns
    .split(",")
    .map((column) => `${column}=${value}`)
    .join(",");
  return sourceTransaction(
    worker,
    context.scope,
    "PUBLISH",
    async () => {
      await publishSettings(worker, context.job);
      return worker.query(
        `UPDATE mock_platform."BuildJob" SET state='PUBLISHED',${assignments} WHERE "sessionId"=$1`,
        [context.scope.sessionId],
      );
    },
    leaseOf(context.job),
    context.grant,
  );
}
for (const [index, [label, columns, value]] of proposals.entries())
  test(`PUBLISH rejects ${label} even with accidental column grants`, async () => {
    const context = await fresh(`caller-proof-${index}`);
    await seal(worker, context, [eventFor(context)]);
    const before = await snapshot(admin, context);
    if (columns !== "checkpoint")
      await admin.query(
        `GRANT UPDATE (${columns}) ON mock_platform."BuildJob" TO shopmate_mock_source_worker`,
      );
    try {
      await assert.rejects(rejectProposal(context, columns, value), sqlError("SM004"));
    } finally {
      if (columns !== "checkpoint")
        await admin.query(
          `REVOKE UPDATE (${columns}) ON mock_platform."BuildJob" FROM shopmate_mock_source_worker`,
        );
    }
    assert.deepEqual(await snapshot(admin, context), before);
  });
for (const namespace of ["商".repeat(201), "𠮷".repeat(101)])
  test(`oversized ${namespace.length}-unit namespace rejects pure validation and direct event SQL`, async () => {
    const context = await fresh(`invalid-namespace-${namespace.length}`);
    assert.throws(
      () => validateScope({ ...context.scope, externalStoreId: namespace }),
      (error) => error.code === "SOURCE_INPUT",
    );
    const before = await snapshot(admin, context);
    await assert.rejects(
      append(worker, context, [
        eventFor(context, "STORE", "0", undefined, (record) => {
          record.externalStoreId = namespace;
        }),
      ]),
      sqlError("SM005"),
    );
    assert.deepEqual(await snapshot(admin, context), before);
  });
function maximumOrder(record) {
  Object.assign(record.items[0], {
    quantity: 1,
    unitPriceMinor: Number.MAX_SAFE_INTEGER,
    grossMinor: Number.MAX_SAFE_INTEGER,
    discountMinor: 0,
    netMinor: Number.MAX_SAFE_INTEGER,
  });
  Object.assign(record, {
    grossMinor: Number.MAX_SAFE_INTEGER,
    discountMinor: 0,
    shippingMinor: 0,
    payableMinor: Number.MAX_SAFE_INTEGER,
    paidMinor: Number.MAX_SAFE_INTEGER,
  });
}
test("maximum safe money survives actual publish and reader schemas", async () => {
  const context = await fresh("publish-money-max");
  await seal(worker, context, [eventFor(context, "ORDER", "0", undefined, maximumOrder)]);
  await publish(worker, context);
  const record = (await visibleVersions(reader, context)).rows[0].payload;
  assert.equal(record.paidMinor, Number.MAX_SAFE_INTEGER);
  assert.ok(schemas.ConnectorOrderSchema.safeParse(record).success);
});
test("complete 100-event chunk publishes under the unchanged real lease", async (t) => {
  const context = await fresh("publish-max100"),
    timings = {};
  const events = Array.from({ length: 100 }, (_, index) =>
    eventFor(context, "STORE", String(index)),
  );
  context.job = (
    await batchAppend(worker, context, [events], nextFor(context.job, true), 100, timings)
  ).rows[0];
  context.job = (await change(worker, context, context.job, "RENEW")).rows[0];
  const started = Date.now(),
    job = (await publish(worker, context)).rows[0];
  t.diagnostic(
    `Actual append=${timings.totalMs}ms; separate authorized RENEW; publish=${Date.now() - started}ms; fixed lease=30s`,
  );
  assert.equal(job.eventCount, "100");
  assert.equal(job.versionCount, "100");
  assert.equal((await visibleVersions(reader, context)).rowCount, 100);
});
async function assertRestored() {
  const rows = await admin.query(
    "SELECT tgname FROM pg_trigger WHERE tgname LIKE '%test%' AND tgrelid IN ('mock_platform.\"BuildJob\"'::regclass,'mock_platform.\"SourceEvent\"'::regclass,'mock_platform.\"EntityVersion\"'::regclass)",
  );
  assert.equal(rows.rowCount, 0);
  const rights = (
    await admin.query(
      "SELECT has_column_privilege('shopmate_mock_source_worker','mock_platform.\"BuildJob\"','certificateHash','UPDATE') AS metadata,has_table_privilege('shopmate_mock_source_worker','mock_platform.\"BuildJob\"','TRUNCATE') AS destructive,has_column_privilege('shopmate_mock_source_worker','mock_platform.\"SourceEvent\"','envelopeHash','UPDATE') AS fact",
    )
  ).rows[0];
  assert.equal(rights.metadata, false);
  assert.equal(rights.destructive, false);
  assert.equal(rights.fact, false);
  const hooks = (
    await admin.query(
      `SELECT count(*)::integer AS count FROM pg_policy WHERE polname='test_publish_tamper'`,
    )
  ).rows[0];
  assert.equal(hooks.count, 0);
  const disabled = await admin.query(
    `SELECT 1 FROM pg_trigger WHERE tgenabled='D' AND tgrelid IN ('mock_platform."BuildJob"'::regclass,'mock_platform."SourceEvent"'::regclass,'mock_platform."EntityVersion"'::regclass)`,
  );
  assert.equal(disabled.rowCount, 0);
}
test("deferred whole-job proof detects post-UPDATE physical tampering and rolls it back", async () => {
  const context = await fresh("deferred-physical-proof");
  await seal(worker, context, [eventFor(context)]);
  const before = await snapshot(admin, context);
  await deferredTamper(admin, async () => {
    await assert.rejects(
      sourceTransaction(
        worker,
        context.scope,
        "PUBLISH",
        async () => {
          await publishSettings(worker, context.job);
          assert.equal((await updatePublish(worker, context)).rowCount, 1);
          assert.equal(
            (
              await worker.query(
                'SELECT "envelopeHash" FROM mock_platform."SourceEvent" WHERE "sessionId"=$1',
                [context.scope.sessionId],
              )
            ).rows[0].envelopeHash,
            "a".repeat(64),
          );
        },
        leaseOf(context.job),
        context.grant,
      ),
      sqlError("SM005"),
    );
  });
  assert.deepEqual(await snapshot(admin, context), before);
  assert.equal((await visibleVersions(reader, context)).rowCount, 0);
});
async function certificateBytes(client, context) {
  return sourceTransaction(
    client,
    context.scope,
    "PUBLISH",
    () =>
      client.query(
        'SELECT mock_platform.publication_certificate(j)::text AS bytes,"certificateHash" FROM mock_platform."BuildJob" j WHERE "sessionId"=$1 AND revision=$2',
        [context.scope.sessionId, context.job.revision],
      ),
    leaseOf(context.job),
    context.grant,
  );
}
test("recreated worker clients read identical canonical certificate bytes across timezones", async () => {
  const context = await fresh("recreated-worker");
  await seal(worker, context, [eventFor(context)]);
  context.job = (await publish(worker, context)).rows[0];
  const before = await snapshot(admin, context),
    first = await certificateBytes(worker, context);
  const worker2 = await login(databaseUrl, "source_worker_login");
  await worker2.query("SET timezone='America/New_York'");
  assert.deepEqual((await certificateBytes(worker2, context)).rows, first.rows);
  assert.deepEqual(await snapshot(admin, context), before);
});
test("suppressed PUBLISH update grants no certificate or reader visibility", async () => {
  const context = await fresh("suppressed-publish");
  await seal(worker, context, [eventFor(context)]);
  const before = await snapshot(admin, context);
  await suppression(admin, "BuildJob", async () => {
    assert.equal((await publish(worker, context)).rowCount, 0);
    assert.deepEqual(await snapshot(admin, context), before);
    assert.equal((await visibleVersions(reader, context)).rowCount, 0);
  });
});
test("operator hooks and accidental publication grants are fully restored", assertRestored);

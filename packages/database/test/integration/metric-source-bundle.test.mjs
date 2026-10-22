import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import {
  createMetricFixture,
  closeMetricFixture,
  seedFacts,
  sourceSql,
  binding,
  window,
  cutoff,
  actor,
  advance,
  startJob,
  commitPage,
  sourceIdentity,
  waitForSourceInsertLock,
} from "../helpers/metric-source-bundle-fixture.mjs";
import { canonicalRecord } from "../helpers/canonical-page-fixture.mjs";
import { operatorControl } from "../helpers/mock-source-control-fixture.mjs";
import { createMetricSourceBundleRepository } from "../../src/index.ts";
import { decodeNormalizedMetricSourceBundle } from "../../src/metric-source-bundle.decode.ts";

let database;
test.before(async () => {
  database = await createMetricFixture();
  await seedFacts(database);
});
test.after(async () => {
  if (database) await closeMetricFixture(database);
});
test("the normalized source archive is constrained and immutable", async () => {
  const table = await database.admin.query(
    "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=to_regclass('public.metric_source_bundles')",
  );
  assert.deepEqual(table.rows, [{ relrowsecurity: true, relforcerowsecurity: true }]);
  const capture = await database.admin.query(
    "SELECT to_regprocedure('public.metric_source_capture(jsonb,jsonb,timestamp with time zone)') IS NOT NULL AS present",
  );
  assert.equal(capture.rows[0].present, true);
});
async function capture(at = cutoff, inputWindow = window, scope = binding) {
  return (
    await sourceSql(database, "SELECT public.metric_source_capture($1,$2,$3) AS bundle", [
      scope,
      inputWindow,
      at,
    ])
  ).rows[0].bundle;
}
test("restricted capture archives real normalized facts and complete receipt proof idempotently", async () => {
  const first = await capture();
  assert.ok(first);
  assert.equal(first.payload.orders[0].data.paidMinor, 100);
  assert.equal(first.payload.refunds[0].data.externalOrderId, "one");
  assert.equal(first.payload.prefixes.length, 4);
  assert.equal(first.payload.prefixes[0].receipts.length, 1);
  assert.deepEqual(await capture(), first);
  for (const operation of [
    "UPDATE public.metric_source_bundles SET payload=payload",
    "DELETE FROM public.metric_source_bundles",
    "TRUNCATE public.metric_source_bundles",
  ])
    await assert.rejects(database.admin.query(operation), /Immutable metric source archive/u);
  await assert.rejects(
    sourceSql(database, "INSERT INTO public.metric_source_bundles DEFAULT VALUES"),
    /permission denied/u,
  );
  await assert.rejects(sourceSql(database, 'SELECT * FROM sync_host."Job"'), /permission denied/u);
});
test("future, foreign and malformed capture requests fail closed", async () => {
  assert.equal(await capture("2026-01-03T00:00:00.000Z"), null);
  assert.equal(await capture(cutoff, window, { ...binding, externalStoreId: "foreign" }), null);
  assert.equal(await capture(cutoff, { ...window, injected: true }), null);
  assert.equal(
    await capture(cutoff, { ...window, periodStart: "2026-01-01T00:00:00.0001Z" }),
    null,
  );
});
test("the source repository strictly decodes archived normalized DTOs", async () => {
  const exports = await import("../../src/index.ts");
  assert.equal(typeof exports.createMetricSourceBundleRepository, "function");
  const { actor } = await import("../helpers/metric-source-bundle-fixture.mjs");
  const repository = exports.createMetricSourceBundleRepository({ pool: database.pool, actor });
  assert.deepEqual(await repository.resolve(binding.storeId), { ok: true, value: binding });
  const result = await repository.capture({ binding, window, visibleAt: cutoff });
  assert.equal(result.ok, true);
  assert.equal(result.value.orders[0].data.paidMinor, 100);
  assert.ok(Object.isFrozen(result.value.orders[0].data));
  assert.match(result.value.evidenceIds[0], /^metric-evidence-v1:[a-f0-9]{64}$/u);
});
test("equivalent timestamp spellings share a revision and submillisecond windows are rejected", async () => {
  const repository = createMetricSourceBundleRepository({ pool: database.pool, actor });
  const canonical = await repository.capture({ binding, window, visibleAt: cutoff });
  const alternate = {
    ...window,
    periodStart: "2026-01-01T00:00:00Z",
    periodEnd: "2026-01-02T00:00:00Z",
  };
  const equivalent = await repository.capture({
    binding,
    window: alternate,
    visibleAt: "2026-01-02T00:00:00Z",
  });
  assert.equal(equivalent.ok, true);
  assert.equal(equivalent.value.inputRevision, canonical.value.inputRevision);
  const malformed = await repository.capture({
    binding,
    window: { ...window, periodStart: "2026-01-01T00:00:00.0001Z" },
    visibleAt: cutoff,
  });
  assert.equal(malformed.error.code, "INVALID_INPUT");
});
test("migration rejects an unsafe pre-existing capability role", async () => {
  const sql = await readFile(
    new URL(
      "../../prisma/migrations/20261022090000_metric_source_bundles/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await database.admin.query("BEGIN");
  try {
    await database.admin.query("ALTER ROLE shopmate_metric_source LOGIN");
    await assert.rejects(
      database.admin.query(sql.match(/DO \$\$[\s\S]*?END \$\$;/u)[0]),
      /Unsafe metric source capability role/u,
    );
  } finally {
    await database.admin.query("ROLLBACK");
  }
});
test("a new store uses actual runtime opening rather than configured inactive history", async () => {
  const fresh = await createMetricFixture("new");
  try {
    const at = "2026-01-18T00:00:00.000Z";
    const watermark = "2026-01-17T23:00:00.000Z";
    await advance(fresh, at);
    const repository = createMetricSourceBundleRepository({ pool: fresh.pool, actor });
    const query = {
      binding,
      window: { ...window, periodStart: "2026-01-17T00:00:00.000Z", periodEnd: at },
      visibleAt: at,
    };
    assert.equal((await repository.capture(query)).error.code, "SOURCE_UNAVAILABLE");
    for (const stream of ["ORDERS", "REFUNDS", "INVENTORY", "MARKETING"]) {
      await commitPage(fresh, await startJob(fresh, stream, at), [], {
        sourceWatermark: watermark,
      });
    }
    assert.equal((await repository.capture(query)).error.code, "SOURCE_UNAVAILABLE");
    const result = await repository.capture({
      ...query,
      window: { ...query.window, periodEnd: watermark },
    });
    assert.equal(result.ok, true);
    assert.equal(result.value.sourceOpening, "2026-01-16T16:00:00.000Z");
    assert.deepEqual(result.value.orders, []);
  } finally {
    await closeMetricFixture(fresh);
  }
});
test("unsafe login attributes and SET ROLE escalation cannot capture source bytes", async () => {
  const repository = createMetricSourceBundleRepository({ pool: database.pool, actor });
  await database.admin.query("ALTER ROLE metric_source_login CREATEDB");
  try {
    assert.equal(
      (await repository.capture({ binding, window, visibleAt: cutoff })).error.code,
      "SOURCE_UNAVAILABLE",
    );
  } finally {
    await database.admin.query("ALTER ROLE metric_source_login NOCREATEDB");
  }
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await sourceIdentity(client);
    await client.query("SET LOCAL ROLE shopmate_metric_source");
    const result = await client.query("SELECT public.metric_source_capture($1,$2,$3) bundle", [
      binding,
      window,
      cutoff,
    ]);
    assert.equal(result.rows[0].bundle, null);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
test("strict decoder rejects unknown fields, unsafe integers and contradictory source proof", async () => {
  const source = await capture();
  for (const mutate of [
    (value) => {
      value.payload.orders[0].data.customer = "private";
    },
    (value) => {
      value.payload.orders[0].data.paidMinor = Number.MAX_SAFE_INTEGER + 1;
    },
    (value) => {
      value.payload.prefixes[0].proof.pageCount = 2;
    },
    (value) => {
      value.payload.generation = 0.1;
    },
    (value) => {
      value.payload.orders[0].observedAt = "2026-01-03T00:00:00.000Z";
    },
  ]) {
    const malformed = globalThis.structuredClone(source);
    mutate(malformed);
    assert.throws(() => decodeNormalizedMetricSourceBundle(malformed));
  }
});
test("current membership and merchant ownership are refreshed on every archive read", async () => {
  const repository = createMetricSourceBundleRepository({ pool: database.pool, actor });
  const source = await repository.capture({ binding, window, visibleAt: cutoff });
  const request = { binding, window, visibleAt: cutoff, inputRevision: source.value.inputRevision };
  await database.admin.query(
    'UPDATE "OrganizationMember" SET status=\'INACTIVE\' WHERE "organizationId"=$1 AND "userId"=$2',
    [actor.organizationId, actor.userId],
  );
  try {
    assert.equal((await repository.read(request)).error.code, "NOT_FOUND");
  } finally {
    await database.admin.query(
      'UPDATE "OrganizationMember" SET status=\'ACTIVE\' WHERE "organizationId"=$1 AND "userId"=$2',
      [actor.organizationId, actor.userId],
    );
  }
  const foreign = createMetricSourceBundleRepository({
    pool: database.pool,
    actor: { ...actor, merchantId: "source-merchant-b" },
  });
  assert.equal((await foreign.read(request)).error.code, "NOT_FOUND");
  assert.equal(
    (
      await repository.read({
        ...request,
        window: { ...window, periodStart: "2026-01-01T01:00:00.000Z" },
      })
    ).error.code,
    "NOT_FOUND",
  );
  assert.equal(
    (await repository.read({ ...request, inputRevision: `p2-normalized-v1:${"0".repeat(64)}` }))
      .error.code,
    "NOT_FOUND",
  );
});
test("concurrent identical captures both resolve the immutable winning revision", async () => {
  const repository = createMetricSourceBundleRepository({ pool: database.pool, actor });
  const uniqueWindow = { ...window, periodStart: "2026-01-01T02:00:00.000Z" };
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await sourceIdentity(client);
    const first = (
      await client.query("SELECT public.metric_source_capture($1,$2,$3) bundle", [
        binding,
        uniqueWindow,
        cutoff,
      ])
    ).rows[0].bundle;
    const second = repository.capture({ binding, window: uniqueWindow, visibleAt: cutoff });
    await waitForSourceInsertLock(database);
    await client.query("COMMIT");
    const result = await second;
    assert.equal(result.ok, true);
    assert.equal(result.value.inputRevision, first.inputRevision);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
test("late real P2 pages create a new revision and exact old source bytes remain replayable", async () => {
  const repository = createMetricSourceBundleRepository({ pool: database.pool, actor });
  const archived = await repository.capture({ binding, window, visibleAt: cutoff });
  const visibleAt = "2026-01-03T00:00:00.000Z";
  assert.equal(
    (await repository.capture({ binding, window, visibleAt })).error.code,
    "SOURCE_UNAVAILABLE",
  );
  await advance(database, visibleAt);
  const first = await repository.capture({ binding, window, visibleAt });
  const late = canonicalRecord("ORDERS", "late", "2026-01-02T12:00:00.000Z");
  await commitPage(database, await startJob(database, "ORDERS", visibleAt), [late], {
    sourceWatermark: visibleAt,
  });
  const next = await repository.capture({ binding, window, visibleAt });
  assert.equal(next.ok, true);
  assert.notEqual(next.value.inputRevision, first.value.inputRevision);
  assert.equal(next.value.orders.length, 2);
  assert.deepEqual(
    await repository.read({ binding, window, visibleAt, inputRevision: first.value.inputRevision }),
    first,
  );
  assert.equal(await capture(), null);
  assert.deepEqual(
    await repository.read({
      binding,
      window,
      visibleAt: cutoff,
      inputRevision: archived.value.inputRevision,
    }),
    archived,
  );
});
test("a real order replacement is captured with coherent lines and receipt proof", async () => {
  const repository = createMetricSourceBundleRepository({ pool: database.pool, actor });
  const visibleAt = "2026-01-04T00:00:00.000Z";
  const job = await startJob(database, "ORDERS", visibleAt);
  await database.worker.query("BEGIN");
  let original;
  try {
    await commitPage(database, job, [correctedOrder()], { sourceWatermark: visibleAt });
    original = await repository.capture({ binding, window, visibleAt: "2026-01-03T00:00:00.000Z" });
    assert.equal(
      original.value.orders.find((entry) => entry.data.externalOrderId === "one").data.paidMinor,
      100,
    );
    await database.worker.query("COMMIT");
  } catch (error) {
    await database.worker.query("ROLLBACK");
    throw error;
  }
  assert.equal(await capture("2026-01-03T00:00:00.000Z"), null);
  await advance(database, visibleAt);
  const updated = await repository.capture({ binding, window, visibleAt });
  const order = updated.value.orders.find((entry) => entry.data.externalOrderId === "one").data;
  assert.equal(order.paidMinor, 200);
  assert.equal(order.items[0].netMinor, 200);
  assert.deepEqual(
    await repository.read({
      binding,
      window,
      visibleAt: original.value.visibleAt,
      inputRevision: original.value.inputRevision,
    }),
    original,
  );
});
function correctedOrder() {
  const order = canonicalRecord("ORDERS", "one", "2026-01-03T12:00:00.000Z");
  return {
    ...order,
    grossMinor: 200,
    payableMinor: 200,
    paidMinor: 200,
    items: [{ ...order.items[0], unitPriceMinor: 200, grossMinor: 200, netMinor: 200 }],
  };
}
test("applied incomplete pages and terminal null watermarks never prove a clean source", async () => {
  const at = "2026-01-04T00:00:00.000Z";
  const job = await startJob(database, "INVENTORY", at);
  await commitPage(
    database,
    job,
    [canonicalRecord("INVENTORY", "two", "2026-01-02T12:00:00.000Z")],
    { nextCursor: "next", sourceWatermark: at },
  );
  assert.equal(await capture(at), null);
  await commitPage(database, job, [], {
    pageId: "last",
    expectedCursor: "next",
    sourceWatermark: null,
  });
  assert.equal(await capture(at), null);
});
test("disconnected and old-generation sources cannot read existing archives", async () => {
  const repository = createMetricSourceBundleRepository({ pool: database.pool, actor });
  const archived = (
    await database.admin.query(
      'SELECT "inputRevision",payload FROM public.metric_source_bundles ORDER BY "capturedAt" LIMIT 1',
    )
  ).rows[0];
  const request = {
    binding,
    window,
    visibleAt: archived.payload.visibleAt,
    inputRevision: archived.inputRevision,
  };
  for (const change of ["status='DISCONNECTED'", "generation=1"]) {
    await operatorControl(database.admin, `UPDATE "PlatformConnection" SET ${change} WHERE id=$1`, [
      binding.connectionId,
    ]);
    assert.equal((await repository.read(request)).error.code, "NOT_FOUND");
    await operatorControl(
      database.admin,
      "UPDATE \"PlatformConnection\" SET status='ACTIVE',generation=0 WHERE id=$1",
      [binding.connectionId],
    );
  }
});

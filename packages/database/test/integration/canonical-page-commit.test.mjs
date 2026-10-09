import { canonicalRecord as record } from "../helpers/canonical-page-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { fileURLToPath, URL } from "node:url";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { isolatedPostgres } from "../helpers/isolated-postgres.mjs";
import { migrateSource, sourceFixtures, loginUrl } from "../helpers/mock-platform-fixture.mjs";
import { connectSyncWorker, createSyncGrant, syncScope } from "../helpers/sync-host-fixture.mjs";
import { operatorControl } from "../helpers/mock-source-control-fixture.mjs";

const since = "2026-01-01T00:00:00.000Z";
const until = "2026-01-02T00:00:00.000Z";
let server, admin, worker, foreign, url;
const jobs = new Map();
const streams = ["ORDERS", "REFUNDS", "INVENTORY", "MARKETING"];
const page = (items, nextCursor = "next") => ({
  items,
  nextCursor,
  observedAt: until,
  sourceWatermark: null,
});
async function createJob(
  stream,
  id = stream,
  client = worker,
  scope = syncScope(),
  grant = "sync-grant-a",
  requestedSince = since,
) {
  await client.query(
    'INSERT INTO sync_host."Job" (id,"grantId","organizationId","workspaceId","storeId","connectionId","externalStoreId",provider,generation,stream,since,until) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [
      id,
      grant,
      scope.organizationId,
      scope.workspaceId,
      scope.storeId,
      scope.connectionId,
      scope.externalStoreId,
      scope.provider,
      scope.generation,
      stream,
      requestedSince,
      until,
    ],
  );
  const fence = (
    await client.query(
      'UPDATE sync_host."Job" SET status=$1,fence=fence+1,"leaseOwner"=$2 WHERE id=$3 RETURNING fence',
      ["RUNNING", "worker", id],
    )
  ).rows[0].fence;
  jobs.set(id, fence);
}
async function commit(
  stream,
  input,
  id = "first",
  cursor = null,
  client = worker,
  fence = jobs.get(stream),
) {
  return (
    await client.query("SELECT sync_host.commit_canonical_page($1,$2,$3,$4,$5::jsonb) AS result", [
      stream,
      fence,
      id,
      cursor,
      JSON.stringify(input),
    ])
  ).rows[0].result;
}
async function snapshot() {
  return (
    await admin.query(`SELECT (SELECT count(*)::int FROM sync_host."CanonicalPageCommit") commits,
    (SELECT count(*)::int FROM sync_host."PageReceipt") receipts,
    (SELECT count(*)::int FROM commerce."OrderListing") orders,
    (SELECT count(*)::int FROM commerce."OrderLineListing") lines,
    (SELECT count(*)::int FROM commerce."RefundListing") refunds,
    (SELECT count(*)::int FROM commerce."InventoryListing") inventory,
    (SELECT count(*)::int FROM commerce."CampaignMetricListing") marketing`)
  ).rows[0];
}
test.before(async () => {
  server = await isolatedPostgres();
  const operator = new pg.Client({ connectionString: server.url });
  await operator.connect();
  try {
    await operator.query('CREATE DATABASE "shopmate_tenant_test_canonicalcommit"');
  } finally {
    await operator.end();
  }
  const parsed = new URL(server.url);
  parsed.pathname = "/shopmate_tenant_test_canonicalcommit";
  url = parsed.toString();
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await migrateSource(admin);
  await sourceFixtures(admin);
  for (const login of ["sync_worker_login", "sync_foreign_login"]) {
    await admin.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT shopmate_sync_worker TO ${login}`);
  }
  await createSyncGrant(admin, syncScope(), "sync-grant-a");
  await createSyncGrant(admin, syncScope("b"), "sync-grant-b", "sync_foreign_login");
  worker = await connectSyncWorker(url);
  foreign = await connectSyncWorker(url, "sync_foreign_login", "sync-grant-b");
  for (const stream of streams) await createJob(stream);
});
test.after(async () => {
  await Promise.allSettled([worker?.end(), foreign?.end(), admin?.end()]);
  await server?.stop();
});
test("all typed streams commit atomically and exact redelivery returns immutable counts", async () => {
  for (const stream of streams) {
    const input = page([record(stream)]);
    assert.equal((await commit(stream, input)).appliedCount, 1);
    assert.equal((await commit(stream, input)).status, "REPLAYED");
    await assert.rejects(commit(stream, page([record(stream, "changed")])), { code: "23505" });
  }
  assert.deepEqual(await snapshot(), {
    commits: 4,
    receipts: 4,
    orders: 1,
    lines: 1,
    refunds: 1,
    inventory: 1,
    marketing: 1,
  });
  for (const row of (
    await admin.query(
      'SELECT status,cursor,"successfulThrough","receiptCursor" FROM sync_host."Job"',
    )
  ).rows)
    assert.deepEqual(row, {
      status: "RUNNING",
      cursor: null,
      successfulThrough: null,
      receiptCursor: "next",
    });
});
test("invalid records quarantine safely; older/equal/newer opaque source evidence orders consistently", async () => {
  for (const stream of streams) {
    const current = record(stream);
    const newer = record(stream, "one", "2026-01-01T01:00:00Z");
    newer.source.version = "opaque:1";
    const bad = {
      ...record(stream, "bad"),
      source: { ...current.source, quality: { state: "PARTIAL", issues: ["BOGUS"] } },
    };
    const first = await commit(stream, page([current, bad, newer], "two"), "second", "next");
    assert.equal(first.duplicateCount, 1);
    assert.equal(first.quarantinedCount, 1);
    assert.equal(first.appliedCount, 1);
    const conflict = globalThis.structuredClone(newer);
    conflict.source.version = "opaque:different";
    const second = await commit(stream, page([current, conflict], "three"), "third", "two");
    assert.equal(second.staleCount, 1);
    assert.equal(second.quarantinedCount, 1);
  }
  assert.ok(
    (await admin.query('SELECT reason FROM sync_host."CanonicalQuarantine"')).rows.every((row) =>
      ["INVALID_RECORD", "SOURCE_CONFLICT"].includes(row.reason),
    ),
  );
});
test("foreign store and malformed/budget pages reject whole page", async () => {
  const before = await snapshot();
  await assert.rejects(
    commit(
      "ORDERS",
      page([
        record("ORDERS", "valid"),
        { ...record("ORDERS", "foreign"), externalStoreId: "foreign" },
      ]),
      "bad",
      "three",
    ),
    { code: "23514" },
  );
  await assert.rejects(commit("ORDERS", { ...page([]), extra: 1 }, "extra", "three"), {
    code: "23514",
  });
  await assert.rejects(
    commit("ORDERS", page(Array.from({ length: 201 }, () => record("ORDERS"))), "budget", "three"),
    { code: "23514" },
  );
  assert.deepEqual(await snapshot(), before);
});
test("unknown amounts and absent time stay null; only identical unknown evidence duplicates", async () => {
  for (const stream of streams) {
    const item = record(stream, "unknown", null);
    const unknown = {
      ORDERS: ["paidMinor", "refundedMinor"],
      REFUNDS: ["succeededMinor"],
      INVENTORY: ["available", "reserved", "onHand"],
      MARKETING: [
        "impressions",
        "clicks",
        "attributedOrders",
        "spendMinor",
        "attributedRevenueMinor",
      ],
    }[stream];
    for (const key of unknown) item[key] = null;
    item.source.quality = {
      state: "PARTIAL",
      issues: [
        "SOURCE_TIME_MISSING",
        ...{
          ORDERS: ["PAYMENT_UNKNOWN", "REFUND_UNKNOWN"],
          REFUNDS: ["REFUND_UNKNOWN"],
          INVENTORY: ["INVENTORY_UNKNOWN"],
          MARKETING: ["MARKETING_UNKNOWN"],
        }[stream],
      ],
    };
    if (stream === "ORDERS") item.paidAt = null;
    if (stream === "REFUNDS") item.succeededAt = null;
    const result = await commit(stream, page([item, item], "four"), "unknown", "three");
    assert.equal(result.appliedCount, 1);
    assert.equal(result.duplicateCount, 1);
    const conflict = globalThis.structuredClone(item);
    conflict.source.version = "other";
    const known = globalThis.structuredClone(item);
    known.source.updatedAt = since;
    const next = await commit(stream, page([conflict, known], "five"), "unknown-conflict", "four");
    assert.equal(next.quarantinedCount, 2);
    const table = {
      ORDERS: "OrderListing",
      REFUNDS: "RefundListing",
      INVENTORY: "InventoryListing",
      MARKETING: "CampaignMetricListing",
    }[stream];
    const key = {
      ORDERS: "externalOrderId",
      REFUNDS: "externalRefundId",
      INVENTORY: "externalSkuId",
      MARKETING: "externalCampaignId",
    }[stream];
    const row = (
      await admin.query(`SELECT * FROM commerce."${table}" WHERE "${key}"=$1`, ["unknown"])
    ).rows[0];
    assert.equal(row.sourceUpdatedAt, null);
    for (const field of unknown) assert.equal(row[field], null);
  }
});
test("orders replace all lines atomically and sort-independent payloads duplicate", async () => {
  const item = record("ORDERS", "one", "2026-01-01T02:00:00Z");
  item.items = [
    { ...item.items[0], externalLineId: "second", quantity: 2, grossMinor: 200, netMinor: 200 },
    { ...item.items[0], externalLineId: "first" },
  ];
  item.grossMinor = 300;
  item.payableMinor = 300;
  item.paidMinor = 300;
  const applied = await commit("ORDERS", page([item], "six"), "replacement", "five");
  assert.equal(applied.lineDeletedCount, 1);
  assert.equal(applied.lineInsertedCount, 2);
  item.items.reverse();
  assert.equal(
    (await commit("ORDERS", page([item], "seven"), "line-order", "six")).duplicateCount,
    1,
  );
  assert.deepEqual(
    (
      await admin.query(
        'SELECT "externalLineId" FROM commerce."OrderLineListing" WHERE "externalOrderId"=$1 ORDER BY "externalLineId"',
        ["one"],
      )
    ).rows.map((r) => r.externalLineId),
    ["first", "second"],
  );
});
test("torn ACK rollback leaves no facts or staging; redelivery commits once", async () => {
  const before = await snapshot();
  const input = page([record("REFUNDS", "torn")], "six");
  await worker.query("BEGIN");
  try {
    assert.equal((await commit("REFUNDS", input, "torn", "five")).appliedCount, 1);
  } finally {
    await worker.query("ROLLBACK");
  }
  assert.deepEqual(await snapshot(), before);
  assert.equal((await commit("REFUNDS", input, "torn", "five")).appliedCount, 1);
  assert.equal((await commit("REFUNDS", input, "torn", "five")).status, "REPLAYED");
});
test("suppressed facts, lines and manifest abort all changes, even empty pages", async () => {
  for (const [schema, table, stream, cursor, items] of [
    ["commerce", "RefundListing", "REFUNDS", "six", [record("REFUNDS", "suppressed")]],
    ["commerce", "OrderLineListing", "ORDERS", "seven", [record("ORDERS", "suppressed")]],
    ["sync_host", "CanonicalPageCommit", "MARKETING", "five", []],
  ]) {
    await admin.query(`CREATE FUNCTION ${schema}.suppress_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER suppress_test BEFORE INSERT ON ${schema}."${table}" FOR EACH ROW EXECUTE FUNCTION ${schema}.suppress_test()`);
    const before = await snapshot();
    try {
      await assert.rejects(commit(stream, page(items), "suppressed", cursor), { code: "23514" });
      assert.deepEqual(await snapshot(), before);
    } finally {
      await admin.query(
        `DROP TRIGGER suppress_test ON ${schema}."${table}"; DROP FUNCTION ${schema}.suppress_test()`,
      );
    }
  }
});
test("unsafe/null/anomaly constraints quarantine records and composite keys remain independent", async () => {
  for (const stream of streams) {
    const bad = record(stream, "bad-null");
    const field = {
      ORDERS: "paidMinor",
      REFUNDS: "succeededMinor",
      INVENTORY: "available",
      MARKETING: "clicks",
    }[stream];
    bad[field] = null;
    const invalidTime = record(stream, "bad-time");
    invalidTime.source.updatedAt = "not-a-date";
    const future = record(stream, "future", "2026-01-03T00:00:00Z");
    const cursor = { ORDERS: "seven", REFUNDS: "six", INVENTORY: "five", MARKETING: "five" }[
      stream
    ];
    const result = await commit(
      stream,
      page([bad, invalidTime, future], "constraints"),
      "constraints",
      cursor,
    );
    assert.equal(result.quarantinedCount, 3);
    assert.equal(result.appliedCount, 0);
  }
  const inventory = record("INVENTORY");
  inventory.externalLocationId = "second";
  const marketing = record("MARKETING");
  marketing.date = "2026-01-02";
  for (const [stream, item] of [
    ["INVENTORY", inventory],
    ["MARKETING", marketing],
  ])
    assert.equal(
      (await commit(stream, page([item], "composite"), "composite", "constraints")).appliedCount,
      1,
    );
});
test("page UTF-8, order aggregate resource and transaction isolation bounds reject atomically", async () => {
  const before = await snapshot();
  const item = record("ORDERS");
  item.items = Array.from({ length: 500 }, (_, i) => ({
    ...item.items[0],
    externalLineId: `line-${i}`,
  }));
  await assert.rejects(
    commit("ORDERS", page(Array.from({ length: 11 }, () => item)), "line-budget", "constraints"),
    { code: "23514", message: "PAGE_TOO_LARGE" },
  );
  await assert.rejects(
    commit(
      "REFUNDS",
      page([{ ...record("REFUNDS"), extra: "é".repeat(8_388_608) }]),
      "byte-budget",
      "constraints",
    ),
    { code: "23514", message: "PAGE_TOO_LARGE" },
  );
  await worker.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    await assert.rejects(commit("ORDERS", page([]), "isolation", "constraints"), {
      code: "23514",
      message: "Page receipts require read committed isolation",
    });
  } finally {
    await worker.query("ROLLBACK");
  }
  assert.deepEqual(await snapshot(), before);
});
test("worker cannot access facts, sidecars or internal helpers; foreign job fails before wait", async () => {
  for (const table of ["CanonicalPageCommit", "CanonicalPageDecision", "CanonicalQuarantine"])
    await assert.rejects(worker.query(`SELECT * FROM sync_host."${table}"`), { code: "42501" });
  await assert.rejects(worker.query('UPDATE commerce."RefundListing" SET status=$1', ["FAILED"]), {
    code: "42501",
  });
  await assert.rejects(worker.query("SELECT sync_host.canonical_table($1)", ["ORDERS"]), {
    code: "42501",
  });
  await admin.query("BEGIN");
  await admin.query('SELECT id FROM sync_host."Job" WHERE id=$1 FOR UPDATE', ["ORDERS"]);
  await foreign.query("SET statement_timeout='250ms'");
  try {
    await assert.rejects(commit("ORDERS", page([record("ORDERS")]), "first", null, foreign), {
      code: "42501",
    });
  } finally {
    await admin.query("ROLLBACK");
    await foreign.query("SET statement_timeout=0");
  }
});
test("replay checks current identity/fence and lease again after manifest lock wait", async () => {
  await assert.rejects(
    commit("REFUNDS", page([record("REFUNDS")]), "first", null, worker, jobs.get("REFUNDS") + 1),
    { code: "42501" },
  );
  await worker.query("SELECT set_config('app.user_id','source-human',false)");
  try {
    await assert.rejects(commit("REFUNDS", page([record("REFUNDS")])), { code: "42501" });
  } finally {
    await worker.query("SELECT set_config('app.user_id','source-worker',false)");
  }
  const before = await snapshot();
  await admin.query(
    'UPDATE sync_host."Job" SET "leaseUntil"=clock_timestamp()+interval \'1000 milliseconds\' WHERE id=$1',
    ["REFUNDS"],
  );
  await admin.query("BEGIN");
  await admin.query('LOCK TABLE sync_host."CanonicalPageCommit" IN ACCESS EXCLUSIVE MODE');
  const pending = assert.rejects(commit("REFUNDS", page([record("REFUNDS")])), { code: "42501" });
  try {
    await admin.query("SELECT pg_sleep(1.2)");
    await admin.query("COMMIT");
    await pending;
  } finally {
    await admin.query("ROLLBACK");
    await admin.query(
      'UPDATE sync_host."Job" SET "leaseUntil"=clock_timestamp()+interval \'120 seconds\' WHERE id=$1',
      ["REFUNDS"],
    );
  }
  assert.deepEqual(await snapshot(), before);
});
test("deferred lease guard rejects expired COMMIT and auth reset, rolling facts and ACK back", async () => {
  const before = await snapshot();
  for (const failure of ["expiry", "auth"]) {
    if (failure === "expiry")
      await admin.query(
        'UPDATE sync_host."Job" SET "leaseUntil"=clock_timestamp()+interval \'1000 milliseconds\' WHERE id=$1',
        ["REFUNDS"],
      );
    await worker.query("BEGIN");
    try {
      await commit("REFUNDS", page([record("REFUNDS", failure)], "guard"), failure, "constraints");
      if (failure === "expiry") await worker.query("SELECT pg_sleep(1.2)");
      else await worker.query("SELECT set_config('app.user_id','source-human',true)");
      await assert.rejects(worker.query("COMMIT"), { code: "42501" });
    } finally {
      await worker.query("ROLLBACK");
    }
    await admin.query(
      'UPDATE sync_host."Job" SET "leaseUntil"=clock_timestamp()+interval \'120 seconds\' WHERE id=$1',
      ["REFUNDS"],
    );
    assert.deepEqual(await snapshot(), before);
  }
});
test("concurrent streams serialize the source scope and exact redelivery without duplication", async () => {
  const peer = await connectSyncWorker(url);
  await createSyncGrant(admin, syncScope("a2"), "sync-grant-a2");
  await worker.query("SELECT set_config('sync.grant_id','sync-grant-a2',false)");
  await peer.query("SELECT set_config('sync.grant_id','sync-grant-a2',false)");
  try {
    await createJob("REFUNDS", "concurrent-one", worker, syncScope("a2"), "sync-grant-a2");
    await createJob("INVENTORY", "concurrent-two", peer, syncScope("a2"), "sync-grant-a2");
    const item = { ...record("REFUNDS", "same"), externalStoreId: syncScope("a2").externalStoreId };
    const inventory = {
      ...record("INVENTORY", "same"),
      externalStoreId: syncScope("a2").externalStoreId,
    };
    await worker.query("BEGIN");
    await commit("concurrent-one", page([item]), "first");
    const waiting = commit("concurrent-two", page([inventory, inventory]), "first", null, peer);
    await worker.query("COMMIT");
    assert.equal((await waiting).duplicateCount, 1);
    const replays = await Promise.all([
      commit("concurrent-one", page([item])),
      commit("concurrent-two", page([inventory, inventory]), "first", null, peer),
    ]);
    assert.ok(replays.every((r) => r.status === "REPLAYED"));
  } finally {
    await worker.query("ROLLBACK");
    await peer.end();
    await worker.query("SELECT set_config('sync.grant_id','sync-grant-a',false)");
  }
});
test("foreign tenant gets independent typed facts; staging-only receipt cannot be adopted", async () => {
  await createJob("REFUNDS", "foreign", foreign, syncScope("b"), "sync-grant-b");
  const item = { ...record("REFUNDS", "foreign"), externalStoreId: syncScope("b").externalStoreId };
  assert.equal((await commit("foreign", page([item]), "first", null, foreign)).appliedCount, 1);
  await foreign.query("SELECT sync_host.stage_page($1,$2,$3,$4,$5,$6,$7)", [
    "foreign",
    jobs.get("foreign"),
    "staged-only",
    "next",
    "staged",
    since,
    "a".repeat(64),
  ]);
  await assert.rejects(commit("foreign", page([]), "after-staged", "staged", foreign), {
    code: "23514",
    message: "UNCOMMITTED_CANONICAL_RECEIPT",
  });
  const row = (
    await admin.query(
      'SELECT "organizationId","storeId" FROM commerce."RefundListing" WHERE "externalRefundId"=$1',
      ["foreign"],
    )
  ).rows[0];
  assert.deepEqual(row, {
    organizationId: syncScope("b").organizationId,
    storeId: syncScope("b").storeId,
  });
});
test("maximum 200 records and 5000 complete order lines are admitted under bounded resources", async () => {
  await worker.query("SELECT set_config('sync.grant_id','sync-grant-a2',false)");
  try {
    await createJob("ORDERS", "max-orders", worker, syncScope("a2"), "sync-grant-a2");
    const orders = Array.from({ length: 10 }, (_, index) => {
      const item = record("ORDERS", `max-${index}`);
      item.externalStoreId = syncScope("a2").externalStoreId;
      const line = item.items[0];
      item.items = Array.from({ length: 500 }, (_, i) => ({
        ...line,
        externalLineId: `line-${i}`,
      }));
      item.grossMinor = 50000;
      item.payableMinor = 50000;
      item.paidMinor = 50000;
      return item;
    });
    const result = await commit("max-orders", page(orders), "first");
    assert.equal(result.appliedCount, 10);
    assert.equal(result.lineInsertedCount, 5000);
    assert.equal((await commit("max-orders", page(orders))).status, "REPLAYED");
    await createJob("MARKETING", "max-records", worker, syncScope("a2"), "sync-grant-a2");
    const metrics = Array.from({ length: 200 }, (_, i) => ({
      ...record("MARKETING", `max-${i}`),
      externalStoreId: syncScope("a2").externalStoreId,
    }));
    assert.equal((await commit("max-records", page(metrics))).appliedCount, 200);
  } finally {
    await worker.query("SELECT set_config('sync.grant_id','sync-grant-a',false)");
  }
});
test("unrepresentable surrogate transport rejects before RPC and never stores raw diagnostics", async () => {
  const before = await snapshot();
  const input = record("REFUNDS", "\ud800");
  await assert.rejects(commit("REFUNDS", page([input]), "surrogate", "constraints"), {
    code: "22P02",
  });
  assert.deepEqual(await snapshot(), before);
  const columns = (
    await admin.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='sync_host' AND table_name='CanonicalQuarantine' ORDER BY ordinal_position",
    )
  ).rows.map((r) => r.column_name);
  assert.deepEqual(columns, [
    "jobId",
    "pageId",
    "ordinal",
    "organizationId",
    "workspaceId",
    "storeId",
    "reason",
  ]);
  assert.ok(
    (
      await admin.query(
        'SELECT "recordKey" FROM sync_host."CanonicalPageDecision" d JOIN sync_host."CanonicalQuarantine" q USING ("jobId","pageId",ordinal) WHERE q.reason=$1',
        ["INVALID_RECORD"],
      )
    ).rows.every((r) => r.recordKey === null),
  );
});
test("commerce reader sees authorized typed facts and cannot access sidecars or generic RPC", async () => {
  await admin.query("GRANT shopmate_commerce_reader TO source_read_login");
  const reader = new pg.Client({ connectionString: loginUrl(url, "source_read_login") });
  await reader.connect();
  try {
    await reader.query(
      "SELECT set_config('app.user_id','source-worker',false),set_config('app.merchant_id','source-merchant-a',false)",
    );
    const rows = (await reader.query('SELECT "storeId" FROM commerce."RefundListing"')).rows;
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.storeId !== syncScope("b").storeId));
    for (const table of ["CanonicalPageCommit", "CanonicalPageDecision", "CanonicalQuarantine"])
      await assert.rejects(reader.query(`SELECT * FROM sync_host."${table}"`), { code: "42501" });
    await assert.rejects(commit("REFUNDS", page([]), "reader", "constraints", reader), {
      code: "42501",
    });
  } finally {
    await reader.end();
  }
});
test("early constraint draining retains the approved wall-clock deadline limitation", async () => {
  await admin.query(
    'UPDATE sync_host."Job" SET "leaseUntil"=clock_timestamp()+interval \'1000 milliseconds\' WHERE id=$1',
    ["REFUNDS"],
  );
  await worker.query("BEGIN");
  try {
    await commit(
      "REFUNDS",
      page([record("REFUNDS", "early-drain")], "early-drain"),
      "early-drain",
      "constraints",
    );
    await worker.query("SET CONSTRAINTS ALL IMMEDIATE");
    await worker.query("SELECT pg_sleep(1.2)");
    await worker.query("COMMIT");
  } finally {
    await worker.query("ROLLBACK");
    await admin.query(
      'UPDATE sync_host."Job" SET "leaseUntil"=clock_timestamp()+interval \'120 seconds\' WHERE id=$1',
      ["REFUNDS"],
    );
  }
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::int n FROM commerce."RefundListing" WHERE "externalRefundId"=$1',
        ["early-drain"],
      )
    ).rows[0].n,
    1,
  );
});
test("Prisma schema and complete migrations have no drift", () => {
  const output = execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("../../node_modules/prisma/build/index.js", import.meta.url)),
      "migrate",
      "diff",
      "--from-config-datasource",
      "--to-schema",
      "prisma/schema.prisma",
      "--exit-code",
      "--script",
    ],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: { ...process.env, DATABASE_URL: url },
      encoding: "utf8",
      windowsHide: true,
    },
  );
  assert.match(output, /empty migration/u);
});
test("terminal generic receipt preserves marker meanings and grants/reset remain current", async () => {
  await commit("ORDERS", page([], null), "terminal", "constraints");
  assert.deepEqual(
    (
      await admin.query(
        'SELECT status,cursor,"successfulThrough" FROM sync_host."Job" WHERE id=$1',
        ["ORDERS"],
      )
    ).rows[0],
    { status: "RUNNING", cursor: null, successfulThrough: null },
  );
  assert.deepEqual(
    (
      await admin.query(
        'SELECT terminal,"sourceWatermark" FROM sync_host."CanonicalPageCommit" WHERE "jobId"=$1 AND "pageId"=$2',
        ["ORDERS", "terminal"],
      )
    ).rows[0],
    { terminal: true, sourceWatermark: null },
  );
  await admin.query('UPDATE sync_host."WorkerGrant" SET status=$1 WHERE id=$2', [
    "REVOKED",
    "sync-grant-a",
  ]);
  try {
    await assert.rejects(commit("REFUNDS", page([record("REFUNDS")])), { code: "42501" });
  } finally {
    await admin.query('UPDATE sync_host."WorkerGrant" SET status=$1 WHERE id=$2', [
      "ACTIVE",
      "sync-grant-a",
    ]);
  }
  await operatorControl(admin, 'UPDATE "PlatformConnection" SET generation=1 WHERE id=$1', [
    syncScope().connectionId,
  ]);
  await assert.rejects(commit("REFUNDS", page([record("REFUNDS")])), { code: "42501" });
});

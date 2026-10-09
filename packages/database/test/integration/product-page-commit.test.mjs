import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { URL } from "node:url";
import { isolatedPostgres } from "../helpers/isolated-postgres.mjs";
import { migrateSource, sourceFixtures, loginUrl } from "../helpers/mock-platform-fixture.mjs";
import { connectSyncWorker, createSyncGrant, syncScope } from "../helpers/sync-host-fixture.mjs";
import { operatorControl } from "../helpers/mock-source-control-fixture.mjs";

const since = "2026-01-01T00:00:00.000Z";
const until = "2026-01-02T00:00:00.000Z";
let server, operator, admin, worker, foreign, url, fence;
function product(id = "p", version = "opaque:9", updatedAt = since) {
  return {
    externalStoreId: syncScope().externalStoreId,
    externalProductId: id,
    title: id,
    description: null,
    category: "category",
    brand: null,
    status: "DELETED",
    source: { version, updatedAt, quality: { state: "COMPLETE", issues: [] } },
    skus: [
      {
        externalSkuId: `sku-${id}`,
        externalProductId: id,
        attributes: [],
        salePriceMinor: 100,
        costPriceMinor: 40,
        originalPriceMinor: null,
        status: "INACTIVE",
      },
    ],
  };
}
function page(items = [product()], nextCursor = "cursor-1", sourceWatermark = null) {
  return { items, nextCursor, observedAt: until, sourceWatermark };
}
async function createJob(client, scope, id, grantId, stream = "PRODUCTS") {
  await client.query(
    'INSERT INTO sync_host."Job" (id,"grantId","organizationId","workspaceId","storeId","connectionId","externalStoreId",provider,generation,stream,since,until) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [
      id,
      grantId,
      scope.organizationId,
      scope.workspaceId,
      scope.storeId,
      scope.connectionId,
      scope.externalStoreId,
      scope.provider,
      scope.generation,
      stream,
      since,
      until,
    ],
  );
  return (
    await client.query(
      'UPDATE sync_host."Job" SET status=$1,fence=fence+1,"leaseOwner"=$2 WHERE id=$3 RETURNING fence',
      ["RUNNING", "worker", id],
    )
  ).rows[0].fence;
}
async function commit(
  input,
  pageId = "page-1",
  cursor = null,
  client = worker,
  jobId = "product-job",
  expectedFence = fence,
) {
  return (
    await client.query("SELECT sync_host.commit_product_page($1,$2,$3,$4,$5::jsonb) AS result", [
      jobId,
      expectedFence,
      pageId,
      cursor,
      JSON.stringify(input),
    ])
  ).rows[0].result;
}
async function counts() {
  return (
    await admin.query(`SELECT
    (SELECT count(*)::int FROM commerce."ProductListing") AS products,
    (SELECT count(*)::int FROM commerce."SkuListing") AS skus,
    (SELECT count(*)::int FROM sync_host."ProductPageCommit") AS commits,
    (SELECT count(*)::int FROM sync_host."ProductPageDecision") AS decisions,
    (SELECT count(*)::int FROM sync_host."ProductQuarantine") AS quarantine,
    (SELECT count(*)::int FROM sync_host."PageReceipt") AS receipts`)
  ).rows[0];
}
test.before(async () => {
  server = await isolatedPostgres();
  operator = new pg.Client({ connectionString: server.url });
  await operator.connect();
  await operator.query('CREATE DATABASE "shopmate_tenant_test_productcommit"');
  const parsed = new URL(server.url);
  parsed.pathname = "/shopmate_tenant_test_productcommit";
  url = parsed.toString();
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await migrateSource(admin);
  await sourceFixtures(admin);
  for (const login of ["sync_worker_login", "sync_foreign_login"]) {
    if (!(await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [login])).rowCount)
      await admin.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT shopmate_sync_worker TO ${login}`);
  }
  await createSyncGrant(admin, syncScope(), "sync-grant-a");
  await createSyncGrant(admin, syncScope("b"), "sync-grant-b", "sync_foreign_login");
  worker = await connectSyncWorker(url);
  foreign = await connectSyncWorker(url, "sync_foreign_login", "sync-grant-b");
  fence = await createJob(worker, syncScope(), "product-job", "sync-grant-a");
});
test.after(async () => {
  await Promise.allSettled([worker?.end(), foreign?.end(), admin?.end(), operator?.end()]);
  await server?.stop();
});
test("commits typed facts, immutable decisions and staging without business success", async () => {
  const result = await commit(page());
  assert.deepEqual(result, {
    status: "APPLIED",
    inputCount: 1,
    appliedCount: 1,
    duplicateCount: 0,
    staleCount: 0,
    quarantinedCount: 0,
    skuInsertedCount: 1,
    skuDeletedCount: 0,
  });
  assert.deepEqual(await counts(), {
    products: 1,
    skus: 1,
    commits: 1,
    decisions: 1,
    quarantine: 0,
    receipts: 1,
  });
  const job = (
    await admin.query(
      'SELECT cursor,"successfulThrough",status,"receiptCursor" FROM sync_host."Job" WHERE id=$1',
      ["product-job"],
    )
  ).rows[0];
  assert.deepEqual(job, {
    cursor: null,
    successfulThrough: null,
    status: "RUNNING",
    receiptCursor: "cursor-1",
  });
  assert.equal(
    (await admin.query('SELECT "sourceWatermark" FROM sync_host."ProductPageCommit"')).rows[0]
      .sourceWatermark,
    null,
  );
});
test("exact replay returns saved counts after later canonical changes and rejects conflicting payload", async () => {
  const second = product("p", "opaque:1", "2026-01-01T01:00:00Z");
  second.title = "newer";
  second.skus = [
    { ...second.skus[0], externalSkuId: "replacement" },
    { ...second.skus[0], externalSkuId: "new-child" },
  ];
  const result = await commit(page([second], "cursor-2"), "page-2", "cursor-1");
  assert.equal(result.appliedCount, 1);
  assert.equal(result.skuDeletedCount, 1);
  assert.equal(result.skuInsertedCount, 2);
  const replay = await commit(page());
  assert.equal(replay.status, "REPLAYED");
  assert.equal(replay.skuInsertedCount, 1);
  assert.equal(replay.skuDeletedCount, 0);
  assert.equal(
    (await admin.query('SELECT title FROM commerce."ProductListing"')).rows[0].title,
    "newer",
  );
  await assert.rejects(commit(page([{ ...product(), title: "different" }])), { code: "23505" });
});
test("old source cannot overwrite facts, exact source is duplicate, and conflicts/invalid items are counted", async () => {
  const current = product("p", "opaque:1", "2026-01-01T01:00:00Z");
  current.title = "newer";
  current.skus = [
    { ...current.skus[0], externalSkuId: "replacement" },
    { ...current.skus[0], externalSkuId: "new-child" },
  ];
  const invalid = { ...product("bad"), title: 123 };
  const conflict = { ...current, title: "conflicting equal-time" };
  const result = await commit(
    page([product(), current, conflict, invalid], "cursor-3"),
    "page-3",
    "cursor-2",
  );
  assert.equal(result.staleCount, 1);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.quarantinedCount, 2);
  assert.equal(result.appliedCount, 0);
  assert.equal((await counts()).quarantine, 2);
  assert.equal(
    (await admin.query('SELECT title FROM commerce."ProductListing"')).rows[0].title,
    "newer",
  );
});
test("foreign or malformed envelopes roll back the whole page", async () => {
  const before = await counts();
  await assert.rejects(
    commit(
      page([product("valid"), { ...product("foreign"), externalStoreId: "foreign" }], "cursor-4"),
      "bad-page",
      "cursor-3",
    ),
    { code: "23514" },
  );
  assert.deepEqual(await counts(), before);
  await assert.rejects(commit(page([], "cursor-4"), "bad-cursor", null), { code: "23514" });
  assert.deepEqual(await counts(), before);
});
test("SKU ownership conflicts use the pre-page state and quarantine every cross-product claimant", async () => {
  const a = product("claim-a"),
    b = product("claim-b");
  a.skus[0].externalSkuId = "shared";
  b.skus[0].externalSkuId = "shared";
  const foreignOwner = product("claim-existing");
  foreignOwner.skus[0].externalSkuId = "replacement";
  const result = await commit(page([a, b, foreignOwner], "cursor-4"), "page-4", "cursor-3");
  assert.equal(result.quarantinedCount, 3);
  assert.equal(result.appliedCount, 0);
  assert.equal((await counts()).products, 1);
});
test("storage failure aborts all facts and receipts instead of becoming quarantine", async () => {
  await admin.query(`CREATE FUNCTION commerce.reject_commit_test() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'deliberate physical failure' USING ERRCODE='23514'; END $$;
    CREATE TRIGGER reject_commit_test BEFORE INSERT ON commerce."SkuListing" FOR EACH ROW EXECUTE FUNCTION commerce.reject_commit_test()`);
  const before = await counts();
  try {
    await assert.rejects(
      commit(page([product("failure")], "cursor-5"), "failure-page", "cursor-4"),
      { code: "23514", message: "deliberate physical failure" },
    );
    assert.deepEqual(await counts(), before);
  } finally {
    await admin.query(
      'DROP TRIGGER reject_commit_test ON commerce."SkuListing"; DROP FUNCTION commerce.reject_commit_test()',
    );
  }
});
test("suppressed physical rows abort instead of producing fabricated applied counts", async () => {
  await admin.query(`CREATE FUNCTION commerce.suppress_commit_test() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RETURN NULL; END $$;
    CREATE TRIGGER suppress_commit_test BEFORE INSERT ON commerce."SkuListing" FOR EACH ROW EXECUTE FUNCTION commerce.suppress_commit_test()`);
  const before = await counts();
  try {
    await assert.rejects(
      commit(page([product("suppressed")], "cursor-5"), "suppressed-page", "cursor-4"),
      { code: "23514", message: "PRODUCT_WRITE_COUNT_MISMATCH" },
    );
    assert.deepEqual(await counts(), before);
  } finally {
    await admin.query(
      'DROP TRIGGER suppress_commit_test ON commerce."SkuListing"; DROP FUNCTION commerce.suppress_commit_test()',
    );
  }
});
test("suppressed empty-page manifests cannot acknowledge staged-only success", async () => {
  await admin.query(`CREATE FUNCTION sync_host.suppress_manifest_test() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RETURN NULL; END $$;
    CREATE TRIGGER suppress_manifest_test BEFORE INSERT ON sync_host."ProductPageCommit" FOR EACH ROW EXECUTE FUNCTION sync_host.suppress_manifest_test()`);
  const before = await counts();
  try {
    await assert.rejects(commit(page([], "unused-next"), "suppressed-manifest", "cursor-4"), {
      code: "23514",
      message: "PRODUCT_RECEIPT_WRITE_COUNT_MISMATCH",
    });
    assert.deepEqual(await counts(), before);
  } finally {
    await admin.query(
      'DROP TRIGGER suppress_manifest_test ON sync_host."ProductPageCommit"; DROP FUNCTION sync_host.suppress_manifest_test()',
    );
  }
});
test("missing identity and foreign Job fail closed before waiting on its lock", async () => {
  await worker.query("SELECT set_config('sync.grant_id','',false)");
  try {
    await assert.rejects(commit(page()), { code: "42501" });
  } finally {
    await worker.query("SELECT set_config('sync.grant_id','sync-grant-a',false)");
  }
  await admin.query("BEGIN");
  await admin.query('SELECT id FROM sync_host."Job" WHERE id=$1 FOR UPDATE', ["product-job"]);
  await foreign.query("SET statement_timeout='500ms'");
  try {
    await assert.rejects(commit(page(), "page-1", null, foreign), { code: "42501" });
  } finally {
    await admin.query("ROLLBACK");
    await foreign.query("SET statement_timeout=0");
  }
});
test("exact replay rechecks a lease that expires while canonical manifest lookup waits", async () => {
  const before = await counts();
  await admin.query(
    'UPDATE sync_host."Job" SET "leaseUntil"=clock_timestamp()+interval \'1500 milliseconds\' WHERE id=$1',
    ["product-job"],
  );
  await admin.query("BEGIN");
  await admin.query('LOCK TABLE sync_host."ProductPageCommit" IN ACCESS EXCLUSIVE MODE');
  const rejected = assert.rejects(commit(page()), { code: "42501" });
  try {
    await admin.query("SELECT pg_sleep(2)");
    await admin.query("COMMIT");
    await rejected;
  } finally {
    await admin.query("ROLLBACK");
    await admin.query(
      'UPDATE sync_host."Job" SET "leaseUntil"=clock_timestamp()+interval \'120 seconds\' WHERE id=$1',
      ["product-job"],
    );
  }
  assert.deepEqual(await counts(), before);
});

test("an expired lease during explicit transaction rolls the entire successful RPC back at COMMIT", async () => {
  const before = await counts();
  await admin.query(
    'UPDATE sync_host."Job" SET "leaseUntil"=clock_timestamp()+interval \'1200 milliseconds\' WHERE id=$1',
    ["product-job"],
  );
  await worker.query("BEGIN");
  try {
    const result = await commit(page([product("expire")], "cursor-5"), "expiry-page", "cursor-4");
    assert.equal(result.appliedCount, 1);
    await worker.query("SELECT pg_sleep(1.3)");
    await assert.rejects(worker.query("COMMIT"), { code: "42501" });
  } finally {
    await worker.query("ROLLBACK");
  }
  assert.deepEqual(await counts(), before);
  await admin.query(
    'UPDATE sync_host."Job" SET "leaseUntil"=clock_timestamp()+interval \'120 seconds\' WHERE id=$1',
    ["product-job"],
  );
});
test("reader and worker cannot mutate or read internal sidecars directly", async () => {
  for (const table of ["ProductPageCommit", "ProductPageDecision", "ProductQuarantine"])
    await assert.rejects(worker.query(`SELECT * FROM sync_host."${table}"`), { code: "42501" });
  await assert.rejects(worker.query('UPDATE commerce."ProductListing" SET title=$1', ["forged"]), {
    code: "42501",
  });
  const reader = new pg.Client({ connectionString: loginUrl(url, "source_read_login") });
  await reader.connect();
  try {
    await assert.rejects(commit(page(), "page-1", null, reader), { code: "42501" });
  } finally {
    await reader.end();
  }
});
test("early constraint draining exposes the documented COMMIT wall-clock limitation", async () => {
  const before = await counts();
  await admin.query(
    'UPDATE sync_host."Job" SET "leaseUntil"=clock_timestamp()+interval \'1200 milliseconds\' WHERE id=$1',
    ["product-job"],
  );
  await worker.query("BEGIN");
  try {
    await commit(page([product("early-drain")], "cursor-5"), "early-drain-page", "cursor-4");
    await worker.query("SET CONSTRAINTS ALL IMMEDIATE");
    await worker.query("SELECT pg_sleep(1.3)");
    await worker.query("COMMIT");
  } finally {
    await worker.query("ROLLBACK");
  }
  const after = await counts();
  assert.equal(after.products, before.products + 1);
  assert.equal(after.commits, before.commits + 1);
  await admin.query(
    'UPDATE sync_host."Job" SET "leaseUntil"=clock_timestamp()+interval \'120 seconds\' WHERE id=$1',
    ["product-job"],
  );
});
test("current principal, backend and fence are required even for exact replay", async () => {
  const peer = await connectSyncWorker(url);
  try {
    await assert.rejects(commit(page(), "page-1", null, peer), { code: "42501" });
  } finally {
    await peer.end();
  }
  await assert.rejects(commit(page(), "page-1", null, worker, "product-job", fence + 1), {
    code: "42501",
  });
  await worker.query("SELECT set_config('app.user_id','source-human',false)");
  try {
    await assert.rejects(commit(page()), { code: "42501" });
  } finally {
    await worker.query("SELECT set_config('app.user_id','source-worker',false)");
  }
});
test("worker cannot mix staged-only pages into a later canonical manifest", async () => {
  const otherFence = await createJob(foreign, syncScope("b"), "staged-job", "sync-grant-b");
  await foreign.query("SELECT sync_host.stage_page($1,$2,$3,$4,$5,$6,$7)", [
    "staged-job",
    otherFence,
    "staged-only",
    null,
    "staged-cursor",
    since,
    "a".repeat(64),
  ]);
  const before = await counts();
  const other = { ...product("foreign-owned"), externalStoreId: syncScope("b").externalStoreId };
  await assert.rejects(
    commit(page([other], "next"), "staged-only", null, foreign, "staged-job", otherFence),
    { code: "23514" },
  );
  await assert.rejects(
    commit(
      page([other], "next"),
      "after-staged",
      "staged-cursor",
      foreign,
      "staged-job",
      otherFence,
    ),
    { code: "23514", message: "UNCOMMITTED_PRODUCT_RECEIPT" },
  );
  assert.deepEqual(await counts(), before);
});
test("authority locks serialize revocation and the next call rechecks membership", async () => {
  const control = new pg.Client({ connectionString: url });
  await control.connect();
  await control.query("SET statement_timeout='250ms'");
  await worker.query("BEGIN");
  try {
    await commit(page([], "cursor-6"), "auth-lock-page", "cursor-5");
    await assert.rejects(
      control.query(
        'UPDATE "WorkspaceMember" SET status=$1 WHERE "userId"=$2 AND "workspaceId"=$3',
        ["INACTIVE", "source-worker", syncScope().workspaceId],
      ),
      { code: "57014" },
    );
    await worker.query("COMMIT");
  } finally {
    await worker.query("ROLLBACK");
    await control.end();
  }
  await admin.query(
    'UPDATE "WorkspaceMember" SET status=$1 WHERE "userId"=$2 AND "workspaceId"=$3',
    ["INACTIVE", "source-worker", syncScope().workspaceId],
  );
  try {
    await assert.rejects(commit(page()), { code: "42501" });
  } finally {
    await admin.query(
      'UPDATE "WorkspaceMember" SET status=$1 WHERE "userId"=$2 AND "workspaceId"=$3',
      ["ACTIVE", "source-worker", syncScope().workspaceId],
    );
  }
});
test("terminal receipt preserves absent actual watermark and does not finish the business Job", async () => {
  const result = await commit(page([], null), "page-final", "cursor-6");
  assert.equal(result.inputCount, 0);
  const job = (
    await admin.query('SELECT status,cursor,"successfulThrough" FROM sync_host."Job" WHERE id=$1', [
      "product-job",
    ])
  ).rows[0];
  assert.deepEqual(job, { status: "RUNNING", cursor: null, successfulThrough: null });
  assert.equal(
    (
      await admin.query(
        'SELECT terminal,"sourceWatermark" FROM sync_host."ProductPageCommit" WHERE "pageId"=$1',
        ["page-final"],
      )
    ).rows[0].sourceWatermark,
    null,
  );
});
test("empty first-and-final pages are canonical receipts under their own full namespace", async () => {
  await createSyncGrant(admin, syncScope("a2"), "sync-grant-a2");
  await worker.query("SELECT set_config('sync.grant_id','sync-grant-a2',false)");
  try {
    const emptyFence = await createJob(worker, syncScope("a2"), "empty-job", "sync-grant-a2");
    const result = await commit(
      page([], null),
      "empty-final",
      null,
      worker,
      "empty-job",
      emptyFence,
    );
    assert.equal(result.status, "APPLIED");
    assert.equal(result.inputCount, 0);
    const stored = (
      await admin.query(
        'SELECT "storeId",terminal FROM sync_host."ProductPageCommit" WHERE "jobId"=$1',
        ["empty-job"],
      )
    ).rows[0];
    assert.equal(stored.storeId, syncScope("a2").storeId);
    assert.equal(stored.terminal, true);
  } finally {
    await worker.query("SELECT set_config('sync.grant_id','sync-grant-a',false)");
  }
});
test("admission errors and non-PRODUCT streams cannot create facts or manifests", async () => {
  const before = await counts();
  const items = Array.from({ length: 200 }, (_, p) => ({
    ...product(`budget-${p}`),
    skus: Array.from({ length: 26 }, (_, s) => ({
      ...product(`budget-${p}`).skus[0],
      externalSkuId: `${p}-${s}`,
    })),
  }));
  await assert.rejects(commit(page(items), "budget-page"), {
    code: "23514",
    message: "PAGE_TOO_LARGE",
  });
  const otherFence = await createJob(worker, syncScope(), "order-job", "sync-grant-a", "ORDERS");
  await assert.rejects(commit(page(), "wrong-stream", null, worker, "order-job", otherFence), {
    code: "23514",
    message: "INVALID_PRODUCT_STREAM",
  });
  assert.deepEqual(await counts(), before);
});
test("a new current pinned lease can replay saved counts while the old backend is fenced", async () => {
  const before = await counts();
  const peer = await connectSyncWorker(url);
  const claim = async (client) =>
    (
      await client.query(
        'UPDATE sync_host."Job" SET status=$1,fence=fence+1,"leaseOwner"=$2 WHERE id=$3 RETURNING fence',
        ["RUNNING", "takeover", "product-job"],
      )
    ).rows[0].fence;
  const expire = () =>
    admin.query(
      'UPDATE sync_host."Job" SET "leaseUntil"=clock_timestamp()-interval \'1 second\' WHERE id=$1',
      ["product-job"],
    );
  try {
    await expire();
    const newFence = await claim(peer);
    const replay = await commit(page(), "page-1", null, peer, "product-job", newFence);
    assert.equal(replay.status, "REPLAYED");
    assert.equal(replay.appliedCount, 1);
    assert.equal(replay.skuInsertedCount, 1);
    await assert.rejects(commit(page()), { code: "42501" });
    await expire();
    fence = await claim(worker);
    assert.deepEqual(await counts(), before);
  } finally {
    await peer.end();
  }
});
test("revoked grant and reset generation deny previously successful exact retries", async () => {
  await admin.query('UPDATE sync_host."WorkerGrant" SET status=$1 WHERE id=$2', [
    "REVOKED",
    "sync-grant-a",
  ]);
  try {
    await assert.rejects(commit(page()), { code: "42501" });
  } finally {
    await admin.query('UPDATE sync_host."WorkerGrant" SET status=$1 WHERE id=$2', [
      "ACTIVE",
      "sync-grant-a",
    ]);
  }
  await operatorControl(admin, 'UPDATE "PlatformConnection" SET generation=1 WHERE id=$1', [
    syncScope().connectionId,
  ]);
  await assert.rejects(commit(page()), { code: "42501" });
});

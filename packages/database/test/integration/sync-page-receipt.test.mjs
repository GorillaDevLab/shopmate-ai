import process from "node:process";
import pg from "pg";
import { loginUrl } from "../helpers/mock-platform-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { operatorControl } from "../helpers/mock-source-control-fixture.mjs";
import {
  closeSyncDatabase,
  connectSyncWorker,
  createSyncDatabase,
  createSyncGrant,
  syncScope,
} from "../helpers/sync-host-fixture.mjs";

const since = "2026-01-01T00:00:00.000Z";
const until = "2026-01-02T00:00:00.000Z";
const digest = "a".repeat(64);

async function createJob(client, scope, id, grantId) {
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
      "PRODUCTS",
      since,
      until,
    ],
  );
}

async function claim(client, id) {
  const result = await client.query(
    'UPDATE sync_host."Job" SET status=$1,fence=fence+1,"leaseOwner"=$2 WHERE id=$3 RETURNING fence',
    ["RUNNING", "worker-a", id],
  );
  return result.rows[0].fence;
}

async function receive(client, jobId, fence, pageId, expected, next, through, hash = digest) {
  return client.query("SELECT sync_host.stage_page($1,$2,$3,$4,$5,$6,$7) AS outcome", [
    jobId,
    fence,
    pageId,
    expected,
    next,
    through,
    hash,
  ]);
}

test("page receipt and cursor commit atomically under a current pinned lease", async (t) => {
  const database = await createSyncDatabase("receipt");
  const worker = await connectSyncWorker(database.url);
  const foreign = await connectSyncWorker(database.url, "sync_foreign_login", "sync-grant-b");
  try {
    await createSyncGrant(database.admin, syncScope(), "sync-grant-a");
    await createSyncGrant(database.admin, syncScope("b"), "sync-grant-b", "sync_foreign_login");
    await createJob(worker, syncScope(), "receipt-job-a", "sync-grant-a");
    const fence = await claim(worker, "receipt-job-a");
    await t.test("first page advances cursor and records the same receipt", async () => {
      const result = await receive(
        worker,
        "receipt-job-a",
        fence,
        "page-1",
        null,
        "cursor-1",
        since,
      );
      assert.equal(result.rows[0].outcome, "APPLIED");
      const job = await database.admin.query(
        'SELECT "receiptCursor" AS cursor,"receivedThrough"::text AS through,cursor AS business_cursor,"successfulThrough",status FROM sync_host."Job" WHERE id=$1',
        ["receipt-job-a"],
      );
      assert.equal(job.rows[0].cursor, "cursor-1");
      assert.equal(job.rows[0].through, "2026-01-01 00:00:00");
      assert.equal(job.rows[0].business_cursor, null);
      assert.equal(job.rows[0].successfulThrough, null);
      assert.equal(job.rows[0].status, "RUNNING");
      const receipts = await database.admin.query(
        'SELECT count(*)::int AS n FROM sync_host."PageReceipt"',
      );
      assert.equal(receipts.rows[0].n, 1);
    });
    await t.test("same page retry is idempotent and conflicting receipt rolls back", async () => {
      assert.equal(
        (await receive(worker, "receipt-job-a", fence, "page-1", null, "cursor-1", since)).rows[0]
          .outcome,
        "REPLAYED",
      );
      await assert.rejects(
        receive(worker, "receipt-job-a", fence, "page-1", null, "cursor-2", since),
      );
      await assert.rejects(
        receive(worker, "receipt-job-a", fence, "page-2", null, "cursor-2", since),
      );
      const receipts = await database.admin.query(
        'SELECT count(*)::int AS n FROM sync_host."PageReceipt"',
      );
      assert.equal(receipts.rows[0].n, 1);
    });
    await t.test(
      "transaction rollback restores receipt and staging progress together",
      async () => {
        await worker.query("BEGIN");
        try {
          assert.equal(
            (
              await receive(
                worker,
                "receipt-job-a",
                fence,
                "rolled-back",
                "cursor-1",
                "cursor-2",
                since,
              )
            ).rows[0].outcome,
            "APPLIED",
          );
        } finally {
          await worker.query("ROLLBACK");
        }
        const stored = await database.admin.query(
          'SELECT "receiptCursor" FROM sync_host."Job" WHERE id=$1',
          ["receipt-job-a"],
        );
        assert.equal(stored.rows[0].receiptCursor, "cursor-1");
        assert.equal(
          (
            await database.admin.query(
              'SELECT count(*)::int AS n FROM sync_host."PageReceipt" WHERE "pageId"=$1',
              ["rolled-back"],
            )
          ).rows[0].n,
          0,
        );
      },
    );
    await t.test("foreign calls cannot wait on a locked job", async () => {
      await database.admin.query("BEGIN");
      try {
        await database.admin.query('SELECT id FROM sync_host."Job" WHERE id=$1 FOR UPDATE', [
          "receipt-job-a",
        ]);
        await foreign.query("SET statement_timeout='2s'");
        await assert.rejects(
          receive(foreign, "receipt-job-a", fence, "page-2", "cursor-1", null, until),
          { code: "42501" },
        );
      } finally {
        await database.admin.query("ROLLBACK");
        await foreign.query("RESET statement_timeout");
      }
    });
    await t.test("snapshot isolation cannot retain stale receipt authority", async () => {
      await worker.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      try {
        await assert.rejects(
          receive(worker, "receipt-job-a", fence, "page-2", "cursor-1", null, until),
          { code: "23514" },
        );
      } finally {
        await worker.query("ROLLBACK");
      }
    });
    await t.test("foreign login and direct progress writes are denied", async () => {
      await assert.rejects(
        receive(foreign, "receipt-job-a", fence, "page-2", "cursor-1", null, until),
      );
      await assert.rejects(
        worker.query('UPDATE sync_host."Job" SET "receivedThrough"=until WHERE id=$1', [
          "receipt-job-a",
        ]),
        { code: "42501" },
      );
      await assert.rejects(
        worker.query('UPDATE sync_host."Job" SET "successfulThrough"=until WHERE id=$1', [
          "receipt-job-a",
        ]),
        { code: "42501" },
      );
      await assert.rejects(
        worker.query('UPDATE sync_host."Job" SET cursor=$1::jsonb WHERE id=$2', [
          '"forged"',
          "receipt-job-a",
        ]),
      );
      await assert.rejects(
        worker.query('INSERT INTO sync_host."PageReceipt" ("jobId") VALUES ($1)', [
          "receipt-job-a",
        ]),
      );
    });
    await t.test("old fence and expired lease cannot accept pages", async () => {
      const otherBackend = await connectSyncWorker(database.url);
      try {
        await assert.rejects(
          receive(otherBackend, "receipt-job-a", fence, "page-2", "cursor-1", null, until),
          { code: "42501" },
        );
      } finally {
        await otherBackend.end();
      }
      await assert.rejects(
        receive(worker, "receipt-job-a", fence - 1, "page-2", "cursor-1", null, until),
      );
      await database.admin.query(
        'UPDATE sync_host."Job" SET "leaseUntil"=clock_timestamp()-interval \'1 second\' WHERE id=$1',
        ["receipt-job-a"],
      );
      await assert.rejects(
        receive(worker, "receipt-job-a", fence, "page-2", "cursor-1", null, until),
      );
    });
    await t.test("empty final receipt stages progress without certifying ingestion", async () => {
      await createJob(foreign, syncScope("b"), "empty-job", "sync-grant-b");
      const emptyFence = await claim(foreign, "empty-job");
      assert.equal(
        (await receive(foreign, "empty-job", emptyFence, "empty", null, null, until)).rows[0]
          .outcome,
        "APPLIED",
      );
      assert.equal(
        (await receive(foreign, "empty-job", emptyFence, "empty", null, null, until)).rows[0]
          .outcome,
        "REPLAYED",
      );
      await assert.rejects(
        receive(foreign, "empty-job", emptyFence, "another", null, null, until),
        { code: "23514" },
      );
      const result = await database.admin.query(
        'SELECT cursor,"successfulThrough",status FROM sync_host."Job" WHERE id=$1',
        ["empty-job"],
      );
      assert.deepEqual(result.rows[0], {
        cursor: null,
        successfulThrough: null,
        status: "RUNNING",
      });
    });
    await t.test("missing identity settings fail closed", async () => {
      const unset = new pg.Client({
        connectionString: loginUrl(database.url, "sync_foreign_login"),
      });
      await unset.connect();
      try {
        assert.equal(
          (await unset.query("SELECT current_setting('app.user_id',true) AS identity")).rows[0]
            .identity,
          null,
        );
        await assert.rejects(receive(unset, "empty-job", 1, "empty", null, null, until), {
          code: "42501",
        });
      } finally {
        await unset.end();
      }
      for (const setting of ["app.user_id", "sync.grant_id"]) {
        const value = setting === "app.user_id" ? "source-worker" : "sync-grant-b";
        await foreign.query("SELECT set_config($1,'',false)", [setting]);
        await assert.rejects(receive(foreign, "empty-job", 1, "empty", null, null, until), {
          code: "42501",
        });
        await foreign.query("SELECT set_config($1,$2,false)", [setting, value]);
      }
    });
    await t.test("grant revocation fences even exact retries", async () => {
      await database.admin.query('UPDATE sync_host."WorkerGrant" SET status=$1 WHERE id=$2', [
        "REVOKED",
        "sync-grant-b",
      ]);
      await assert.rejects(receive(foreign, "empty-job", 1, "empty", null, null, until), {
        code: "42501",
      });
    });
    await t.test("invalid receipt input leaves no partial rows", async () => {
      for (const [id, cursor, hash] of [
        ["bad id", null, digest],
        ["bad-cursor", "\n", digest],
        ["bad-hash", null, "bad"],
      ]) {
        await assert.rejects(receive(foreign, "empty-job", 1, id, cursor, null, until, hash), {
          code: "23514",
        });
      }
      assert.equal(
        (
          await database.admin.query(
            'SELECT count(*)::int AS n FROM sync_host."PageReceipt" WHERE "jobId"=$1',
            ["empty-job"],
          )
        ).rows[0].n,
        1,
      );
    });
    await t.test("migration matches Prisma schema", () => {
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
          env: { ...process.env, DATABASE_URL: database.url },
          encoding: "utf8",
          windowsHide: true,
        },
      );
      assert.match(output, /empty migration/u);
    });
    await t.test("old generation is isolated after a connection reset", async () => {
      await database.admin.query(
        'UPDATE sync_host."Job" SET "leaseUntil"=clock_timestamp()+interval \'2 minutes\' WHERE id=$1',
        ["receipt-job-a"],
      );
      await operatorControl(
        database.admin,
        'UPDATE "PlatformConnection" SET generation=1 WHERE id=$1',
        [syncScope().connectionId],
      );
      await assert.rejects(
        receive(worker, "receipt-job-a", fence, "page-3", "cursor-1", null, until),
      );
    });
  } finally {
    await Promise.allSettled([worker.end(), foreign.end()]);
    await closeSyncDatabase(database);
  }
});

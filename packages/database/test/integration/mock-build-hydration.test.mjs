import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import process from "node:process";
import { URL } from "node:url";
import {
  leasePortDatabase,
  closeLeasePortDatabase,
  waitForLeaseExpiry,
} from "../helpers/mock-source-lease-port-fixture.mjs";
import { preparedAppend } from "../helpers/mock-source-append-port-fixture.mjs";
import { eventFor } from "../helpers/mock-source-append-fixture.mjs";
import { fullSnapshot, changeControl } from "../helpers/mock-source-control-race-fixture.mjs";
import { advance, corruption } from "../helpers/mock-source-publish-fixture.mjs";
import { observeSourceSettings } from "../helpers/mock-source-control-fixture.mjs";
import {
  measuredHydration,
  assertPointPlans,
  addOldHistory,
} from "../helpers/mock-build-hydration-plan-fixture.mjs";
import { hydratePointSql } from "../../dist/src/mock-platform/hydration.js";

const source = await import("../../dist/src/mock-platform/index.js");
let context;
test.before(async () => {
  context = await leasePortDatabase(source, "hydration");
});
test.after(async () => {
  await closeLeasePortDatabase(context);
});
const iso = (at) => new Date(at).toISOString();
function key(kind) {
  return kind === "ORDER"
    ? [kind, "order"]
    : kind === "INVENTORY"
      ? [kind, "sku", "location"]
      : [kind, "campaign", "2024-02-29"];
}
function input(state, kind = "ORDER", beforeTime = state.through) {
  return { expectedCheckpointHash: state.hash, beforeTime, kind, entityKeys: [key(kind)] };
}
async function preparedHistory(orderId = "order") {
  const state = await preparedAppend(context, "mock/hydration", "2026-01-01T00:00:03.000Z");
  const start = Date.parse(state.lease.checkpoint.processedThrough);
  state.first = iso(start + 1000);
  state.through = iso(start + 2000);
  const events = [state.first, state.through].flatMap((at) =>
    ["ORDER", "INVENTORY", "MARKETING"].map((kind) =>
      eventFor({ scope: state.scope }, kind, "0", at, (after) => {
        if (kind === "ORDER") after.externalOrderId = orderId;
      }),
    ),
  );
  const appended = await context.worker.appendChunk(state.actor, state.lease, {
    expectedCheckpointHash: state.lease.checkpointHash,
    next: { processedThrough: state.through, sealed: false },
    events,
  });
  assert.equal(appended.status, "COMMITTED");
  state.hash = appended.checkpointHash;
  return state;
}
const hydrate = (state, request = input(state), lease = state.lease, actor = state.actor) =>
  context.worker.hydrateBuild(actor, lease, request);
test("worker hydrates one latest snapshot per requested key strictly before its checkpoint time", async () => {
  assert.equal(typeof context.worker.hydrateBuild, "function");
  const state = await preparedHistory(),
    before = await fullSnapshot(context.admin, state);
  for (const kind of ["ORDER", "INVENTORY", "MARKETING"]) {
    const result = await hydrate(state, input(state, kind));
    assert.equal(result.status, "HYDRATED");
    assert.equal(result.checkpointHash, state.hash);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].occurredAt, state.first);
    assert.equal(result.items[0].kind, kind);
  }
  assert.deepEqual(await fullSnapshot(context.admin, state), before);
});
test("missing keys and states exactly at beforeTime are absent", async () => {
  const state = await preparedHistory();
  assert.deepEqual((await hydrate(state, input(state, "ORDER", state.first))).items, []);
  assert.deepEqual(
    (await hydrate(state, { ...input(state), entityKeys: [["ORDER", "missing"]] })).items,
    [],
  );
});
test("recovery excludes a newer version beyond the checkpoint's committed prefix", async () => {
  const state = await preparedHistory();
  await corruption(
    context.rawAdmin,
    state,
    () =>
      context.rawAdmin.query(
        `INSERT INTO mock_platform."EntityVersion" SELECT (jsonb_populate_record(NULL::mock_platform."EntityVersion",
      to_jsonb(v)||jsonb_build_object('eventSeq',7,'occurredAt',$2::timestamp,'payload',
      jsonb_set(jsonb_set(v.payload,'{source,version}',to_jsonb('mock-runtime-v2:g:0:e:7'::text)),'{source,updatedAt}',to_jsonb($2::text))))).*
      FROM mock_platform."EntityVersion" v WHERE v."sessionId"=$1 AND v."eventSeq"=1`,
        [state.scope.sessionId, iso(Date.parse(state.first) + 500)],
      ),
    async () => {
      const result = await hydrate(state);
      assert.equal(result.status, "HYDRATED");
      assert.equal(result.items[0].eventSeq, "1");
    },
  );
});
test("a worker-visible version from an unrelated unpublished revision cannot hydrate this lease", async () => {
  const state = await preparedHistory();
  await corruption(
    context.rawAdmin,
    state,
    () =>
      context.rawAdmin.query(
        'UPDATE mock_platform."EntityVersion" SET "releaseRevision"=99 WHERE "sessionId"=$1 AND "eventSeq"=1',
        [state.scope.sessionId],
      ),
    async () => {
      const result = await hydrate(state);
      assert.equal(result.status, "HYDRATED");
      assert.deepEqual(result.items, []);
    },
  );
});
test("invalid recovery controls are rejected and stale checkpoints conflict", async () => {
  const state = await preparedHistory(),
    valid = input(state);
  for (const change of [
    { kind: "STORE" },
    { entityKeys: [] },
    { entityKeys: Array(101).fill(key("ORDER")) },
    { entityKeys: [key("ORDER"), key("ORDER")] },
    { entityKeys: [["INVENTORY", "sku", "location"]] },
    { entityKeys: [["ORDER", "bad\u0000key"]] },
    { beforeTime: "2026-02-30T00:00:00.000Z" },
    { extra: true },
  ])
    await assert.rejects(hydrate(state, { ...valid, ...change }), { code: "SOURCE_INPUT" });
  await assert.rejects(
    hydrate(state, { ...valid, beforeTime: iso(Date.parse(state.through) + 1) }),
    { code: "SOURCE_INPUT" },
  );
  assert.deepEqual(await hydrate(state, { ...valid, expectedCheckpointHash: "a".repeat(64) }), {
    status: "CONFLICT",
  });
});
test("failure takeover fences the old reference and preserves recovery state", async () => {
  const state = await preparedHistory();
  assert.deepEqual(await context.worker.fail(state.actor, state.lease, "INTERRUPTED"), {
    status: "FAILED",
  });
  const claimed = await context.worker.claim(state.actor, state.scope);
  assert.equal(claimed.status, "CLAIMED");
  assert.deepEqual(await hydrate(state), { status: "FENCED" });
  const result = await hydrate(state, input(state), claimed.lease);
  assert.equal(result.status, "HYDRATED");
  assert.equal(result.items[0].occurredAt, state.first);
});
async function publishedBase(state) {
  const sealed = await context.worker.appendChunk(state.actor, state.lease, {
    expectedCheckpointHash: state.hash,
    next: { processedThrough: state.lease.targetTime, sealed: true },
    events: [],
  });
  const published = await context.worker.publish(state.actor, state.lease, {
    expectedBaseRevision: state.lease.baseRevision,
    checkpointHash: sealed.checkpointHash,
  });
  assert.equal(published.status, "PUBLISHED");
  await advance(context.admin, { scope: state.scope }, "2026-01-01T00:00:04.000Z");
  return context.worker.claim(state.actor, state.scope);
}
async function assertUncertifiedBaseHidden(state, request, lease) {
  await corruption(
    context.rawAdmin,
    state,
    () =>
      context.rawAdmin.query(
        `DELETE FROM mock_platform."BuildJob" WHERE "sessionId"=$1 AND revision=$2`,
        [state.scope.sessionId, state.lease.revision],
      ),
    async () => {
      const hidden = await hydrate(state, request, lease);
      assert.equal(hidden.status, "HYDRATED");
      assert.deepEqual(hidden.items, []);
    },
  );
}
test("published base state is available to a new revision without exposing another scope", async () => {
  const state = await preparedHistory(),
    claimed = await publishedBase(state);
  assert.equal(claimed.status, "CLAIMED");
  const request = {
    ...input(state),
    beforeTime: state.lease.targetTime,
    expectedCheckpointHash: claimed.lease.checkpointHash,
  };
  const result = await hydrate(state, request, claimed.lease);
  assert.equal(result.status, "HYDRATED");
  assert.equal(result.items[0].releaseRevision, state.lease.revision);
  await assertUncertifiedBaseHidden(state, request, claimed.lease);
  const other = await preparedHistory();
  assert.deepEqual(await hydrate(state, input(state), claimed.lease, other.actor), {
    status: "DENIED",
  });
});
test("one hundred structured Unicode keys use bounded seeks through old history", async (t) => {
  const keys = Array.from({ length: 100 }, (_, index) => [
    "ORDER",
    `订单-${String(index).padStart(3, "0")}😀"\\`,
  ]);
  const state = await preparedHistory(keys[0][1]);
  await corruption(
    context.rawAdmin,
    state,
    () => addOldHistory(context.rawAdmin, state),
    async () => {
      await context.rawAdmin.query('ANALYZE mock_platform."EntityVersion"');
      const { result, plans } = await measuredHydration(t, hydratePointSql, () =>
        hydrate(state, { ...input(state), entityKeys: keys }),
      );
      assert.equal(result.status, "HYDRATED");
      assert.equal(result.items.length, 1);
      assert.deepEqual(
        result.items.map((row) => JSON.parse(row.entityKey)),
        [keys[0]],
      );
      assertPointPlans(plans);
    },
  );
});
test("recovery rechecks an independently revoked grant after reading the state", async (t) => {
  const state = await preparedHistory();
  const original = pg.Client.prototype.query;
  let changed = false;
  const spy = t.mock.method(pg.Client.prototype, "query", async function (sql, ...args) {
    const result = await original.call(this, sql, ...args);
    if (sql === hydratePointSql && !changed) {
      changed = true;
      await context.rawAdmin.query(
        "UPDATE demo.\"MockWorkerGrant\" SET status='REVOKED' WHERE id=$1",
        [state.actor.grantId],
      );
    }
    return result;
  });
  try {
    assert.deepEqual(await hydrate(state), { status: "DENIED" });
  } finally {
    spy.mock.restore();
    await context.rawAdmin.query(
      "UPDATE demo.\"MockWorkerGrant\" SET status='ACTIVE' WHERE id=$1",
      [state.actor.grantId],
    );
  }
  assert.equal((await hydrate(state)).status, "HYDRATED");
});
test("a real SQL failure rolls back identity and leaves the worker usable", async (t) => {
  const state = await preparedHistory();
  const original = pg.Client.prototype.query;
  let injected = false;
  const spy = t.mock.method(pg.Client.prototype, "query", async function (sql, ...args) {
    if (sql === hydratePointSql && !injected) {
      injected = true;
      return original.call(this, "SELECT 1/0");
    }
    return original.call(this, sql, ...args);
  });
  let observed;
  try {
    observed = await observeSourceSettings(() =>
      assert.rejects(hydrate(state), { code: "SOURCE_STORAGE", message: "SOURCE_STORAGE" }),
    );
  } finally {
    spy.mock.restore();
  }
  assert.ok(observed.length);
  for (const { settings } of observed)
    assert.ok(Object.values(settings).every((value) => value === "" || value === null));
  assert.equal((await hydrate(state)).status, "HYDRATED");
});
test("reset denies the old generation while preserving its persisted facts", async () => {
  const state = await preparedHistory(),
    before = await fullSnapshot(context.rawAdmin, state);
  const repo = await import("../../dist/src/index.js"),
    prior = process.env.DATABASE_URL;
  const url = new URL(context.env.MOCK_PLATFORM_READ_DATABASE_URL);
  url.username = new URL(context.server.url).username;
  await repo.disconnectPrismaClient();
  process.env.DATABASE_URL = url.toString();
  try {
    const reset = await changeControl(repo, state, "reset");
    assert.ok(reset);
    assert.deepEqual(await hydrate(state), { status: "DENIED" });
    const after = await fullSnapshot(context.rawAdmin, state);
    assert.deepEqual(after.events, before.events);
    assert.deepEqual(after.versions, before.versions);
  } finally {
    await repo.disconnectPrismaClient();
    if (prior === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prior;
  }
});
test(
  "natural expiry fences recovery and takeover resumes its committed prefix",
  { timeout: 60000 },
  async () => {
    const state = await preparedHistory();
    await waitForLeaseExpiry(context.rawAdmin, state.lease);
    assert.deepEqual(await hydrate(state), { status: "FENCED" });
    const claimed = await context.worker.claim(state.actor, state.scope);
    assert.equal(claimed.status, "CLAIMED");
    const result = await hydrate(state, input(state), claimed.lease);
    assert.equal(result.status, "HYDRATED");
    assert.equal(result.items[0].occurredAt, state.first);
  },
);

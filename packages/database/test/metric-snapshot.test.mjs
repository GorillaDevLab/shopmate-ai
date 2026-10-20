import assert from "node:assert/strict";
import { test } from "node:test";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { URL } from "node:url";
import { createMetricSnapshotRepository } from "../src/metric-snapshot.repository.ts";

const binding = {
  organizationId: "org-a",
  workspaceId: "workspace-a",
  storeId: "store-a",
  connectionId: "connection-a",
  externalStoreId: "external-a",
};
const actor = {
  userId: "user-a",
  merchantId: "merchant-a",
  organizationId: "org-a",
  workspaceId: "workspace-a",
  role: "ANALYST",
  permissions: [],
};
const start = "2026-10-01T16:00:00Z";
const end = "2026-10-02T06:00:00Z";
const window = { periodStart: start, periodEnd: end, timezone: "Asia/Shanghai", currency: "CNY" };
const common = {
  schemaVersion: 1,
  definitionVersion: "g4-v1",
  inputRevision: "revision-a",
  binding,
  ...window,
  visibleAt: end,
  sourceWatermark: end,
  evidenceIds: ["sync-a"],
};
const input = {
  ...common,
  status: "VERIFIED",
  paymentFacts: [],
  refundFacts: [],
  inventoryFacts: [],
  campaignFacts: [],
  frozenCosts: null,
  refundAllocations: null,
  returnReceipts: null,
  fees: null,
  traffic: null,
  inventoryExtensions: null,
  metricCoverage: [
    {
      ...common,
      observedAt: end,
      sourceVersion: "source-v1",
      kind: "PAID_REVENUE",
      subject: { kind: "STORE" },
      collections: ["paymentFacts"],
      coverageBasisPoints: 10000,
    },
  ],
};
const snapshot = {
  ...common,
  computedAt: end,
  sampleSize: 0,
  coverageBasisPoints: 10000,
  status: "VERIFIED",
  issues: [],
  subject: { kind: "STORE" },
  metric: { kind: "PAID_REVENUE", unit: "minorCNY", value: 0 },
};
const computation = { input, snapshot };
const hash = `sha256:${"a".repeat(64)}`;
const descriptor = {
  schemaVersion: 1,
  hashVersion: "metric-input-sha256-v1",
  definitionVersion: "g4-v1",
  inputRevision: "revision-a",
  binding,
  window,
  visibleAt: end,
  sourceWatermark: end,
  kind: "PAID_REVENUE",
  subject: { kind: "STORE" },
  inputHash: hash,
  evidenceIds: [`metric-evidence-v1:${"b".repeat(64)}`],
};
const query = {
  binding,
  window,
  kinds: ["PAID_REVENUE"],
  subject: { kind: "STORE" },
  definitionVersion: "g4-v1",
  inputRevision: null,
  visibleAt: end,
};

function row(value = snapshot, id = "00000000-0000-4000-8000-000000000001") {
  return {
    id,
    organizationId: binding.organizationId,
    workspaceId: binding.workspaceId,
    storeId: binding.storeId,
    connectionId: binding.connectionId,
    externalStoreId: binding.externalStoreId,
    key: value.metric.kind,
    definitionVersion: value.definitionVersion,
    schemaVersion: 1,
    hashVersion: "metric-input-sha256-v1",
    inputRevision: value.inputRevision,
    inputHash: hash,
    subjectKind: "STORE",
    subjectId: "",
    periodStart: new Date(value.periodStart),
    periodEnd: new Date(value.periodEnd),
    timezone: value.timezone,
    currency: value.currency,
    visibleAt: new Date(value.visibleAt),
    sourceWatermark: new Date(value.sourceWatermark),
    computedAt: new Date(value.computedAt),
    sampleSize: BigInt(value.sampleSize),
    coverageBasisPoints: value.coverageBasisPoints,
    status: value.status,
    evidenceIds: value.evidenceIds,
    issues: value.issues,
    valueMinor: BigInt(value.metric.value),
    valueUnits: null,
    valueBasisPoints: null,
    valueHours: null,
    createdAt: new Date(end),
  };
}

function database({ allowed = true, existing = [], fail = null, respond = null } = {}) {
  const calls = [];
  const rows = [...existing];
  const state = { allowed, released: 0, discarded: [] };
  const client = Object.assign(new EventEmitter(), {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (fail && sql.includes(fail)) throw new Error("secret connection detail");
      if (sql.includes("metric_scope_access")) return { rows: [{ allowed: state.allowed }] };
      const response = respond?.(sql, params);
      if (response) return response;
      if (sql.includes("metric_definitions")) return { rows: [{ unit: "minorCNY" }] };
      if (sql.includes("INSERT INTO public.metric_snapshots")) {
        if (rows.length) return { rows: [] };
        const saved = row();
        rows.push(saved);
        return { rows: [saved] };
      }
      if (sql.includes("FROM public.metric_snapshots")) return { rows };
      return { rows: [] };
    },
    release(discard) {
      state.released++;
      state.discarded.push(discard);
    },
  });
  return {
    pool: {
      async connect() {
        return client;
      },
    },
    calls,
    rows,
    state,
    client,
  };
}
function repository(db, proof = descriptor, principal = actor) {
  const hasher = { create: () => ({ ok: true, value: proof }) };
  return createMetricSnapshotRepository({ pool: db.pool, actor: principal, hasher });
}

test("append binds all scope fields locally and returns the persisted snapshot", async () => {
  const db = database();
  const result = await repository(db).append(computation);
  assert.deepEqual(result, { ok: true, value: snapshot });
  assert.equal(db.rows.length, 1);
  assert.match(db.calls[0].sql, /BEGIN ISOLATION LEVEL READ COMMITTED/);
  const settings = db.calls.find((call) => call.sql.includes("set_config"));
  assert.deepEqual(settings.params, [actor.userId, ...Object.values(binding)]);
  assert.match(db.calls.at(-1).sql, /COMMIT/);
});

test("duplicate semantic payload reuses original computedAt, evidence and id", async () => {
  const original = row();
  const db = database({ existing: [original] });
  const next = { ...snapshot, computedAt: "2026-10-02T07:00:00Z" };
  const result = await repository(db).append({ input, snapshot: next });
  assert.deepEqual(result, { ok: true, value: snapshot });
  assert.equal(db.rows[0], original);
  assert.equal(
    db.calls.some((call) => call.sql.includes("INSERT INTO")),
    false,
  );
});

test("same immutable revision with changed value returns typed conflict", async () => {
  const db = database({ existing: [row()] });
  const changed = { ...snapshot, metric: { ...snapshot.metric, value: 1 } };
  assert.deepEqual(await repository(db).append({ input, snapshot: changed }), {
    ok: false,
    error: { code: "CONFLICT", evidenceIds: [] },
  });
});

test("foreign actor or denied live membership cannot learn row existence", async () => {
  const db = database({ existing: [row()], allowed: false });
  assert.equal((await repository(db).byId({ binding, id: db.rows[0].id })).error.code, "NOT_FOUND");
  assert.equal((await repository(db).read(query)).error.code, "NOT_FOUND");
  const foreign = { ...actor, organizationId: "org-b" };
  assert.equal((await repository(db, descriptor, foreign).read(query)).error.code, "NOT_FOUND");
  assert.equal(
    db.calls.filter((call) => call.sql.includes("FROM public.metric_snapshots")).length,
    0,
  );
});

test("malformed input and detached hash descriptor fail before writes", async () => {
  const db = database();
  assert.equal(
    (await repository(db).append({ input, snapshot: { ...snapshot, extra: 1 } })).error.code,
    "INVALID_INPUT",
  );
  const detached = { ...descriptor, binding: { ...binding, storeId: "foreign" } };
  assert.equal((await repository(db, detached).append(computation)).error.code, "INVALID_INPUT");
  assert.equal(db.calls.length, 0);
});

test("database errors become SOURCE_UNAVAILABLE without leaking details", async () => {
  const db = database({ fail: "metric_scope_access" });
  assert.deepEqual(await repository(db).read(query), {
    ok: false,
    error: { code: "SOURCE_UNAVAILABLE", evidenceIds: [] },
  });
  assert.match(db.calls.at(-1).sql, /ROLLBACK/);
});

test("read validates filters and returns only strictly parsed persisted snapshots", async () => {
  const db = database({ existing: [row()] });
  assert.deepEqual(await repository(db).read(query), { ok: true, value: [snapshot] });
  assert.equal((await repository(db).read({ ...query, extra: 1 })).error.code, "INVALID_INPUT");
  db.rows[0] = { ...row(), issues: [{ code: "BAD", field: "x", evidenceIds: ["sync-a"] }] };
  assert.equal((await repository(db).read(query)).error.code, "SOURCE_UNAVAILABLE");
});

test("pg default bigint strings decode without precision loss", async () => {
  const saved = { ...row(), sampleSize: "0", valueMinor: "9007199254740991" };
  const result = await repository(database({ existing: [saved] })).read(query);
  assert.equal(result.ok, true);
  assert.equal(result.value[0].metric.value, Number.MAX_SAFE_INTEGER);
});

test("P13 normalized descriptor timestamps and unordered evidence remain idempotent", async () => {
  const normalized = {
    ...descriptor,
    window: {
      ...window,
      periodStart: new Date(start).toISOString(),
      periodEnd: new Date(end).toISOString(),
    },
    visibleAt: new Date(end).toISOString(),
    sourceWatermark: new Date(end).toISOString(),
  };
  const sources = ["sync-a", "sync-b"];
  const original = { ...snapshot, evidenceIds: sources };
  const db = database({ existing: [row(original)] });
  const next = JSON.parse(
    JSON.stringify(
      {
        input: { ...input, evidenceIds: sources },
        snapshot: { ...original, evidenceIds: [...sources].reverse() },
      },
      (_key, value) => (value === start || value === end ? new Date(value).toISOString() : value),
    ),
  );
  const result = await repository(db, normalized).append(next);
  assert.deepEqual(result, { ok: true, value: original });
});

test("insert targets the P14 unique index with inference, rather than a nonexistent constraint", async () => {
  const db = database();
  await repository(db).append(computation);
  const insert = db.calls.find((call) => call.sql.includes("INSERT INTO"));
  assert.doesNotMatch(insert.sql, /ON CONSTRAINT/);
  assert.match(insert.sql, /ON CONFLICT\s*\("organizationId"/);
});

test("malformed hasher descriptors return INVALID_INPUT before connecting", async () => {
  for (const proof of [
    null,
    { ...descriptor, evidenceIds: [] },
    { ...descriptor, visibleAt: "invalid" },
    { ...descriptor, inputHash: "wrong" },
  ]) {
    const db = database();
    assert.deepEqual(await repository(db, proof).append(computation), {
      ok: false,
      error: { code: "INVALID_INPUT", evidenceIds: [] },
    });
    assert.equal(db.calls.length, 0);
  }
});

test("auxiliary requests reject unknown fields before connecting", async () => {
  const db = database();
  const repo = repository(db);
  assert.equal(
    (await repo.byId({ binding, id: row().id, extra: true })).error.code,
    "INVALID_INPUT",
  );
  assert.equal(
    (await repo.history({ query, limit: 2, cursor: null, extra: true })).error.code,
    "INVALID_INPUT",
  );
  assert.equal(db.calls.length, 0);
});

test("bound authenticated actor is captured rather than retaining mutable caller identity", async () => {
  const principal = { ...actor };
  const db = database();
  const repo = repository(db, descriptor, principal);
  principal.userId = "user-attacker";
  await repo.read(query);
  assert.equal(db.calls.find((call) => call.sql.includes("set_config")).params[0], actor.userId);
});

test("stored malformed numbers and contradictory typed columns fail closed", async () => {
  for (const mutation of [
    { sampleSize: "9007199254740992" },
    { valueMinor: "1.5" },
    { valueMinor: " 1" },
    { valueMinor: "1e3" },
    { valueMinor: "9007199254740992" },
    { valueUnits: "1" },
    { subjectId: "unexpected" },
    { periodStart: 0 },
  ]) {
    const db = database({ existing: [{ ...row(), ...mutation }] });
    assert.equal((await repository(db).read(query)).error.code, "SOURCE_UNAVAILABLE");
  }
});

test("read captures validated filters before awaiting a database connection", async () => {
  const db = database();
  const mutable = { ...query, binding: { ...binding }, kinds: [...query.kinds] };
  const pending = repository(db).read(mutable);
  mutable.binding.storeId = "foreign-store";
  mutable.kinds.push("GMV");
  await pending;
  assert.equal(db.calls.find((call) => call.sql.includes("set_config")).params[3], binding.storeId);
  assert.deepEqual(db.calls.find((call) => call.sql.includes("ANY($14")).params[13], query.kinds);
});

test("history keyset cursor retains scope and timestamp/id tie breaking", async () => {
  const first = row();
  const second = row(snapshot, "00000000-0000-4000-8000-000000000002");
  const db = database({ existing: [second, first] });
  const repo = repository(db);
  const page = await repo.history({ query, limit: 1, cursor: null });
  assert.deepEqual(
    page.value.items.map((item) => item.id),
    [second.id],
  );
  assert.equal(typeof page.value.nextCursor, "string");
  db.rows.splice(0, db.rows.length, second);
  const next = await repo.history({ query, limit: 1, cursor: page.value.nextCursor });
  assert.equal(next.ok, true);
  const select = db.calls.at(-2);
  assert.match(select.sql, /ORDER BY "createdAt" DESC,"id" DESC LIMIT \$18/);
  assert.deepEqual(select.params.slice(15), [second.createdAt, second.id, 2]);
  const foreign = { ...query, binding: { ...binding, storeId: "foreign" } };
  assert.equal(
    (await repo.history({ query: foreign, limit: 1, cursor: page.value.nextCursor })).error.code,
    "INVALID_INPUT",
  );
});

test("unknown well formed cursor anchor returns the same NOT_FOUND without disclosing a foreign row", async () => {
  const cursor = Buffer.from(JSON.stringify({ query, id: row().id })).toString("base64url");
  const db = database();
  assert.equal((await repository(db).history({ query, limit: 1, cursor })).error.code, "NOT_FOUND");
  const select = db.calls.find((call) => call.sql.includes("FROM public.metric_snapshots"));
  assert.deepEqual(select.params.slice(0, 5), Object.values(binding));
  assert.match(select.sql, /"id"=\$16/);
});

test("history rejects invalid filters limits and cursors", async () => {
  for (const request of [
    { query, limit: 0, cursor: null },
    { query, limit: 101, cursor: null },
    { query, limit: 1.5, cursor: null },
    { query, limit: 1, cursor: "???" },
    { query: { ...query, kinds: [] }, limit: 1, cursor: null },
  ]) {
    assert.equal((await repository(database()).history(request)).error.code, "INVALID_INPUT");
  }
});

test("scope authorization is freshly checked and never trusts the caller role", async () => {
  const db = database({ existing: [row()] });
  const repo = repository(db, descriptor, { ...actor, role: "OWNER" });
  assert.equal((await repo.read(query)).ok, true);
  db.state.allowed = false;
  assert.equal((await repo.read(query)).error.code, "NOT_FOUND");
  assert.equal((await repo.append(computation)).error.code, "FORBIDDEN");
  assert.equal(db.calls.filter((call) => call.sql.includes("metric_scope_access")).length, 3);
  assert.equal(db.state.released, 3);
});

test("concurrent identical insert re-reads and preserves the winning original snapshot", async () => {
  let selects = 0;
  const original = row();
  const db = database({
    respond(sql) {
      if (sql.includes("FROM public.metric_snapshots"))
        return { rows: ++selects === 1 ? [] : [original] };
      if (sql.includes("INSERT INTO")) return { rows: [] };
      return null;
    },
  });
  const result = await repository(db).append({
    input,
    snapshot: { ...snapshot, computedAt: "2026-10-02T07:00:00Z" },
  });
  assert.deepEqual(result, { ok: true, value: snapshot });
  assert.equal(selects, 2);
});

test("changed hash evidence quality or cutoff cannot overwrite an immutable revision", async () => {
  const variants = [
    { stored: { ...row(), inputHash: `sha256:${"c".repeat(64)}` } },
    { stored: row({ ...snapshot, evidenceIds: ["sync-b"] }) },
    { stored: row({ ...snapshot, sampleSize: 1 }) },
    {
      stored: row({
        ...snapshot,
        visibleAt: "2026-10-02T06:00:01Z",
        computedAt: "2026-10-02T06:00:01Z",
      }),
    },
  ];
  for (const { stored } of variants) {
    const db = database({ existing: [stored] });
    assert.equal((await repository(db).append(computation)).error.code, "CONFLICT");
    assert.equal(
      db.calls.some((call) => call.sql.includes("INSERT INTO")),
      false,
    );
  }
});

test("missing or mismatched approved definition produces VERSION_MISMATCH", async () => {
  const db = database({
    respond: (sql) => (sql.includes("metric_definitions") ? { rows: [] } : null),
  });
  assert.equal((await repository(db).append(computation)).error.code, "VERSION_MISMATCH");
  assert.match(db.calls.at(-1).sql, /ROLLBACK/);
});

test("connection and insert failures return only typed SOURCE_UNAVAILABLE and release clients", async () => {
  const unavailable = {
    pool: {
      connect() {
        throw new Error("secret");
      },
    },
  };
  assert.equal((await repository(unavailable).read(query)).error.code, "SOURCE_UNAVAILABLE");
  const db = database({ fail: "INSERT INTO" });
  assert.deepEqual(await repository(db).append(computation), {
    ok: false,
    error: { code: "SOURCE_UNAVAILABLE", evidenceIds: [] },
  });
  assert.match(db.calls.at(-1).sql, /ROLLBACK/);
  assert.equal(db.state.released, 1);
});

test("by-id returns persisted metadata and parameterizes literal external identifiers", async () => {
  const db = database({ existing: [row()] });
  const request = {
    binding: { ...binding, externalStoreId: "literal'); SELECT secret; --" },
    id: row().id,
  };
  const result = await repository(db).byId(request);
  assert.deepEqual(result, { ok: true, value: { id: row().id, inputHash: hash, snapshot } });
  const select = db.calls.find((call) => call.sql.includes("FROM public.metric_snapshots"));
  assert.equal(select.params[4], request.binding.externalStoreId);
  assert.equal(select.params[5], request.id);
  assert.equal(select.sql.includes(request.binding.externalStoreId), false);
});

test("history cursors can replay valid long query identifiers", async () => {
  const longQuery = {
    ...query,
    definitionVersion: "定义".repeat(128),
    inputRevision: "修订".repeat(128),
    subject: { kind: "SKU", externalSkuId: "库存".repeat(128) },
    binding: { ...binding, externalStoreId: "商店".repeat(128) },
  };
  const db = database({ existing: [row(), row()] });
  const repo = repository(db);
  const page = await repo.history({ query: longQuery, limit: 1, cursor: null });
  assert.equal(page.ok, true);
  assert.equal(
    (await repo.history({ query: longQuery, limit: 1, cursor: page.value.nextCursor })).ok,
    true,
  );
});

test("database package exports the repository factory without runtime wiring", async () => {
  const publicApi = await import("../src/index.ts");
  assert.equal(publicApi.createMetricSnapshotRepository, createMetricSnapshotRepository);
});

function checkedOutErrorScript() {
  return `
    import { EventEmitter } from 'node:events';
    import { createMetricSnapshotRepository } from ${JSON.stringify(new URL("../src/metric-snapshot.repository.ts", import.meta.url).href)};
    const actor = ${JSON.stringify(actor)};
    const query = ${JSON.stringify(query)};
    let discarded;
    const client = Object.assign(new EventEmitter(), {
      query(sql) {
        if (sql.includes('set_config')) return new Promise((resolve, reject) => {
          setImmediate(() => {
            const error = new Error('socket terminated');
            reject(error);
            client.emit('error', error);
          });
        });
        return Promise.resolve({ rows: [] });
      },
      release(discard) { discarded = discard; }
    });
    const pool = { async connect() { return client; } };
    const hasher = { create() { throw new Error('read must not hash'); } };
    const result = await createMetricSnapshotRepository({ pool, actor, hasher }).read(query);
    process.stdout.write(JSON.stringify({ result, discarded, listeners: client.listenerCount('error') }));
  `;
}

test("checked-out socket error emits are contained and discard the client without crashing Node", () => {
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", checkedOutErrorScript()],
    {
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    result: { ok: false, error: { code: "SOURCE_UNAVAILABLE", evidenceIds: [] } },
    discarded: true,
    listeners: 0,
  });
});

test("ordinary query failure rolls back and removes the checked-out client listener", async () => {
  const db = database({ fail: "FROM public.metric_snapshots" });
  assert.equal((await repository(db).read(query)).error.code, "SOURCE_UNAVAILABLE");
  assert.match(db.calls.at(-1).sql, /ROLLBACK/);
  assert.deepEqual(db.state.discarded, [false]);
  assert.equal(db.client.listenerCount("error"), 0);
});

test("failed rollback discards a client whose transaction state is uncertain", async () => {
  const db = database({
    respond(sql) {
      if (sql === "ROLLBACK" || sql.includes("FROM public.metric_snapshots"))
        throw new Error("query failed");
      return null;
    },
  });
  assert.equal((await repository(db).read(query)).error.code, "SOURCE_UNAVAILABLE");
  assert.deepEqual(db.state.discarded, [true]);
  assert.equal(db.client.listenerCount("error"), 0);
});

test("emitted socket errors cannot turn a fulfilled query into success", async () => {
  for (const stage of ["FROM public.metric_snapshots", "COMMIT"]) {
    const db = database({
      respond(sql) {
        if (sql.includes(stage)) db.client.emit("error", new Error("socket terminated"));
        return null;
      },
    });
    assert.equal((await repository(db).read(query)).error.code, "SOURCE_UNAVAILABLE");
    assert.deepEqual(db.state.discarded, [true]);
    assert.equal(db.client.listenerCount("error"), 0);
  }
});

test("success and denied authorization release clients and remove only the repository listener", async () => {
  for (const allowed of [true, false]) {
    const db = database({ allowed });
    const existingListener = () => {};
    db.client.on("error", existingListener);
    await repository(db).read(query);
    assert.deepEqual(db.state.discarded, [false]);
    assert.deepEqual(db.client.listeners("error"), [existingListener]);
  }
});

test("a failed explicit rollback is discarded even if retrying rollback could succeed", async () => {
  let rollbacks = 0;
  const db = database({
    allowed: false,
    respond(sql) {
      if (sql === "ROLLBACK" && ++rollbacks === 1) throw new Error("rollback lost connection");
      return null;
    },
  });
  assert.equal((await repository(db).read(query)).error.code, "SOURCE_UNAVAILABLE");
  assert.deepEqual(db.state.discarded, [true]);
  assert.equal(rollbacks, 1);
  assert.equal(db.client.listenerCount("error"), 0);
});

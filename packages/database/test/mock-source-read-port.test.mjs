import assert from "node:assert/strict";
import test from "node:test";

const module = await import("../dist/src/mock-platform/read-port.js").catch(() => null);
const key = "k".repeat(32);
const actor = { userId: "human", merchantId: "merchant" };
const scope = {
  organizationId: "org",
  workspaceId: "workspace",
  storeId: "store",
  sessionId: "session",
  connectionId: "connection",
  externalStoreId: "mock/store",
  generation: 0,
};
const publication = {
  revision: "1",
  highEventSeq: "2",
  certificateHash: "a".repeat(64),
  targetTime: "2026-01-02T00:00:00.000Z",
};
const request = {
  kind: "PRODUCT",
  requestedUntil: publication.targetTime,
  businessNow: "2026-01-01T00:00:00.000Z",
  limit: 1,
  contextHash: "b".repeat(64),
};

function fakeReader(found = publication) {
  const calls = [];
  return {
    calls,
    async findPublication(...args) {
      calls.push(["publication", ...args]);
      return found;
    },
    async readLatestStates(...args) {
      calls.push(["latest", ...args]);
      return { publication, items: [], nextCursor: null };
    },
  };
}

test("read-only composition discovers coverage then pins the first latest read with identical control", async () => {
  assert.ok(module, "read-only source composition must exist");
  const reader = fakeReader();
  const port = module.bindSourceReadPort(reader, key, actor, scope);
  const control = {
    signal: new globalThis.AbortController().signal,
    deadlineAt: new Date(Date.now() + 5000).toISOString(),
  };
  const page = await port.read(request, control);
  assert.equal(page.effectiveUntil, request.businessNow);
  assert.equal(reader.calls.length, 2);
  assert.deepEqual(reader.calls[0][3], control);
  assert.equal(reader.calls[0][3], reader.calls[1][4]);
  assert.deepEqual(reader.calls[1][3].publication, {
    revision: publication.revision,
    highEventSeq: publication.highEventSeq,
    certificateHash: publication.certificateHash,
  });
});

test("unpublished and insufficient coverage stay unknown without reading entity data", async () => {
  assert.ok(module, "read-only source composition must exist");
  for (const found of [null, { ...publication, targetTime: "2025-12-31T00:00:00.000Z" }]) {
    const reader = fakeReader(found);
    assert.equal(await module.bindSourceReadPort(reader, key, actor, scope).read(request), null);
    assert.equal(reader.calls.length, 1);
  }
});

test("the read facade preserves legal commerce identities for certified absence", async () => {
  for (const id of ["x".repeat(256), "界".repeat(256), "\ud800"]) {
    const reader = fakeReader();
    const page = await module
      .bindSourceReadPort(reader, key, actor, scope)
      .read({ ...request, entityKey: ["PRODUCT", id] });
    assert.deepEqual(page.items, []);
    assert.equal(reader.calls[1][3].entityKey[1], id);
  }
});

test("continuations restore the signed first cutoff as business time advances", async () => {
  assert.ok(module);
  const { createLatestCursor, readLatestCursor } = await import(
    "../dist/src/mock-platform/latest-cursor.js"
  );
  const input = {
    until: request.businessNow,
    kind: request.kind,
    limit: request.limit,
    contextHash: request.contextHash,
  };
  const cursor = createLatestCursor(
    key,
    scope,
    publication,
    input,
    { kind: "PRODUCT", entityKey: '["PRODUCT", "a"]', eventSeq: "1" },
    Date.now() + 60_000,
  );
  const reader = fakeReader();
  const original = reader.readLatestStates;
  reader.readLatestStates = async (...args) => {
    readLatestCursor(key, args[2].cursor, args[1], args[2]);
    return original(...args);
  };
  const port = module.bindSourceReadPort(reader, key, actor, scope);
  const page = await port.read({ ...request, cursor, businessNow: publication.targetTime });
  assert.equal(page.effectiveUntil, request.businessNow);
  assert.equal(reader.calls.length, 1);
  assert.equal(reader.calls[0][0], "latest");
  assert.equal(reader.calls[0][3].until, request.businessNow);
  await assert.rejects(port.read({ ...request, cursor, contextHash: "c".repeat(64) }), {
    code: "SOURCE_INPUT",
  });
});

test("read-port input rejects malformed values and hostile tuples before source I/O", async () => {
  assert.ok(module);
  const reader = fakeReader();
  const port = module.bindSourceReadPort(reader, key, actor, scope);
  for (const changed of [
    { requestedUntil: "2026-02-30T00:00:00.000Z" },
    { businessNow: "bad" },
    { cursor: "" },
    { contextHash: "bad" },
    { entityKey: '["PRODUCT", "x"]' },
    { entityKey: ["ORDER", "x"] },
    { extra: true },
    { limit: 0 },
  ])
    await assert.rejects(port.read({ ...request, ...changed }), { code: "SOURCE_INPUT" });
  const tuple = ["PRODUCT", "x"];
  let invoked = false;
  tuple.toJSON = () => {
    invoked = true;
    return ["PRODUCT", "other"];
  };
  await assert.rejects(port.read({ ...request, entityKey: tuple }), { code: "SOURCE_INPUT" });
  assert.equal(invoked, false);
  assert.equal(reader.calls.length, 0);
});

test("the read-only package facade exposes no signing codec, key or worker operations", async () => {
  const entry = await import("../dist/src/mock-platform/readonly-index.js");
  assert.deepEqual(Object.keys(entry).sort(), ["SourceStorageError", "createMockSourceReadPorts"]);
  assert.throws(() => entry.createMockSourceReadPorts({}), { code: "SOURCE_CONFIGURATION" });
  const factory = entry.createMockSourceReadPorts({
    MOCK_SOURCE_CURSOR_KEY: key,
    MOCK_PLATFORM_READ_DATABASE_URL: "postgresql://reader@127.0.0.1:1/test",
  });
  const port = factory.bind(actor, scope);
  assert.deepEqual(Object.keys(factory).sort(), ["bind", "close"]);
  assert.deepEqual(Object.keys(port), ["findPublication", "refreshCheckpoint", "read"]);
  await factory.close();
  await assert.rejects(port.findPublication(), { code: "SOURCE_STORAGE" });
  await assert.rejects(port.read(request), { code: "SOURCE_STORAGE" });
  await assert.rejects(port.refreshCheckpoint(request), { code: "SOURCE_STORAGE" });
  assert.throws(() => factory.bind(actor, scope), { code: "SOURCE_STORAGE" });
});

test("publication discovery keeps the bound identity and scope and preserves unknown coverage", async () => {
  for (const found of [publication, null]) {
    const reader = fakeReader(found);
    const identity = { ...actor },
      selected = { ...scope };
    const port = module.bindSourceReadPort(reader, key, identity, selected);
    identity.userId = "other";
    selected.connectionId = "other";
    const control = {
      signal: new globalThis.AbortController().signal,
      deadlineAt: new Date(Date.now() + 5000).toISOString(),
    };
    assert.deepEqual(await port.findPublication(control), found);
    assert.equal(reader.calls.length, 1);
    assert.deepEqual(reader.calls[0].slice(1), [actor, scope, control]);
  }
});

test("bound identity, scope and request stay fixed while publication discovery is in flight", async () => {
  assert.ok(module);
  const selected = { ...scope },
    identity = { ...actor },
    query = { ...request };
  const reader = fakeReader();
  const original = reader.findPublication;
  reader.findPublication = async (...args) => {
    selected.connectionId = "other";
    identity.userId = "other";
    query.kind = "ORDER";
    query.limit = 200;
    return original(...args);
  };
  const page = await module.bindSourceReadPort(reader, key, identity, selected).read(query);
  assert.equal(page.effectiveUntil, request.businessNow);
  assert.deepEqual(reader.calls[1][1], actor);
  assert.deepEqual(reader.calls[1][2], scope);
  assert.equal(reader.calls[1][3].kind, request.kind);
  assert.equal(reader.calls[1][3].limit, request.limit);
});

test("default and long caller deadlines share one capped absolute budget across source operations", async () => {
  assert.ok(module);
  for (const control of [undefined, { deadlineAt: new Date(Date.now() + 90_000).toISOString() }]) {
    const reader = fakeReader();
    const started = Date.now();
    await module.bindSourceReadPort(reader, key, actor, scope).read(request, control);
    const captured = reader.calls[0][3];
    assert.ok(captured && Date.parse(captured.deadlineAt) <= started + 30_100);
    assert.equal(captured, reader.calls[1][4]);
  }
});

test("read-port controls reject accessors and proxies before invoking them or source I/O", async () => {
  const reader = fakeReader();
  const port = module.bindSourceReadPort(reader, key, actor, scope);
  let invoked = false;
  const accessor = {
    get deadlineAt() {
      invoked = true;
      return request.businessNow;
    },
  };
  const proxy = new Proxy(
    {},
    {
      get() {
        invoked = true;
        return undefined;
      },
    },
  );
  for (const control of [accessor, proxy, { extra: true }, { signal: {} }])
    for (const operation of [
      () => port.read(request, control),
      () => port.findPublication(control),
    ])
      await assert.rejects(operation(), { code: "SOURCE_INPUT" });
  assert.equal(invoked, false);
  assert.equal(reader.calls.length, 0);
});

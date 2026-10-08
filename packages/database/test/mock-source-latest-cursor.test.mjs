import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { createLatestCursor, readLatestCursor } from "../dist/src/mock-platform/latest-cursor.js";

const key = "k".repeat(32);
const now = Date.now();
const scope = {
  organizationId: "o".repeat(128),
  workspaceId: "w".repeat(128),
  storeId: "s".repeat(128),
  sessionId: "t".repeat(128),
  connectionId: "c".repeat(128),
  externalStoreId: "店".repeat(200),
  generation: 2_147_483_647,
};
const publication = {
  certificateHash: "a".repeat(64),
  revision: "9223372036854775807",
  highEventSeq: "9223372036854775807",
  targetTime: "2026-01-01T00:00:00.000Z",
};
const input = {
  until: publication.targetTime,
  limit: 200,
  kind: "PRODUCT",
  contextHash: "b".repeat(64),
};
const position = {
  kind: "PRODUCT",
  entityKey: '["PRODUCT", "' + "产".repeat(200) + '"]',
  eventSeq: "42",
};
const expiresAt = now + 60_000;
const mint = () => createLatestCursor(key, scope, publication, input, position, expiresAt, now);

test("latest witness cursor stays below Connector bounds for maximum scope and key sizes", () => {
  const cursor = mint();
  assert.ok(cursor.length <= 1024, `Cursor has ${cursor.length} characters`);
  assert.deepEqual(readLatestCursor(key, cursor, scope, input, now + 1), {
    certificateHash: publication.certificateHash,
    revision: publication.revision,
    highEventSeq: publication.highEventSeq,
    until: input.until,
    afterEventSeq: position.eventSeq,
    expiresAt,
  });
});

test("latest compact cursor binds full scope, query context and signing domain", () => {
  const cursor = mint();
  for (const field of Object.keys(scope)) {
    const changed = { ...scope, [field]: field === "generation" ? 0 : "other" };
    assert.throws(() => readLatestCursor(key, cursor, changed, input, now), {
      code: "SOURCE_INPUT",
    });
  }
  for (const change of [
    { contextHash: "c".repeat(64) },
    { limit: 32 },
    { kind: "ORDER" },
    { until: "2025-12-31T00:00:00.000Z" },
    { entityKey: position.entityKey },
  ])
    assert.throws(() => readLatestCursor(key, cursor, scope, { ...input, ...change }, now), {
      code: "SOURCE_INPUT",
    });
  assert.throws(() => readLatestCursor("z".repeat(32), cursor, scope, input, now), {
    code: "SOURCE_INPUT",
  });
});

test("latest compact cursor rejects tampering and preserves its absolute expiry", () => {
  const cursor = mint();
  assert.equal(mint(), cursor);
  for (const token of [cursor + "!", cursor.slice(1), "x".repeat(1025)])
    assert.throws(() => readLatestCursor(key, token, scope, input, now), { code: "SOURCE_INPUT" });
  assert.throws(() => readLatestCursor(key, cursor, scope, input, expiresAt), {
    code: "SOURCE_INPUT",
  });
});

test("latest compact decoder rejects signed malformed envelopes", () => {
  const [payload] = mint().split(".");
  const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  for (const change of [
    { v: 2 },
    { extra: true },
    { a: "0" },
    { a: "9223372036854775808" },
    { r: "01" },
    { h: "41" },
    { t: "2026-02-30T00:00:00.000Z" },
    { e: now + 900_001 },
    { e: now },
    { c: "Z".repeat(64) },
  ]) {
    const altered = Buffer.from(JSON.stringify({ ...state, ...change }), "utf8").toString(
      "base64url",
    );
    const signature = createHmac("sha256", key)
      .update("mock-source-latest-compact-v1\n")
      .update(altered, "ascii")
      .digest("base64url");
    assert.throws(() => readLatestCursor(key, `${altered}.${signature}`, scope, input, now), {
      code: "SOURCE_INPUT",
    });
  }
});

test("structured exact key contents are signed and maximum witness integers remain bounded", (t) => {
  const query = { ...input, entityKey: ["PRODUCT", 'quoted/"中文'] };
  const after = { ...position, eventSeq: "9223372036854775807" };
  const cursor = createLatestCursor(key, scope, publication, query, after, expiresAt, now);
  assert.ok(cursor.length < 700);
  t.diagnostic(`Maximum signed integer witness cursor: ${cursor.length} characters`);
  for (const entityKey of [
    ["PRODUCT", "other"],
    ["ORDER", 'quoted/"中文'],
    JSON.stringify(query.entityKey),
  ])
    assert.throws(() => readLatestCursor(key, cursor, scope, { ...query, entityKey }, now), {
      code: "SOURCE_INPUT",
    });
});

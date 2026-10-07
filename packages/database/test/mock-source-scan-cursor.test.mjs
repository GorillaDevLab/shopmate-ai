import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createScanCursor, readScanCursor } from "../dist/src/mock-platform/scan-cursor.js";

const key = "k".repeat(32);
const now = Date.parse("2026-01-02T00:00:00.000Z");
const scope = {
  organizationId: "org-a",
  workspaceId: "workspace-a",
  storeId: "store-a",
  sessionId: "session-a",
  connectionId: "connection-a",
  externalStoreId: "mock/store.a",
  generation: 0,
};
const state = {
  scope,
  certificateHash: "a".repeat(64),
  revision: "2",
  highEventSeq: "42",
  since: "2026-01-01T00:00:00.000Z",
  until: "2026-01-02T00:00:00.000Z",
  kind: "PRODUCT",
  entityKey: null,
  after: { kind: "PRODUCT", entityKey: '["PRODUCT","product-1"]', eventSeq: "12" },
  expiresAt: now + 60_000,
};

test("signed scan cursor resumes the exact published window and tuple", () => {
  const cursor = createScanCursor(key, state, now);
  assert.deepEqual(readScanCursor(key, cursor, scope, now + 1000), state);
  assert.match(cursor, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
});

test("signed scan cursor preserves the entity filter", () => {
  const filtered = { ...state, entityKey: state.after.entityKey };
  const cursor = createScanCursor(key, filtered, now);
  assert.deepEqual(readScanCursor(key, cursor, scope, now + 1000), filtered);
  assert.notEqual(cursor, createScanCursor(key, state, now));
});

test("signed pre-filter cursor resumes as an unfiltered scan", () => {
  const legacy = { ...state };
  delete legacy.kind;
  delete legacy.entityKey;
  const payload = Buffer.from(JSON.stringify(legacy), "utf8").toString("base64url");
  const signature = createHmac("sha256", key).update(payload, "ascii").digest("base64url");
  assert.deepEqual(readScanCursor(key, `${payload}.${signature}`, scope, now), {
    ...legacy,
    kind: null,
    entityKey: null,
  });
});

test("scan cursor rejects payload, signature, scope and certificate tampering", () => {
  const cursor = createScanCursor(key, state, now);
  const [payload, signature] = cursor.split(".");
  for (const invalid of [
    `${payload}x.${signature}`,
    `${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`,
    `${payload}.${signature}.extra`,
    "x".repeat(4097),
  ])
    assert.throws(() => readScanCursor(key, invalid, scope, now), { code: "SOURCE_INPUT" });
  assert.throws(() => readScanCursor(key, cursor, { ...scope, storeId: "store-b" }, now), {
    code: "SOURCE_INPUT",
  });
  assert.throws(() => readScanCursor("z".repeat(32), cursor, scope, now), {
    code: "SOURCE_INPUT",
  });
});

test("scan cursor expires and cannot be minted for an invalid window or unbounded lifetime", () => {
  const cursor = createScanCursor(key, state, now);
  assert.throws(() => readScanCursor(key, cursor, scope, state.expiresAt), {
    code: "SOURCE_INPUT",
  });
  for (const invalid of [
    { ...state, since: "2026-01-03T00:00:00.000Z" },
    { ...state, expiresAt: now + 16 * 60_000 },
    { ...state, after: { ...state.after, eventSeq: "01" } },
    { ...state, kind: "NOT_A_KIND" },
    { ...state, kind: null, entityKey: '["PRODUCT","product-1"]' },
  ])
    assert.throws(() => createScanCursor(key, invalid, now), { code: "SOURCE_INPUT" });
  assert.throws(() => createScanCursor("short", state, now), { code: "SOURCE_CONFIGURATION" });
});

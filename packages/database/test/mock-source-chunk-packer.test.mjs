import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { packSourceChunk } from "../dist/src/mock-platform/chunk-packer.js";
import { eventTuple } from "../dist/src/mock-platform/record-codec.js";
import { validateChunk } from "../dist/src/mock-platform/publication-validation.js";
import { eventFor, largeProduct } from "./helpers/mock-source-append-fixture.mjs";
import { scopeFor } from "./helpers/mock-platform-fixture.mjs";

const at = "2026-01-01T00:00:00.000Z";
const scope = scopeFor();
const context = { scope, job: { targetTime: at } };
const plan = () => ({
  scope,
  baseRevision: "0",
  baseHighEventSeq: "0",
  expectedCheckpointHash: "a".repeat(64),
  windowEnd: at,
  targetTime: "2026-01-02T00:00:00.000Z",
  checkpoint: {
    codec: "source-checkpoint-v1",
    chunkIndex: "0",
    highEventSeq: "0",
    processedThrough: "2025-12-31T23:59:59.999Z",
    lastEvent: null,
    sealed: false,
  },
});
test("the real initial frontier includes baseline records at opening time", () => {
  const current = plan();
  current.checkpoint.processedThrough = current.windowEnd = current.targetTime = at;
  const result = packSourceChunk(current, [order()]);
  assert.equal(result.events.length, 1);
  assert.equal(result.next.sealed, true);
});
test("new revisions exclude the published base boundary even if the base was empty", () => {
  const current = plan();
  current.baseRevision = "1";
  current.checkpoint.processedThrough = current.windowEnd = current.targetTime = at;
  assert.equal(packSourceChunk(current, [order()]).events.length, 0);
  current.baseHighEventSeq = current.checkpoint.highEventSeq = "5";
  current.checkpoint.lastEvent = eventTuple(order("2"));
  assert.equal(packSourceChunk(current, [order("3")]).events.length, 0);
});
const order = (ordinal = "0") => eventFor(context, "ORDER", ordinal, at);

test("a smaller host budget preserves the unaccepted timestamp tail", () => {
  const current = plan();
  current.targetTime = at;
  const events = Array.from({ length: 21 }, (_, index) => order(String(index)));
  const first = packSourceChunk(current, events, 20);
  assert.equal(first.events.length, 20);
  assert.equal(first.next.sealed, false);
  current.checkpoint = {
    ...current.checkpoint,
    chunkIndex: "1",
    highEventSeq: "20",
    processedThrough: at,
    lastEvent: eventTuple(first.events[19]),
  };
  const final = packSourceChunk(current, events, 20);
  assert.equal(final.events.length, 1);
  assert.equal(final.next.sealed, true);
  for (const invalid of [0, 101, 1.5, NaN])
    assert.throws(() => packSourceChunk(plan(), events, invalid), { code: "SOURCE_INPUT" });
});

test("packs at most 100 events and resumes inside a timestamp using numeric ordinals", () => {
  const events = Array.from({ length: 125 }, (_, index) => order(String(index)));
  const first = packSourceChunk(plan(), events);
  assert.equal(first.events.length, 100);
  assert.deepEqual(first.next, { processedThrough: at, sealed: false });
  validateChunk(first, scope);
  const next = plan();
  next.checkpoint = {
    ...next.checkpoint,
    chunkIndex: "1",
    highEventSeq: "100",
    processedThrough: at,
    lastEvent: eventTuple(first.events[99]),
  };
  const second = packSourceChunk(next, events);
  assert.equal(second.events.length, 25);
  assert.equal(second.events[0].ordinal, "100");
  assert.equal(second.events[24].ordinal, "124");
  validateChunk(second, scope);
});
test("the actual UTF8 JSON append envelope stays within two MiB", () => {
  const events = Array.from({ length: 20 }, (_, index) => largeProduct(context, index));
  const result = packSourceChunk(plan(), events);
  assert.ok(result.events.length > 0 && result.events.length < events.length);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 2 * 1024 * 1024);
  validateChunk(result, scope);
  const extra = { ...result, events: [...result.events, events[result.events.length]] };
  assert.ok(Buffer.byteLength(JSON.stringify(extra), "utf8") > 2 * 1024 * 1024);
});
test("only an exhausted target window seals; empty windows advance without fabricated records", () => {
  const current = plan();
  assert.deepEqual(packSourceChunk(current, []).next, { processedThrough: at, sealed: false });
  current.targetTime = at;
  assert.deepEqual(packSourceChunk(current, []).next, { processedThrough: at, sealed: true });
  assert.deepEqual(packSourceChunk(current, [order()]).next, {
    processedThrough: at,
    sealed: true,
  });
});
test("a covered gap skips the entire old boundary even when its last event is earlier", () => {
  const current = plan();
  const old = order();
  old.occurredAt = old.after.source.updatedAt = "2025-12-31T23:00:00.000Z";
  current.checkpoint = {
    ...current.checkpoint,
    highEventSeq: "1",
    processedThrough: at,
    lastEvent: eventTuple(old),
  };
  current.windowEnd = "2026-01-01T00:00:00.001Z";
  assert.equal(packSourceChunk(current, [order()]).events.length, 0);
});
test("a nonterminal empty chunk must make durable time progress", () => {
  const current = plan();
  current.checkpoint.processedThrough = at;
  assert.throws(() => packSourceChunk(current, []), { code: "SOURCE_INPUT" });
});
test("rejects unordered tuples, wrong namespaces and events beyond the frozen window", () => {
  assert.throws(() => packSourceChunk(plan(), [order("10"), order("2")]), { code: "SOURCE_INPUT" });
  const foreign = order();
  foreign.after.externalStoreId = "foreign";
  assert.throws(() => packSourceChunk(plan(), [foreign]), { code: "SOURCE_INPUT" });
  const future = order();
  future.occurredAt = future.after.source.updatedAt = "2026-01-01T00:00:00.001Z";
  assert.throws(() => packSourceChunk(plan(), [future]), { code: "SOURCE_INPUT" });
});
test("a packed chunk owns its payload and closes a deferred iterator", () => {
  const event = order();
  const result = packSourceChunk(plan(), [event]);
  event.after.status = "CANCELLED";
  assert.equal(result.events[0].after.status, "PAID");
  let closed = false;
  function* generate() {
    try {
      for (let index = 0; index < 101; index++) yield order(String(index));
    } finally {
      closed = true;
    }
  }
  assert.equal(packSourceChunk(plan(), generate()).events.length, 100);
  assert.equal(closed, true);
});
test("bounded checkpoint replay rejects an iterator that never progresses", () => {
  const current = plan();
  current.checkpoint = {
    ...current.checkpoint,
    highEventSeq: "1",
    processedThrough: at,
    lastEvent: eventTuple(order("20000")),
  };
  function* acceptedPrefix() {
    for (let index = 0; index < 20000; index++) yield order(String(index));
  }
  assert.throws(() => packSourceChunk(current, acceptedPrefix()), { code: "SOURCE_INPUT" });
});
test("replayed payload bytes have a separate bounded budget", () => {
  const current = plan();
  const event = largeProduct(context);
  current.checkpoint = {
    ...current.checkpoint,
    highEventSeq: "1",
    processedThrough: at,
    lastEvent: eventTuple({ ...event, ordinal: "400" }),
  };
  let examined = 0;
  function* acceptedProducts() {
    for (let index = 0; index < 400; index++) {
      examined++;
      yield { ...event, ordinal: String(index) };
    }
  }
  assert.throws(() => packSourceChunk(current, acceptedProducts()), { code: "SOURCE_INPUT" });
  assert.ok(examined < 400);
});

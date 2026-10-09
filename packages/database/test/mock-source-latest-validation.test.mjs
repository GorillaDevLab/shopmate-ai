import assert from "node:assert/strict";
import test from "node:test";
import { validateLatestInput } from "../dist/src/mock-platform/latest-validation.js";
import { validateDataBounds } from "../dist/src/mock-platform/record-bounds.js";

const input = { until: "2026-01-01T00:00:00.000Z", limit: 1, kind: "PRODUCT" };

test("latest structured keys reject malformed or mismatched tuples before database access", () => {
  for (const entityKey of [
    null,
    {},
    [],
    ["PRODUCT"],
    ["PRODUCT", "x", "extra"],
    ["ORDER", "x"],
    ["PRODUCT", ""],
    ["PRODUCT", " x"],
    ["PRODUCT", "x\u0000"],
    ["PRODUCT", "x".repeat(257)],
    ["PRODUCT", 42],
  ])
    assert.throws(() => validateLatestInput({ ...input, entityKey }), { code: "SOURCE_INPUT" });
  for (const changed of [
    { kind: undefined, entityKey: ["PRODUCT", "x"] },
    { kind: "INVENTORY", entityKey: ["INVENTORY", "sku"] },
    { kind: "INVENTORY", entityKey: ["INVENTORY", "sku", "loc\u0000"] },
    { kind: "MARKETING", entityKey: ["MARKETING", "campaign", "2025-02-30"] },
  ])
    assert.throws(() => validateLatestInput({ ...input, ...changed }), { code: "SOURCE_INPUT" });
});

test("query identities retain contract bounds including literal lone surrogates", () => {
  for (const id of ["x".repeat(256), "界".repeat(256), "\ud800", "\udfff"])
    assert.doesNotThrow(() => validateLatestInput({ ...input, entityKey: ["PRODUCT", id] }));
});

test("query JSON mode counts surrogate escapes and leaves record and property keys strict", () => {
  assert.doesNotThrow(() => validateDataBounds("\ud800", 8, 1, 0, "query-json"));
  assert.throws(() => validateDataBounds("\ud800", 7, 1, 0, "query-json"), {
    code: "SOURCE_INPUT",
  });
  assert.throws(() => validateDataBounds("\ud800", 8), { code: "SOURCE_INPUT" });
  assert.throws(() => validateDataBounds({ "\ud800": "x" }, 100, 10, 2, "query-json"), {
    code: "SOURCE_INPUT",
  });
  const cyclic = {};
  cyclic.self = cyclic;
  const proxy = new Proxy(
    {},
    {
      get() {
        throw new Error("must not invoke proxy");
      },
    },
  );
  for (const entityKey of [cyclic, proxy, ["PRODUCT", "x".repeat(8192)]])
    assert.throws(() => validateLatestInput({ ...input, entityKey }), { code: "SOURCE_INPUT" });
});

test("latest exact keys accept validated tuples and retain raw database text compatibility", () => {
  const tuple = ["PRODUCT", 'quoted/"中文'];
  for (const entityKey of [tuple, JSON.stringify(tuple)])
    assert.doesNotThrow(() => validateLatestInput({ ...input, entityKey }));
  assert.doesNotThrow(() =>
    validateLatestInput({
      ...input,
      kind: "MARKETING",
      entityKey: ["MARKETING", "campaign", "2024-02-29"],
    }),
  );
});

test("latest rejects hostile tuple serializers, array prototypes and accessors without invoking them", () => {
  let invoked = false;
  const serializer = ["PRODUCT", "x"];
  serializer.toJSON = () => {
    invoked = true;
    return ["PRODUCT", "other"];
  };
  const accessor = ["PRODUCT", "x"];
  Object.defineProperty(accessor, "1", {
    enumerable: true,
    get() {
      invoked = true;
      return "x";
    },
  });
  class CustomTuple extends Array {}
  for (const entityKey of [serializer, accessor, new CustomTuple("PRODUCT", "x")])
    assert.throws(() => validateLatestInput({ ...input, entityKey }), { code: "SOURCE_INPUT" });
  assert.equal(invoked, false);
});

test("the bounded request walk retains maximum legitimate cursor, raw key and pin inputs", () => {
  assert.doesNotThrow(() =>
    validateLatestInput({
      ...input,
      cursor: "a".repeat(4096),
      entityKey: "界".repeat(1024),
      contextHash: "a".repeat(64),
      publication: {
        revision: "9223372036854775807",
        highEventSeq: "9223372036854775807",
        certificateHash: "b".repeat(64),
      },
    }),
  );
});

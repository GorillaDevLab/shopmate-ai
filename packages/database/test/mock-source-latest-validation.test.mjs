import assert from "node:assert/strict";
import test from "node:test";
import { validateLatestInput } from "../dist/src/mock-platform/latest-validation.js";

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
    ["PRODUCT", "\ud800"],
    ["PRODUCT", "界".repeat(100)],
    ["PRODUCT", 42],
  ])
    assert.throws(() => validateLatestInput({ ...input, entityKey }), { code: "SOURCE_INPUT" });
  for (const changed of [
    { kind: undefined, entityKey: ["PRODUCT", "x"] },
    { kind: "INVENTORY", entityKey: ["INVENTORY", "sku"] },
    { kind: "INVENTORY", entityKey: ["INVENTORY", "sku", "loc\u0000"] },
    { kind: "MARKETING", entityKey: ["MARKETING", "campaign", "2025-02-30"] },
    { kind: "STORE", entityKey: ["STORE", "\ud800"] },
  ])
    assert.throws(() => validateLatestInput({ ...input, ...changed }), { code: "SOURCE_INPUT" });
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

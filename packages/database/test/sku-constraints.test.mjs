import assert from "node:assert/strict";
import test from "node:test";

import { validateSkuInventory } from "../src/sku-constraints.mjs";

test("accepts zero inventory and threshold", () => {
  assert.equal(
    validateSkuInventory({
      inventory: 0,
      alertThreshold: 0,
    }),
    true,
  );
});

test("accepts positive inventory and threshold", () => {
  assert.equal(
    validateSkuInventory({
      inventory: 100,
      alertThreshold: 10,
    }),
    true,
  );
});

test("rejects negative inventory", () => {
  assert.throws(
    () =>
      validateSkuInventory({
        inventory: -1,
        alertThreshold: 10,
      }),
    /inventory must be a non-negative integer/,
  );
});

test("rejects negative alert threshold", () => {
  assert.throws(
    () =>
      validateSkuInventory({
        inventory: 100,
        alertThreshold: -1,
      }),
    /alertThreshold must be a non-negative integer/,
  );
});

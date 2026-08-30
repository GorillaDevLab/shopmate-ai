import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldIncludeOrderInSales,
  validateOrderQuantity,
} from "../src/order-constraints.mjs";

test("accepts positive integer quantity", () => {
  assert.equal(validateOrderQuantity(1), true);
  assert.equal(validateOrderQuantity(10), true);
});

test("rejects zero quantity", () => {
  assert.throws(
    () => validateOrderQuantity(0),
    /quantity must be a positive integer/,
  );
});

test("rejects negative quantity", () => {
  assert.throws(
    () => validateOrderQuantity(-1),
    /quantity must be a positive integer/,
  );
});

test("rejects non-integer quantity", () => {
  assert.throws(
    () => validateOrderQuantity(1.5),
    /quantity must be a positive integer/,
  );
});

test("excludes cancelled orders from sales", () => {
  assert.equal(shouldIncludeOrderInSales("CANCELLED"), false);
});

test("includes non-cancelled orders in sales", () => {
  assert.equal(shouldIncludeOrderInSales("PAID"), true);
  assert.equal(shouldIncludeOrderInSales("PENDING"), true);
});

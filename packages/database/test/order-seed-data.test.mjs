import assert from "node:assert/strict";
import test from "node:test";

import { calculateEffectiveSales, demoOrders } from "../src/order-seed-data.ts";

function moneyToCents(value) {
  return Math.round(Number(value) * 100);
}

test("order seed covers exactly 30 calendar days", () => {
  assert.equal(demoOrders.length, 30);

  const dates = demoOrders.map((order) => order.orderedAt.slice(0, 10));

  assert.equal(new Set(dates).size, 30);
  assert.equal(dates[0], "2026-08-01");
  assert.equal(dates[29], "2026-08-30");
});

test("every order total equals the sum of its items", () => {
  for (const order of demoOrders) {
    const itemTotal = order.items.reduce((sum, item) => sum + moneyToCents(item.lineAmount), 0);

    assert.equal(
      moneyToCents(order.totalAmount),
      itemTotal,
      `${order.orderNo} total must equal item sum`,
    );
  }
});

test("every order item quantity is a positive integer", () => {
  for (const order of demoOrders) {
    for (const item of order.items) {
      assert.ok(Number.isInteger(item.quantity));
      assert.ok(item.quantity > 0);
    }
  }
});

test("cancelled orders exist in the fixed seed", () => {
  const cancelledOrders = demoOrders.filter((order) => order.status === "CANCELLED");

  assert.equal(cancelledOrders.length, 3);
});

test("cancelled orders are excluded from effective sales", () => {
  const allSales = demoOrders.reduce((sum, order) => sum + moneyToCents(order.totalAmount), 0);

  const effectiveSales = moneyToCents(calculateEffectiveSales(demoOrders));

  assert.ok(effectiveSales < allSales);

  const expectedEffectiveSales = demoOrders
    .filter((order) => order.status !== "CANCELLED")
    .reduce((sum, order) => sum + moneyToCents(order.totalAmount), 0);

  assert.equal(effectiveSales, expectedEffectiveSales);
});

test("first ten days contain an upward sales trend", () => {
  const firstTen = demoOrders.slice(0, 10);

  assert.ok(moneyToCents(firstTen[9].totalAmount) > moneyToCents(firstTen[0].totalAmount));
});

test("last ten days contain a downward sales trend", () => {
  const lastTen = demoOrders.slice(20, 30);

  assert.ok(moneyToCents(lastTen[0].totalAmount) > moneyToCents(lastTen[9].totalAmount));
});

test("middle ten days contain stable hot-selling samples", () => {
  const middleTen = demoOrders.slice(10, 20);

  for (const order of middleTen) {
    assert.equal(order.items[0].skuId, "demo-sku-001");
    assert.equal(order.items[0].quantity, 8);
  }
});

test("order business keys and item ids are stable and unique", () => {
  const orderNumbers = demoOrders.map((order) => order.orderNo);

  const itemIds = demoOrders.flatMap((order) => order.items.map((item) => item.id));

  assert.equal(new Set(orderNumbers).size, orderNumbers.length);

  assert.equal(new Set(itemIds).size, itemIds.length);
});

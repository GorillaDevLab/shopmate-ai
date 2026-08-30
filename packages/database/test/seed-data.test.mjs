import assert from "node:assert/strict";
import test from "node:test";

import {
  demoMerchant,
  demoProducts,
} from "../src/seed-data.ts";

test("demo merchant uses a stable business key", () => {
  assert.equal(demoMerchant.slug, "demo-shop-cn");
});

test("seed contains exactly ten Chinese products", () => {
  assert.equal(demoProducts.length, 10);

  for (const product of demoProducts) {
    assert.match(product.name, /[\u4e00-\u9fff]/);
  }
});

test("product ids and SKU codes are unique", () => {
  const productIds = demoProducts.map((product) => product.id);
  const skuCodes = demoProducts.map(
    (product) => product.sku.code,
  );

  assert.equal(
    new Set(productIds).size,
    demoProducts.length,
  );

  assert.equal(
    new Set(skuCodes).size,
    demoProducts.length,
  );
});

test("at least three SKUs have low-stock risk", () => {
  const lowStockProducts = demoProducts.filter(
    (product) =>
      product.sku.inventory <=
      product.sku.alertThreshold,
  );

  assert.ok(lowStockProducts.length >= 3);
});

test("seed products contain different price and cost levels", () => {
  const prices = new Set(
    demoProducts.map((product) => product.price),
  );

  const costs = new Set(
    demoProducts.map((product) => product.sku.cost),
  );

  assert.ok(prices.size > 1);
  assert.ok(costs.size > 1);
});

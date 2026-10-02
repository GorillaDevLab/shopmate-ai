import { describe, expect, it } from "vitest";
import { parseConnectorVerification } from "./connector-validation.js";

const time = "2026-10-03T08:00:00Z";
const query = {
  executionId: "execution-a",
  expected: {
    kind: "PRICE",
    externalSkuId: "sku-a",
    priceMinor: 6000,
    currency: "CNY",
  },
};
const snapshot = {
  kind: "PRICE",
  externalStoreId: "store-a",
  externalSkuId: "sku-a",
  expectedPriceMinor: 6000,
  actualPriceMinor: 6000,
  currency: "CNY",
  version: "v2",
  observedAt: time,
};
const verified = { status: "VERIFIED", executionId: "execution-a", snapshot };
const failure = (code: string) => ({ ok: false, error: { code, retryAfterMs: null } });
const listing = {
  title: "合成商品",
  description: "合成说明",
  category: "家居",
  brand: null,
  skus: [{ sellerSkuCode: "a", attributes: [], salePriceMinor: 6000, currency: "CNY" }],
};

describe("query-bound verification responses", () => {
  it("accepts only a response for the requested store and expected target", () => {
    expect(parseConnectorVerification("store-a", query, verified)).toEqual({
      ok: true,
      data: verified,
    });
  });
  it.each([
    { externalStoreId: "store-b" },
    { externalSkuId: "sku-b" },
    { expectedPriceMinor: 1, actualPriceMinor: 1 },
  ])("rejects valid but unrelated snapshot %j", (changes) => {
    expect(
      parseConnectorVerification("store-a", query, {
        status: "VERIFIED",
        executionId: "execution-a",
        snapshot: { ...snapshot, ...changes },
      }),
    ).toEqual(failure("INVALID_RESPONSE"));
  });
  it("accepts an honest mismatch for the bound expectation", () => {
    const payload = {
      status: "MISMATCH",
      executionId: "execution-a",
      snapshot: { ...snapshot, actualPriceMinor: 5900 },
    };
    expect(parseConnectorVerification("store-a", query, payload)).toEqual({
      ok: true,
      data: payload,
    });
  });
  it("validates unknown query/scope and rejects extra response fields", () => {
    expect(parseConnectorVerification("", query, verified)).toEqual(failure("INVALID_INPUT"));
    expect(parseConnectorVerification("store-a", { ...query, token: "secret" }, verified)).toEqual(
      failure("INVALID_INPUT"),
    );
    expect(parseConnectorVerification("store-a", query, { ...verified, token: "secret" })).toEqual(
      failure("INVALID_RESPONSE"),
    );
  });
  it("rejects stale execution identities for every verification status", () => {
    for (const payload of [
      verified,
      { status: "PENDING", executionId: "execution-a", retryAfterMs: 1000 },
      { status: "UNAVAILABLE", executionId: "execution-a", reason: "TIMEOUT" },
    ])
      expect(
        parseConnectorVerification("store-a", query, {
          ...payload,
          executionId: "execution-b",
        }),
      ).toEqual(failure("INVALID_RESPONSE"));
  });
  it("preserves pending and unavailable states", () => {
    for (const payload of [
      { status: "PENDING", executionId: "execution-a", retryAfterMs: 1000 },
      { status: "UNAVAILABLE", executionId: "execution-a", reason: "TIMEOUT" },
    ])
      expect(parseConnectorVerification("store-a", query, payload)).toEqual({
        ok: true,
        data: payload,
      });
  });
  it("binds inventory kind, warehouse and expected quantity", () => {
    const inventoryQuery = {
      executionId: "execution-a",
      expected: {
        kind: "INVENTORY",
        externalSkuId: "sku-a",
        externalLocationId: "location-a",
        available: 10,
      },
    };
    const inventorySnapshot = {
      kind: "INVENTORY",
      externalStoreId: "store-a",
      externalSkuId: "sku-a",
      externalLocationId: "location-a",
      expectedAvailable: 10,
      actualAvailable: 10,
      version: "v2",
      observedAt: time,
    };
    expect(
      parseConnectorVerification("store-a", inventoryQuery, {
        status: "VERIFIED",
        executionId: "execution-a",
        snapshot: inventorySnapshot,
      }).ok,
    ).toBe(true);
    expect(parseConnectorVerification("store-a", inventoryQuery, verified)).toEqual(
      failure("INVALID_RESPONSE"),
    );
    for (const changes of [
      { externalLocationId: "location-b" },
      { expectedAvailable: 1, actualAvailable: 1 },
    ])
      expect(
        parseConnectorVerification("store-a", inventoryQuery, {
          status: "VERIFIED",
          executionId: "execution-a",
          snapshot: { ...inventorySnapshot, ...changes },
        }),
      ).toEqual(failure("INVALID_RESPONSE"));
  });
  it("binds product identity and complete listing expectation", () => {
    const productQuery = {
      executionId: "execution-a",
      expected: { kind: "PRODUCT", externalProductId: "product-a", listing },
    };
    const productSnapshot = {
      kind: "PRODUCT",
      externalStoreId: "store-a",
      externalProductId: "product-a",
      expectedListing: listing,
      actualListing: listing,
      version: "v2",
      observedAt: time,
    };
    expect(
      parseConnectorVerification("store-a", productQuery, {
        status: "VERIFIED",
        executionId: "execution-a",
        snapshot: productSnapshot,
      }).ok,
    ).toBe(true);
    for (const changes of [
      { externalProductId: "product-b" },
      {
        expectedListing: { ...listing, title: "另一商品" },
        actualListing: { ...listing, title: "另一商品" },
      },
    ])
      expect(
        parseConnectorVerification("store-a", productQuery, {
          status: "VERIFIED",
          executionId: "execution-a",
          snapshot: { ...productSnapshot, ...changes },
        }),
      ).toEqual(failure("INVALID_RESPONSE"));
  });
});

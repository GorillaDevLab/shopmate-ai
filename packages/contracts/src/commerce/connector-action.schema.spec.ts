import { describe, expect, it } from "vitest";
import * as schema from "./connector-action.schema.js";

const time = "2026-10-03T00:00:00Z";
const command = {
  executionId: "execution-a",
  idempotencyKey: "idempotency-a",
  externalSkuId: "sku-a",
  expectedVersion: "v1",
  oldPriceMinor: 5900,
  newPriceMinor: 6000,
  currency: "CNY",
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
const listing = {
  title: "手机支架",
  description: "合成商品",
  category: "3C",
  brand: null,
  skus: [
    {
      sellerSkuCode: "seller-a",
      attributes: [{ name: "颜色", value: "黑色" }],
      salePriceMinor: 5900,
      currency: "CNY",
    },
  ],
};
describe("connector action protocols", () => {
  it("requires fixed execution, idempotency and optimistic preconditions", () => {
    expect(schema.SetPriceCommandSchema.parse(command).newPriceMinor).toBe(6000);
    const { expectedVersion: _version, ...missing } = command;
    void _version;
    expect(schema.SetPriceCommandSchema.safeParse(missing).success).toBe(false);
  });
  it.each([
    { newPriceMinor: 59.5 },
    { newPriceMinor: -1 },
    { currency: "USD" },
    { organizationId: "foreign" },
    { approval: true },
    { token: "private" },
  ])("rejects unsafe price command %o", (changes) => {
    expect(schema.SetPriceCommandSchema.safeParse({ ...command, ...changes }).success).toBe(false);
  });
  it("models inventory as an absolute target and rejects relative increments", () => {
    const inventory = {
      executionId: "execution-a",
      idempotencyKey: "idempotency-a",
      externalSkuId: "sku-a",
      externalLocationId: "location-a",
      expectedVersion: "v1",
      oldAvailable: 10,
      targetAvailable: 20,
    };
    expect(schema.SetInventoryCommandSchema.parse(inventory).targetAvailable).toBe(20);
    expect(
      schema.SetInventoryCommandSchema.safeParse({ ...inventory, increment: 100 }).success,
    ).toBe(false);
    expect(
      schema.SetInventoryCommandSchema.safeParse({ ...inventory, targetAvailable: -1 }).success,
    ).toBe(false);
  });
  it("validates listing variants and does not allow duplicate seller sku codes", () => {
    expect(
      schema.CreateProductCommandSchema.parse({
        executionId: "execution-a",
        idempotencyKey: "idem-a",
        listing,
      }).listing.title,
    ).toBe("手机支架");
    expect(
      schema.ListingInputSchema.safeParse({ ...listing, skus: [listing.skus[0], listing.skus[0]] })
        .success,
    ).toBe(false);
    expect(
      schema.UpdateProductCommandSchema.safeParse({
        executionId: "execution-a",
        idempotencyKey: "idem-a",
        externalProductId: "product-a",
        listing,
      }).success,
    ).toBe(false);
  });
  it("keeps accepted, rejected and unknown writes distinct", () => {
    const receipt = { executionId: "execution-a", platformRequestId: null, receivedAt: time };
    expect(
      schema.WriteReceiptSchema.parse({ ...receipt, outcome: "UNKNOWN", failureCode: "TIMEOUT" })
        .outcome,
    ).toBe("UNKNOWN");
    expect(
      schema.WriteReceiptSchema.parse({
        ...receipt,
        outcome: "REJECTED",
        failureCode: "UNSUPPORTED",
      }).outcome,
    ).toBe("REJECTED");
    expect(
      schema.WriteReceiptSchema.safeParse({
        ...receipt,
        outcome: "ACCEPTED",
        failureCode: "TIMEOUT",
      }).success,
    ).toBe(false);
    expect(
      schema.WriteReceiptSchema.safeParse({ ...receipt, outcome: "UNKNOWN", failureCode: null })
        .success,
    ).toBe(false);
    expect(
      schema.WriteReceiptSchema.safeParse({
        ...receipt,
        outcome: "ACCEPTED",
        failureCode: null,
        verified: true,
      }).success,
    ).toBe(false);
  });
  it("requires an independent expected-state verification query", () => {
    expect(
      schema.VerifyActionQuerySchema.safeParse({
        executionId: "execution-a",
        expected: { kind: "PRICE", externalSkuId: "sku-a", priceMinor: 6000, currency: "CNY" },
      }).success,
    ).toBe(true);
    expect(schema.VerifyActionQuerySchema.safeParse({ executionId: "execution-a" }).success).toBe(
      false,
    );
  });
  it("does not let a VERIFIED label hide a price mismatch", () => {
    expect(schema.VerificationResultSchema.parse({ status: "VERIFIED", snapshot }).status).toBe(
      "VERIFIED",
    );
    expect(
      schema.VerificationResultSchema.safeParse({
        status: "VERIFIED",
        snapshot: { ...snapshot, actualPriceMinor: 5900 },
      }).success,
    ).toBe(false);
    expect(
      schema.VerificationResultSchema.safeParse({ status: "MISMATCH", snapshot }).success,
    ).toBe(false);
    expect(
      schema.VerificationResultSchema.parse({
        status: "MISMATCH",
        snapshot: { ...snapshot, actualPriceMinor: 5900 },
      }).status,
    ).toBe("MISMATCH");
  });
  it("freezes the nested expected target before asynchronous verification", () => {
    const parsed = schema.VerifyActionQuerySchema.parse({
      executionId: "execution-a",
      expected: { kind: "PRICE", externalSkuId: "sku-a", priceMinor: 6000, currency: "CNY" },
    });
    expect(Object.isFrozen(parsed.expected)).toBe(true);
    expect(Reflect.set(parsed.expected, "priceMinor", 1)).toBe(false);
  });
  it("requires real pending delay and distinguishes unavailable verification", () => {
    expect(
      schema.VerificationResultSchema.safeParse({ status: "PENDING", retryAfterMs: 0 }).success,
    ).toBe(false);
    expect(
      schema.VerificationResultSchema.parse({ status: "UNAVAILABLE", reason: "TEMPORARY" }).status,
    ).toBe("UNAVAILABLE");
  });
  it("compares product state independent of returned sku and attribute ordering", () => {
    const expectedListing = {
      ...listing,
      skus: [...listing.skus, { ...listing.skus[0], sellerSkuCode: "seller-b" }],
    };
    const actualListing = { ...expectedListing, skus: [...expectedListing.skus].reverse() };
    expect(
      schema.VerificationResultSchema.safeParse({
        status: "VERIFIED",
        snapshot: {
          kind: "PRODUCT",
          externalStoreId: "store-a",
          externalProductId: "product-a",
          expectedListing,
          actualListing,
          version: "v2",
          observedAt: time,
        },
      }).success,
    ).toBe(true);
  });
});

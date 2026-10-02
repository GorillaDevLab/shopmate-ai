import { describe, expect, it } from "vitest";
import { ConnectorStoreSchema } from "./connector-data.schema.js";
import { parseConnectorPage, parseConnectorRead } from "./connector-validation.js";

const until = "2026-10-03T08:00:00Z";
const store = {
  externalStoreId: "store-a",
  name: "演示店铺",
  category: "家居",
  currency: "CNY",
  timeZone: "Asia/Shanghai",
  source: {
    version: "v1",
    updatedAt: until,
    quality: { state: "COMPLETE", issues: [] },
  },
};
const query = { until, limit: 2 };
const page = { items: [store], nextCursor: null, observedAt: until, sourceWatermark: until };
const failure = (code: string) => ({ ok: false, error: { code, retryAfterMs: null } });

describe("scoped connector reads", () => {
  it("parses and freezes a valid response", () => {
    const result = parseConnectorRead(ConnectorStoreSchema, "store-a", store);
    expect(result).toEqual({ ok: true, data: store });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.ok) expect(Object.isFrozen(result.data)).toBe(true);
  });
  it.each([null, "", 123, "store\n"])("rejects invalid trusted scope %j", (scope) => {
    expect(parseConnectorRead(ConnectorStoreSchema, scope, store)).toEqual(
      failure("INVALID_INPUT"),
    );
  });
  it("rejects a different store", () => {
    expect(parseConnectorRead(ConnectorStoreSchema, "store-b", store)).toEqual(
      failure("INVALID_RESPONSE"),
    );
  });
  it("never returns malformed provider data or sensitive validation details", () => {
    const result = parseConnectorRead(ConnectorStoreSchema, "store-a", {
      ...store,
      accessToken: "private-provider-token",
      buyerPhone: "synthetic-phone",
    });
    expect(result).toEqual(failure("INVALID_RESPONSE"));
    expect(JSON.stringify(result)).not.toMatch(/private|synthetic|accessToken|buyerPhone/);
  });
});

describe("scoped connector pages", () => {
  it("accepts a valid page and a distinct next cursor", () => {
    expect(parseConnectorPage(ConnectorStoreSchema, "store-a", query, page)).toEqual({
      ok: true,
      data: page,
    });
    expect(
      parseConnectorPage(
        ConnectorStoreSchema,
        "store-a",
        { ...query, cursor: "a" },
        {
          ...page,
          nextCursor: "b",
        },
      ).ok,
    ).toBe(true);
  });
  it("accepts an empty successful page with an unknown watermark", () => {
    const empty = { ...page, items: [], sourceWatermark: null };
    expect(parseConnectorPage(ConnectorStoreSchema, "store-a", query, empty)).toEqual({
      ok: true,
      data: empty,
    });
  });
  it.each([
    { ...query, limit: 0 },
    { ...query, until: "invalid" },
    { ...query, since: "2026-10-04T00:00:00Z" },
    { ...query, organizationId: "override" },
  ])("rejects invalid query %j", (input) => {
    expect(parseConnectorPage(ConnectorStoreSchema, "store-a", input, page)).toEqual(
      failure("INVALID_INPUT"),
    );
  });
  it("supports strict inventory and marketing queries", () => {
    for (const input of [
      { ...query, externalSkuIds: ["sku-a"] },
      { ...query, since: "2026-10-02T08:00:00Z" },
    ])
      expect(parseConnectorPage(ConnectorStoreSchema, "store-a", input, page).ok).toBe(true);
  });
  it("rejects an invalid store even for an empty page", () => {
    expect(parseConnectorPage(ConnectorStoreSchema, "", query, { ...page, items: [] })).toEqual(
      failure("INVALID_INPUT"),
    );
  });
  it("rejects one foreign entity among otherwise valid items", () => {
    expect(
      parseConnectorPage(ConnectorStoreSchema, "store-a", query, {
        ...page,
        items: [store, { ...store, externalStoreId: "store-b" }],
      }),
    ).toEqual(failure("INVALID_RESPONSE"));
  });
  it("rejects more items than requested", () => {
    expect(
      parseConnectorPage(
        ConnectorStoreSchema,
        "store-a",
        { ...query, limit: 1 },
        {
          ...page,
          items: [store, store],
        },
      ),
    ).toEqual(failure("INVALID_RESPONSE"));
  });
  it("rejects a stalled cursor", () => {
    expect(
      parseConnectorPage(
        ConnectorStoreSchema,
        "store-a",
        { ...query, cursor: "same" },
        {
          ...page,
          nextCursor: "same",
        },
      ),
    ).toEqual(failure("INVALID_RESPONSE"));
  });
  it("rejects a watermark later than cutoff", () => {
    expect(
      parseConnectorPage(ConnectorStoreSchema, "store-a", query, {
        ...page,
        sourceWatermark: "2026-10-03T08:00:01Z",
      }),
    ).toEqual(failure("INVALID_RESPONSE"));
  });
  it("rejects a future item even when the watermark looks valid", () => {
    expect(
      parseConnectorPage(ConnectorStoreSchema, "store-a", query, {
        ...page,
        items: [{ ...store, source: { ...store.source, updatedAt: "2026-10-04T08:00:00Z" } }],
      }),
    ).toEqual(failure("INVALID_RESPONSE"));
  });
  it("rejects records and watermarks newer than the page observation", () => {
    const earlier = "2026-10-02T08:00:00Z";
    expect(
      parseConnectorPage(ConnectorStoreSchema, "store-a", query, {
        ...page,
        observedAt: earlier,
        sourceWatermark: null,
      }),
    ).toEqual(failure("INVALID_RESPONSE"));
    expect(
      parseConnectorPage(ConnectorStoreSchema, "store-a", query, {
        ...page,
        items: [],
        observedAt: earlier,
      }),
    ).toEqual(failure("INVALID_RESPONSE"));
  });
  it("compares watermark instants across timezone offsets", () => {
    expect(
      parseConnectorPage(ConnectorStoreSchema, "store-a", query, {
        ...page,
        sourceWatermark: "2026-10-03T16:00:00+08:00",
      }).ok,
    ).toBe(true);
  });
  it("rejects unexpected page fields without leaking them", () => {
    const result = parseConnectorPage(ConnectorStoreSchema, "store-a", query, {
      ...page,
      providerMessage: "confidential",
    });
    expect(result).toEqual(failure("INVALID_RESPONSE"));
    expect(JSON.stringify(result)).not.toContain("confidential");
  });
});

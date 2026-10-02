import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as contract from "./connector-common.schema.js";

const query = { until: "2026-10-03T00:00:00Z", limit: 50 };
describe("connector common protocols", () => {
  it.each([0, 59_00, Number.MAX_SAFE_INTEGER])("preserves integer minor amounts %s", (value) => {
    expect(contract.MinorAmountSchema.parse(value)).toBe(value);
  });
  it.each([-1, 1.2, Number.MAX_SAFE_INTEGER + 1, Infinity, "5900"])(
    "rejects invalid amount %s",
    (value) => {
      expect(contract.MinorAmountSchema.safeParse(value).success).toBe(false);
    },
  );
  it("keeps external 64-bit identifiers as opaque strings", () => {
    expect(contract.ExternalIdSchema.parse("9223372036854775807")).toBe("9223372036854775807");
  });
  it.each(["", " id", "id\n", "a".repeat(257), 123])("rejects invalid external id %s", (value) => {
    expect(contract.ExternalIdSchema.safeParse(value).success).toBe(false);
  });
  it("binds only identifiers and rejects credentials or scope overrides", () => {
    const binding = {
      organizationId: "org-a",
      workspaceId: "workspace-a",
      storeId: "store-a",
      connectionId: "connection-a",
      externalStoreId: "external-a",
    };
    expect(Object.isFrozen(contract.ConnectorBindingSchema.parse(binding))).toBe(true);
    expect(
      contract.ConnectorBindingSchema.safeParse({ ...binding, token: "private" }).success,
    ).toBe(false);
    expect(
      contract.SyncPageQuerySchema.safeParse({ ...query, organizationId: "foreign" }).success,
    ).toBe(false);
  });
  it("requires call identity and an ISO deadline, keeping signal outside JSON", () => {
    expect(
      contract.ReadOptionsSchema.safeParse({ requestId: "request-a", deadlineAt: query.until })
        .success,
    ).toBe(true);
    expect(contract.ReadOptionsSchema.safeParse({ requestId: "request-a" }).success).toBe(false);
    expect(
      contract.ReadOptionsSchema.safeParse({
        requestId: "request-a",
        deadlineAt: query.until,
        signal: {},
      }).success,
    ).toBe(false);
  });
  it.each([
    { limit: 0 },
    { limit: 201 },
    { limit: 1.5 },
    { since: "2026-10-04T00:00:00Z" },
    { until: "2026-02-30T00:00:00Z" },
  ])("rejects invalid pagination/window %o", (changes) => {
    expect(contract.SyncPageQuerySchema.safeParse({ ...query, ...changes }).success).toBe(false);
  });
  it("compares time instants rather than timestamp spelling", () => {
    expect(
      contract.SyncPageQuerySchema.safeParse({ ...query, since: "2026-10-03T08:00:00+08:00" })
        .success,
    ).toBe(true);
  });
  it("rejects duplicate inventory SKU selections and missing marketing period", () => {
    expect(
      contract.InventoryQuerySchema.safeParse({ ...query, externalSkuIds: ["sku-a", "sku-a"] })
        .success,
    ).toBe(false);
    expect(contract.MarketingQuerySchema.safeParse(query).success).toBe(false);
  });
  it("models unsupported reads as a distinct failure rather than an empty page", () => {
    const schema = contract.ConnectorResultSchema(z.number());
    expect(schema.parse({ ok: false, error: { code: "UNSUPPORTED", retryAfterMs: null } }).ok).toBe(
      false,
    );
    expect(
      schema.safeParse({
        ok: false,
        error: { code: "UNSUPPORTED", retryAfterMs: null, message: "customer email" },
      }).success,
    ).toBe(false);
  });
  it("limits pages and rejects unbounded provider payloads", () => {
    const page = { items: [], nextCursor: null, observedAt: query.until, sourceWatermark: null };
    expect(contract.ConnectorPageSchema(z.string()).parse(page).items).toEqual([]);
    expect(
      contract.ConnectorPageSchema(z.string()).safeParse({ ...page, items: Array(201).fill("x") })
        .success,
    ).toBe(false);
  });
});

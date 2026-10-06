import type { CommerceConnector } from "@shopmate/contracts";
import { describe, expect, it, vi } from "vitest";
import { fetchSyncPage, SyncPageInputError } from "./fetch-page.js";

const until = "2026-10-03T00:00:00.000Z";
const request = { stream: "PRODUCTS", since: "2026-10-02T00:00:00.000Z", until, limit: 10 };
const options = { requestId: "sync-request-1", deadlineAt: "2099-01-01T00:00:00.000Z" };
const product = {
  externalStoreId: "store-a",
  externalProductId: "product-a",
  title: "数据线",
  description: null,
  category: "3C配件",
  brand: null,
  status: "ACTIVE",
  skus: [
    {
      externalSkuId: "sku-a",
      externalProductId: "product-a",
      attributes: [],
      salePriceMinor: 100,
      costPriceMinor: 50,
      originalPriceMinor: null,
      status: "ACTIVE",
    },
  ],
  source: { version: "v1", updatedAt: until, quality: { state: "COMPLETE", issues: [] } },
};
const page = { items: [product], nextCursor: null, observedAt: until, sourceWatermark: until };

function connector(result: unknown) {
  const listProducts = vi.fn().mockResolvedValue(result);
  return {
    listProducts,
    binding: {
      organizationId: "org-a",
      workspaceId: "workspace-a",
      storeId: "store-a",
      connectionId: "connection-a",
      externalStoreId: "store-a",
    },
  } as unknown as CommerceConnector;
}

describe("fixed-window sync pages", () => {
  it("accepts a validated, fully covered final page", async () => {
    const source = connector({ ok: true, data: page });
    const result = await fetchSyncPage(source, request, options);
    expect(result).toMatchObject({ status: "COMPLETE", page });
    expect(source.listProducts).toHaveBeenCalledWith(
      { since: request.since, until, limit: 10 },
      expect.objectContaining({ ...options, signal: expect.any(AbortSignal) }),
    );
  });

  it("keeps an empty final page partial when the source watermark is missing", async () => {
    const source = connector({ ok: true, data: { ...page, items: [], sourceWatermark: null } });
    expect(await fetchSyncPage(source, request, options)).toMatchObject({ status: "PARTIAL" });
  });

  it("keeps a nonterminal cursor open even when the watermark covers the window", async () => {
    const source = connector({ ok: true, data: { ...page, nextCursor: "next-page" } });
    expect(await fetchSyncPage(source, request, options)).toMatchObject({ status: "PAGE" });
  });

  it.each([
    ["ORDERS", "listOrders"],
    ["REFUNDS", "listRefunds"],
    ["INVENTORY", "getInventory"],
    ["MARKETING", "getMarketingMetrics"],
  ] as const)("routes %s through the matching connector method", async (stream, method) => {
    const source = connector({ ok: false, error: { code: "RATE_LIMIT", retryAfterMs: null } });
    const read = vi
      .fn()
      .mockResolvedValue({ ok: false, error: { code: "RATE_LIMIT", retryAfterMs: null } });
    Object.assign(source, { [method]: read });
    expect(await fetchSyncPage(source, { ...request, stream }, options)).toMatchObject({
      status: "FAILED",
      code: "RATE_LIMIT",
    });
    expect(read).toHaveBeenCalledWith(
      stream === "INVENTORY" ? { until, limit: 10 } : { since: request.since, until, limit: 10 },
      expect.objectContaining({ ...options, signal: expect.any(AbortSignal) }),
    );
  });

  it("rejects cross-store and future rows from an untrusted adapter", async () => {
    const foreign = connector({
      ok: true,
      data: { ...page, items: [{ ...product, externalStoreId: "store-b" }] },
    });
    expect(await fetchSyncPage(foreign, request, options)).toEqual({
      status: "FAILED",
      code: "INVALID_RESPONSE",
    });
    const future = connector({
      ok: true,
      data: {
        ...page,
        items: [
          { ...product, source: { ...product.source, updatedAt: "2026-10-04T00:00:00.000Z" } },
        ],
      },
    });
    expect(await fetchSyncPage(future, request, options)).toEqual({
      status: "FAILED",
      code: "INVALID_RESPONSE",
    });
  });

  it("preserves a validated rate-limit response for bounded retry", async () => {
    const source = connector({ ok: false, error: { code: "RATE_LIMIT", retryAfterMs: 1000 } });
    expect(await fetchSyncPage(source, request, options)).toEqual({
      status: "FAILED",
      code: "RATE_LIMIT",
      retryAfterMs: 1000,
    });
  });

  it("rejects malformed input before calling the connector", async () => {
    const source = connector({ ok: true, data: page });
    await expect(fetchSyncPage(source, { ...request, limit: 1000 }, options)).rejects.toThrow(
      SyncPageInputError,
    );
    expect(source.listProducts).not.toHaveBeenCalled();
  });

  it("accepts native cancellation and prevents the adapter call when already aborted", async () => {
    const source = connector({ ok: true, data: page });
    const active = new AbortController();
    expect(
      await fetchSyncPage(source, request, { ...options, signal: active.signal }),
    ).toMatchObject({ status: "COMPLETE" });
    active.abort();
    expect(await fetchSyncPage(source, request, { ...options, signal: active.signal })).toEqual({
      status: "FAILED",
      code: "ABORTED",
    });
    expect(source.listProducts).toHaveBeenCalledTimes(1);
  });

  it("ends a pending adapter read at the real deadline", async () => {
    const source = connector(null);
    vi.mocked(source.listProducts).mockImplementation(() => new Promise(() => {}));
    const deadlineAt = new Date(Date.now() + 40).toISOString();
    await expect(fetchSyncPage(source, request, { ...options, deadlineAt })).resolves.toEqual({
      status: "FAILED",
      code: "TIMEOUT",
    });
  }, 1000);

  it("ends a pending adapter read when the caller aborts", async () => {
    const source = connector(null);
    vi.mocked(source.listProducts).mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = fetchSyncPage(source, request, { ...options, signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toEqual({ status: "FAILED", code: "ABORTED" });
  }, 1000);
});

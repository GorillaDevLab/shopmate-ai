import { DEFAULT_DASHBOARD_LAYOUT } from "@shopmate/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DashboardLayoutApiError,
  fetchDashboardLayout,
  saveDashboardLayout,
} from "./dashboard-layout-api";

describe("dashboard layout API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("读取当前登录用户的布局", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(defaultResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDashboardLayout()).resolves.toEqual(defaultResponse());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/dashboard/layout",
      expect.objectContaining({ credentials: "include", cache: "no-store" }),
    );
  });

  it("携带预期版本保存通过校验的草稿", async () => {
    const response = {
      layout: DEFAULT_DASHBOARD_LAYOUT,
      revision: 1,
      updatedAt: "2026-09-02T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async () => jsonResponse(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      saveDashboardLayout({ layout: DEFAULT_DASHBOARD_LAYOUT, expectedRevision: 0 }),
    ).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/dashboard/layout",
      expect.objectContaining({
        method: "PUT",
        credentials: "include",
        body: JSON.stringify({ layout: DEFAULT_DASHBOARD_LAYOUT, expectedRevision: 0 }),
      }),
    );
  });

  it("拒绝被污染的响应", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ revision: 0 })),
    );
    await expect(fetchDashboardLayout()).rejects.toMatchObject({ status: 502 });
  });

  it("拒绝发送不符合共享 Schema 的布局", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const invalid = {
      layout: { ...DEFAULT_DASHBOARD_LAYOUT, cards: [{ id: "bad id" }] },
      expectedRevision: 0,
    };

    await expect(saveDashboardLayout(invalid as never)).rejects.toMatchObject({
      status: 400,
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("将并发冲突映射为可重试中文错误且不泄漏内部详情", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "raw database detail" }, 409)),
    );

    const error = await saveDashboardLayout({
      layout: DEFAULT_DASHBOARD_LAYOUT,
      expectedRevision: 0,
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(DashboardLayoutApiError);
    expect(error).toMatchObject({
      status: 409,
      retryable: true,
      message: "布局已在其他设备更新，你的草稿仍然保留",
    });
  });

  it("区分登录失效与网络错误", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await expect(fetchDashboardLayout()).rejects.toMatchObject({
      status: 401,
      retryable: false,
      message: "登录已失效，请重新登录",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    );
    await expect(fetchDashboardLayout()).rejects.toMatchObject({
      status: 0,
      retryable: true,
      message: "无法连接布局服务，请检查网络后重试",
    });
  });
});

function defaultResponse() {
  return { layout: DEFAULT_DASHBOARD_LAYOUT, revision: 0 as const, updatedAt: null };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

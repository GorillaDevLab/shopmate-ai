import { afterEach, describe, expect, it, vi } from "vitest";

import { dashboardResponsePreview } from "./dashboard-data";
import { DashboardApiError, fetchDashboard } from "./dashboard-api";

describe("Dashboard API 客户端", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("携带会话并用共享 Schema 校验响应", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(dashboardResponsePreview));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDashboard("2026-08-31")).resolves.toEqual(dashboardResponsePreview);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/analytics/dashboard?asOfDate=2026-08-31",
      expect.objectContaining({ credentials: "include", cache: "no-store" }),
    );
  });

  it("拒绝字段缺失或被污染的响应", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ...dashboardResponsePreview, metrics: [] })),
    );
    await expect(fetchDashboard("2026-08-31")).rejects.toMatchObject({
      name: "DashboardApiError",
      status: 502,
    });
  });

  it("不向界面透传服务端内部错误详情", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "database password leaked" }, 503)),
    );
    const error = await fetchDashboard("2026-08-31").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(DashboardApiError);
    expect(error).toMatchObject({ status: 503, message: "经营数据暂时不可用，请稍后重试" });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

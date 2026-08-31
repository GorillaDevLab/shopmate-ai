import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardResponsePreview } from "./dashboard-data";

const api = vi.hoisted(() => ({ fetchDashboard: vi.fn() }));
vi.mock("./dashboard-api", () => ({
  fetchDashboard: api.fetchDashboard,
  isAbortError: (error: unknown) => error instanceof DOMException && error.name === "AbortError",
}));

import { DashboardClient } from "./dashboard-client";

describe("DashboardClient", () => {
  beforeEach(() => vi.clearAllMocks());

  it("加载真实 API 响应并展示相同指标", async () => {
    api.fetchDashboard.mockResolvedValue(dashboardResponsePreview);
    render(<DashboardClient asOfDate="2026-08-31" />);

    expect(screen.getByText("正在整理你的经营数据…")).toBeInTheDocument();
    expect(
      within(await screen.findByRole("article", { name: "近 7 天销售额" })).getByText("¥12,680.00"),
    ).toBeInTheDocument();
    expect(screen.getByText("数据来自 Analytics API")).toBeInTheDocument();
  });

  it("失败后点击重新加载会发起新请求", async () => {
    api.fetchDashboard
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(dashboardResponsePreview);
    render(<DashboardClient asOfDate="2026-08-31" />);

    fireEvent.click(await screen.findByRole("button", { name: "重新加载" }));
    expect(
      within(await screen.findByRole("article", { name: "近 7 天销售额" })).getByText("¥12,680.00"),
    ).toBeInTheDocument();
    expect(api.fetchDashboard).toHaveBeenCalledTimes(2);
  });

  it("较旧请求晚返回时不会覆盖较新的结果", async () => {
    const first = deferred<typeof dashboardResponsePreview>();
    const second = deferred<typeof dashboardResponsePreview>();
    api.fetchDashboard.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender } = render(<DashboardClient asOfDate="2026-08-30" />);

    rerender(<DashboardClient asOfDate="2026-08-31" />);
    second.resolve(dashboardResponsePreview);
    expect(
      within(await screen.findByRole("article", { name: "近 7 天销售额" })).getByText("¥12,680.00"),
    ).toBeInTheDocument();

    first.resolve({
      ...dashboardResponsePreview,
      asOfDate: "2026-08-30",
      metrics: dashboardResponsePreview.metrics.map((metric) =>
        metric.key === "sales" ? { ...metric, value: 1 } : metric,
      ),
    });
    await waitFor(() => expect(screen.queryByText("¥0.01")).not.toBeInTheDocument());
  });

  it("重试请求仍在进行时卸载会取消当前请求", async () => {
    const pending = deferred<typeof dashboardResponsePreview>();
    api.fetchDashboard
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(pending.promise);
    const { unmount } = render(<DashboardClient asOfDate="2026-08-31" />);

    fireEvent.click(await screen.findByRole("button", { name: "重新加载" }));
    const retrySignal = api.fetchDashboard.mock.calls[1]?.[1] as AbortSignal;
    expect(retrySignal.aborted).toBe(false);

    unmount();
    expect(retrySignal.aborted).toBe(true);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

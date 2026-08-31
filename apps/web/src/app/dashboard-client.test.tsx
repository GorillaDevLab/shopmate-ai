import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));

import { dashboardResponsePreview } from "./dashboard-data";

const api = vi.hoisted(() => ({ fetchDashboard: vi.fn() }));
vi.mock("./dashboard-api", () => ({
  fetchDashboard: api.fetchDashboard,
  isAbortError: (error: unknown) => error instanceof DOMException && error.name === "AbortError",
}));

import { DashboardClient } from "./dashboard-client";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

describe("DashboardClient", () => {
  beforeEach(() => vi.resetAllMocks());

  it("切换外观不重新请求、不重置时段或改变金额", async () => {
    api.fetchDashboard.mockResolvedValue(dashboardResponsePreview);
    render(<DashboardClient asOfDate="2026-08-31" />);
    await screen.findByText("数据来自 Analytics API");
    fireEvent.click(screen.getByRole("button", { name: "近 30 天" }));
    await screen.findByText("数据来自 Analytics API");
    const calls = api.fetchDashboard.mock.calls.length;
    const card = screen.getByRole("article", { name: "近 30 天销售额" });
    const amount = card.textContent;
    fireEvent.click(screen.getByRole("button", { name: "外观设置" }));
    fireEvent.click(screen.getByRole("radio", { name: "经典紫色" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭外观设置" }));
    expect(api.fetchDashboard).toHaveBeenCalledTimes(calls);
    expect(card.textContent).toBe(amount);
    expect(screen.getByRole("button", { name: "近 30 天" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it("全页切换 30 天，取消七天请求，旧请求晚返回不能覆盖", async () => {
    const first = deferred<typeof dashboardResponsePreview>();
    const second = deferred<typeof dashboardResponsePreview>();
    api.fetchDashboard.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<DashboardClient asOfDate="2026-08-31" />);
    fireEvent.click(screen.getByRole("button", { name: "近 30 天" }));
    expect(api.fetchDashboard.mock.calls[0]?.[1].aborted).toBe(true);
    expect(api.fetchDashboard).toHaveBeenLastCalledWith(
      "2026-08-31",
      expect.any(AbortSignal),
      "2026-08-02",
    );
    second.resolve({
      ...dashboardResponsePreview,
      period: { startDate: "2026-08-02", endDate: "2026-08-31", days: 30 },
    });
    expect(
      within(await screen.findByRole("article", { name: "近 30 天销售额" })).getByText(
        "¥12,680.00",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/近 30 天销量：/).length).toBeGreaterThan(0);
    first.resolve({
      ...dashboardResponsePreview,
      metrics: dashboardResponsePreview.metrics.map((metric) => ({ ...metric, value: 1 })),
    });
    await waitFor(() => expect(screen.queryByText("¥0.01")).not.toBeInTheDocument());
  });

  it("30 天请求失败后重试仍使用同一范围，可切回 7 天", async () => {
    api.fetchDashboard
      .mockResolvedValueOnce(dashboardResponsePreview)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(dashboardResponsePreview);
    render(<DashboardClient asOfDate="2026-08-31" />);
    await screen.findByText("数据来自 Analytics API");
    fireEvent.click(screen.getByRole("button", { name: "近 30 天" }));
    fireEvent.click(await screen.findByRole("button", { name: "重新加载" }));
    expect(api.fetchDashboard).toHaveBeenLastCalledWith(
      "2026-08-31",
      expect.any(AbortSignal),
      "2026-08-02",
    );
    fireEvent.click(screen.getByRole("button", { name: "近 7 天" }));
    expect(api.fetchDashboard).toHaveBeenLastCalledWith(
      "2026-08-31",
      expect.any(AbortSignal),
      undefined,
    );
  });

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

  it("会话失效时提供重新登录入口", async () => {
    const error = Object.assign(new Error("登录已失效，请重新登录"), { status: 401 });
    api.fetchDashboard.mockRejectedValueOnce(error);
    render(<DashboardClient asOfDate="2026-08-31" />);

    const loginLink = await screen.findByRole("link", { name: "重新登录" });
    expect(loginLink).toHaveAttribute("href", "/login");
    expect(screen.getByText("请先登录后再查看商家经营数据。")).toBeInTheDocument();
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

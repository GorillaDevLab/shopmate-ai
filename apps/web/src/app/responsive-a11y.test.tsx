import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { render } from "../test/assistant-render";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
const api = vi.hoisted(() => ({ fetchAnalyticsOverview: vi.fn() }));
vi.mock("./analytics/analytics-api", () => api);
vi.mock("./analytics/analytics-layout-api", async () => {
  const { DEFAULT_ANALYTICS_LAYOUT } = await import("@shopmate/contracts");
  return {
    fetchAnalyticsLayout: vi.fn(async () => ({
      layout: DEFAULT_ANALYTICS_LAYOUT,
      revision: 0,
      updatedAt: null,
    })),
    saveAnalyticsLayout: vi.fn(),
  };
});
vi.mock("./monitoring-api", () => ({
  getMonitoringUnreadCount: vi.fn(async () => ({ count: 0 })),
  listMonitoringNotifications: vi.fn(async () => ({ items: [] })),
  listMonitoringRules: vi.fn(async () => ({ items: [] })),
  syncMonitoring: vi.fn(async () => ({
    evaluatedRules: 0,
    createdNotifications: 0,
    failedRules: 0,
  })),
}));

import { DashboardApiError } from "./dashboard-api";
import { overviewFixture } from "./analytics/analytics-fixture";
import Home from "./page";

function withRequestedPeriod() {
  api.fetchAnalyticsOverview.mockImplementation(async (asOfDate: string, startDate: string) => ({
    ...overviewFixture(),
    period: { startDate, endDate: asOfDate, days: 14 },
  }));
}

describe("首页响应式与无障碍验收", () => {
  beforeEach(() => vi.clearAllMocks());

  it("为核心区域提供稳定的语义名称", async () => {
    withRequestedPeriod();
    render(<Home />);
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "经营图表" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "经营总览" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "经营洞察" })).toBeInTheDocument();
  });

  it("所有可操作控件都有可读名称", async () => {
    withRequestedPeriod();
    render(<Home />);
    await screen.findByRole("region", { name: "经营图表" });
    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveAccessibleName();
    }
  });

  it("经营监听面板可由键盘关闭并将焦点还给入口", async () => {
    withRequestedPeriod();
    render(<Home />);
    const trigger = screen.getByRole("button", { name: "经营监听" });
    trigger.focus();
    fireEvent.click(trigger);

    expect(await screen.findByRole("dialog", { name: "经营监听" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("监听内容")).toHaveFocus());
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "经营监听" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("加载时向辅助技术播报状态", () => {
    api.fetchAnalyticsOverview.mockReturnValue(new Promise(() => {}));
    render(<Home />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("region", { name: "经营图表" })).not.toBeInTheDocument();
  });

  it("会话失效状态提供可键盘访问的重新登录入口", async () => {
    api.fetchAnalyticsOverview.mockRejectedValue(new DashboardApiError("登录已失效", 401));
    render(<Home />);
    const link = await screen.findByRole("link", { name: "重新登录" });
    expect(link).toHaveAttribute("href", "/login");
  });
});

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("./dashboard-layout-api", async () => {
  const { DEFAULT_DASHBOARD_LAYOUT } = await import("@shopmate/contracts");
  return {
    fetchDashboardLayout: vi.fn(async () => ({
      layout: DEFAULT_DASHBOARD_LAYOUT,
      revision: 0,
      updatedAt: null,
    })),
    saveDashboardLayout: vi.fn(),
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

import { dashboardResponsePreview } from "./dashboard-data";
import { Dashboard } from "./dashboard";

describe("Dashboard 响应式与无障碍验收", () => {
  it("为核心区域提供稳定的语义名称", async () => {
    render(<Dashboard state="ready" data={dashboardResponsePreview} />);

    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "经营看板卡片" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "销售趋势" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "库存提醒" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "热销商品" })).toBeInTheDocument();
  });

  it("所有可操作控件都有可读名称，指标卡标注当前周期", async () => {
    render(<Dashboard state="ready" data={dashboardResponsePreview} />);
    await screen.findByRole("region", { name: "经营看板卡片" });

    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveAccessibleName();
    }
    expect(screen.getByRole("button", { name: "外观设置" })).toHaveAttribute(
      "aria-haspopup",
      "dialog",
    );
    expect(screen.getByRole("article", { name: "近 7 天销售额" })).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "经营看板卡片" })).getAllByRole("article"),
    ).toHaveLength(4);
  });

  it("在当前看板打开 AI 助手，进入布局编辑时自动关闭", async () => {
    render(<Dashboard state="ready" data={dashboardResponsePreview} />);
    await screen.findByRole("button", { name: /编辑看板/ });

    fireEvent.click(screen.getByRole("button", { name: "AI 助手" }));
    expect(screen.getByRole("dialog", { name: "AI 经营助手" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /编辑看板/ }));
    expect(screen.queryByRole("dialog", { name: "AI 经营助手" })).not.toBeInTheDocument();
  });

  it("经营监听面板可由键盘关闭并将焦点还给入口", async () => {
    render(<Dashboard state="ready" data={dashboardResponsePreview} />);
    const trigger = screen.getByRole("button", { name: "经营监听" });
    trigger.focus();
    fireEvent.click(trigger);

    expect(await screen.findByRole("dialog", { name: "经营监听" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("监听内容")).toHaveFocus());
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "经营监听" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it.each(["loading", "empty", "error"] as const)(
    "%s 状态向辅助技术播报状态并避免残留内容",
    (state) => {
      render(<Dashboard state={state} />);
      const status = screen.getByRole("status");
      expect(status).toHaveAttribute("aria-live", "polite");
      expect(status).toHaveTextContent(
        state === "loading" ? "正在整理" : state === "empty" ? "还没有" : "失败",
      );
      expect(screen.queryByRole("region", { name: "销售趋势" })).not.toBeInTheDocument();
    },
  );

  it("会话失效状态提供可键盘访问的重新登录入口", () => {
    render(<Dashboard state="error" authRequired />);
    const link = screen.getByRole("link", { name: "重新登录" });
    expect(link).toHaveAttribute("href", "/login");
    expect(link).toHaveClass("min-h-11");
  });
});

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));

import { dashboardResponsePreview } from "./dashboard-data";
import { Dashboard } from "./dashboard";

describe("Dashboard 响应式与无障碍验收", () => {
  it("为核心区域提供稳定的语义名称", () => {
    render(<Dashboard state="ready" data={dashboardResponsePreview} />);

    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "经营看板卡片" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "销售趋势" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "库存提醒" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "热销商品" })).toBeInTheDocument();
  });

  it("所有可操作控件都有可读名称，指标卡标注当前周期", () => {
    render(<Dashboard state="ready" data={dashboardResponsePreview} />);

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

  it("在当前看板打开 AI 助手，进入布局编辑时自动关闭", () => {
    render(<Dashboard state="ready" data={dashboardResponsePreview} />);

    fireEvent.click(screen.getByRole("button", { name: "AI 助手" }));
    expect(screen.getByRole("dialog", { name: "AI 经营助手" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /编辑看板/ }));
    expect(screen.queryByRole("dialog", { name: "AI 经营助手" })).not.toBeInTheDocument();
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

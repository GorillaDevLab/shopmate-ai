import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("./monitoring-api", () => ({
  getMonitoringUnreadCount: async () => ({ count: 0 }),
  listMonitoringNotifications: async () => ({ items: [] }),
  syncMonitoring: async () => ({ evaluatedRules: 0, createdNotifications: 0, failedRules: 0 }),
}));

import { AppShell } from "./app-shell";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

function renderShell() {
  return render(
    <AppShell active="chat" title="AI 对话" notificationsEnabled={false}>
      <p>页面内容</p>
    </AppShell>,
  );
}

describe("AppShell 仪表盘外壳", () => {
  it("提供唯一主区域、跳转链接和标记当前页的侧边导航", () => {
    renderShell();

    expect(screen.getByRole("main")).toHaveTextContent("页面内容");
    expect(screen.getByRole("link", { name: "跳到主要内容" })).toHaveAttribute(
      "href",
      "#main-content",
    );
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(nav).getByRole("link", { name: "AI 对话" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: "经营看板" })).not.toHaveAttribute("aria-current");
  });

  it("顶部工具栏包含搜索、通知和用户信息", () => {
    renderShell();

    const search = screen.getByRole("search");
    expect(search).toHaveAttribute("action", "/chat");
    const input = within(search).getByRole("searchbox", { name: "搜索或提问" });
    expect(input).toHaveAttribute("name", "q");
    expect(input).toHaveAttribute("maxlength", "2000");
    expect(screen.getByRole("button", { name: /通知/ })).toBeInTheDocument();
    expect(screen.getAllByText("商家账号").length).toBeGreaterThan(0);
  });

  it("侧边栏底部提供外观设置与退出登录", () => {
    renderShell();

    expect(screen.getByRole("button", { name: "外观设置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "退出登录" })).toBeInTheDocument();
  });

  it("小屏导航抽屉可打开、Esc 关闭并把焦点还给菜单按钮", () => {
    renderShell();
    const trigger = screen.getByRole("button", { name: "打开导航菜单" });

    fireEvent.click(trigger);
    const drawer = screen.getByRole("dialog", { name: "导航菜单" });
    expect(within(drawer).getByRole("searchbox", { name: "搜索或提问" })).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(within(drawer).getByRole("button", { name: "关闭导航菜单" }));
    expect(screen.queryByRole("dialog", { name: "导航菜单" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

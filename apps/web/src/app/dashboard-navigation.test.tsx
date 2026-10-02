import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("./theme-settings", () => ({ ThemeSettings: () => <button>外观设置</button> }));
vi.mock("./logout-button", () => ({ LogoutButton: () => <button>退出登录</button> }));
import { DashboardNavigation } from "./dashboard-navigation";

describe("工作台导航", () => {
  it("经营分析是首页入口，AI 助手进入对话页，并能展开手机菜单", () => {
    const monitoring = vi.fn();
    render(<DashboardNavigation onMonitoring={monitoring} />);
    expect(screen.getByRole("link", { name: "经营分析" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "经营分析" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "AI 助手" })).toHaveAttribute("href", "/chat");
    fireEvent.click(screen.getByRole("button", { name: "打开导航菜单" }));
    expect(screen.getByRole("button", { name: "关闭导航菜单" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "经营监听" }));
    expect(monitoring).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "外观设置" })).toBeInTheDocument();
  });
});

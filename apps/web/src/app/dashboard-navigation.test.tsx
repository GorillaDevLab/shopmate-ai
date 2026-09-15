import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("./theme-settings", () => ({ ThemeSettings: () => <button>外观设置</button> }));
vi.mock("./logout-button", () => ({ LogoutButton: () => <button>退出登录</button> }));
import { DashboardNavigation } from "./dashboard-navigation";

describe("工作台导航", () => {
  it("导航复用现有入口，并能展开手机菜单", () => {
    const assistant = vi.fn();
    const monitoring = vi.fn();
    render(<DashboardNavigation onAssistant={assistant} onMonitoring={monitoring} />);
    expect(screen.getByRole("link", { name: "经营看板" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "打开导航菜单" }));
    expect(screen.getByRole("button", { name: "关闭导航菜单" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "AI 助手" }));
    expect(assistant).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "经营监听" }));
    expect(monitoring).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "外观设置" })).toBeInTheDocument();
  });
});

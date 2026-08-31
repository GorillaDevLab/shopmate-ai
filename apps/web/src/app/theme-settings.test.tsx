import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./dashboard";
import { THEME_INIT_SCRIPT } from "./theme";

beforeAll(() => {
  // jsdom lacks native dialogs; focus trapping and Escape are checked in Playwright.
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});
beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themeStorageError;
});
afterEach(() => vi.restoreAllMocks());

function openSettings() {
  fireEvent.click(screen.getByRole("button", { name: "外观设置" }));
}

describe("外观设置", () => {
  it("初始化读取失败会在设置内显示提示", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    window.eval(THEME_INIT_SCRIPT);
    render(<Dashboard />);
    openSettings();
    expect(screen.getByRole("alert")).toHaveTextContent("当前浏览器无法保存外观设置");
  });
  it("默认暖灰，可双向切换并保存，关闭不撤销选择", () => {
    render(<Dashboard />);
    openSettings();
    expect(screen.getByRole("radio", { name: "暖灰陶土" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "经典紫色" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "purple");
    expect(localStorage.getItem("shopmate-theme")).toBe("purple");
    fireEvent.click(screen.getByRole("button", { name: "关闭外观设置" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    openSettings();
    expect(screen.getByRole("radio", { name: "经典紫色" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "暖灰陶土" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "terracotta");
    expect(localStorage.getItem("shopmate-theme")).toBe("terracotta");
  });
  it("设置反映首屏已经恢复的主题", () => {
    document.documentElement.dataset.theme = "purple";
    render(<Dashboard />);
    openSettings();
    expect(screen.getByRole("radio", { name: "经典紫色" })).toBeChecked();
  });
  it("存储失败仍切换本页并显示明确说明", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<Dashboard />);
    openSettings();
    fireEvent.click(screen.getByRole("radio", { name: "经典紫色" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "purple");
    expect(screen.getByRole("alert")).toHaveTextContent("当前浏览器无法保存外观设置");
  });
});

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { dashboardResponsePreview } from "./dashboard-data";
import { DashboardLayoutEditor } from "./dashboard-layout-editor";

describe("DashboardLayoutEditor", () => {
  it("可通过 Ctrl/Cmd+K 和按钮切换编辑模式", () => {
    render(<DashboardLayoutEditor data={dashboardResponsePreview} periodLabel="近 7 天" />);

    expect(screen.queryByRole("toolbar", { name: "看板布局编辑工具" })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByRole("toolbar", { name: "看板布局编辑工具" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "退出编辑" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "退出编辑" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("status", { name: "布局编辑反馈" })).toHaveTextContent(
      "已进入看板编辑模式",
    );

    fireEvent.keyDown(window, { key: "K", metaKey: true });
    expect(screen.queryByRole("toolbar", { name: "看板布局编辑工具" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑看板" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "编辑看板" }));
    expect(screen.getByRole("toolbar", { name: "看板布局编辑工具" })).toBeInTheDocument();
  });

  it("可用键盘和触屏友好的按钮调整顺序", () => {
    render(<DashboardLayoutEditor data={dashboardResponsePreview} periodLabel="近 7 天" />);
    fireEvent.click(screen.getByRole("button", { name: "编辑看板" }));

    fireEvent.click(screen.getByRole("button", { name: "销售额下移" }));

    expect(cardOrder().slice(0, 2)).toEqual(["metric-orders", "metric-sales"]);
    expect(screen.getByRole("status", { name: "布局编辑反馈" })).toHaveTextContent(
      "销售额已移至第 2 位",
    );
  });

  it("支持拖放卡片排序", () => {
    render(<DashboardLayoutEditor data={dashboardResponsePreview} periodLabel="近 7 天" />);
    fireEvent.click(screen.getByRole("button", { name: "编辑看板" }));

    fireEvent.dragStart(dragHandle("销售额"));
    fireEvent.drop(card("metric-sales"));
    expect(screen.queryByText("草稿未保存")).not.toBeInTheDocument();

    fireEvent.dragStart(dragHandle("销售额"));
    fireEvent.dragOver(card("metric-units"));
    fireEvent.drop(card("metric-units"));

    expect(cardOrder().slice(0, 3)).toEqual(["metric-orders", "metric-units", "metric-sales"]);
  });

  it("在表单控件或打开的对话框中不拦截快捷键", () => {
    render(
      <>
        <input aria-label="测试输入" />
        <dialog open aria-label="测试对话框" />
        <DashboardLayoutEditor data={dashboardResponsePreview} periodLabel="近 7 天" />
      </>,
    );
    const input = screen.getByRole("textbox", { name: "测试输入" });
    input.focus();
    fireEvent.keyDown(input, { key: "k", ctrlKey: true });
    expect(screen.getByRole("button", { name: "编辑看板" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByRole("button", { name: "编辑看板" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("修改尺寸只更新本页草稿，不请求保存 API", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<DashboardLayoutEditor data={dashboardResponsePreview} periodLabel="近 7 天" />);
    fireEvent.click(screen.getByRole("button", { name: "编辑看板" }));

    fireEvent.change(screen.getByRole("combobox", { name: "销售额卡片宽度" }), {
      target: { value: "full" },
    });

    expect(card("metric-sales")).toHaveAttribute("data-size", "full");
    expect(screen.getByText("草稿未保存")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("移动端保持单列且所有编辑控件都有可读名称", () => {
    render(<DashboardLayoutEditor data={dashboardResponsePreview} periodLabel="近 7 天" />);
    fireEvent.click(screen.getByRole("button", { name: "编辑看板" }));

    expect(screen.getByRole("region", { name: "经营看板卡片" })).toHaveClass(
      "grid-cols-1",
      "items-start",
    );
    expect(card("sales-trend")).toHaveClass("min-w-0");
    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveAccessibleName();
    }
    expect(
      within(card("metric-sales")).getByRole("combobox", { name: "销售额卡片宽度" }),
    ).toBeInTheDocument();
  });
});

function card(id: string): HTMLElement {
  const element = document.querySelector(`[data-dashboard-card-id="${id}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`找不到卡片 ${id}`);
  return element;
}

function cardOrder(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-dashboard-card-id]")).map(
    (element) => element.dataset.dashboardCardId ?? "",
  );
}

function dragHandle(title: string): HTMLElement {
  const element = document.querySelector(`[data-drag-handle="${title}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`找不到拖动手柄 ${title}`);
  return element;
}

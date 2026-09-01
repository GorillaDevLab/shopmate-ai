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
    fireEvent.dragEnter(card("metric-units"));

    expect(cardOrder().slice(0, 3)).toEqual(["metric-orders", "metric-units", "metric-sales"]);
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

  it("拖动缩放手柄时连续预览，并在松手后吸附到受支持尺寸", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<DashboardLayoutEditor data={dashboardResponsePreview} periodLabel="近 7 天" />);
    fireEvent.click(screen.getByRole("button", { name: "编辑看板" }));
    vi.spyOn(
      screen.getByRole("region", { name: "经营看板卡片" }),
      "getBoundingClientRect",
    ).mockReturnValue(rect({ width: 1_200 }));
    const resizeHandle = screen.getByRole("slider", { name: "调整销售额卡片宽度" });

    fireEvent(resizeHandle, pointerEvent("pointerdown", { clientX: 400, pointerId: 7 }));
    fireEvent(resizeHandle, pointerEvent("pointermove", { clientX: 700, pointerId: 7 }));

    expect(card("metric-sales")).toHaveAttribute("data-size", "1/3");
    expect(card("metric-sales")).toHaveAttribute("data-preview-span", "7");
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "7");

    fireEvent(resizeHandle, pointerEvent("pointerup", { clientX: 700, pointerId: 7 }));

    expect(card("metric-sales")).toHaveAttribute("data-size", "2/3");
    expect(card("metric-sales")).not.toHaveAttribute("data-preview-span");
    expect(resizeHandle).toHaveAttribute("aria-valuetext", "三分之二");
    expect(screen.getByText("草稿未保存")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("缩放手柄支持键盘离散调整，且 Escape 可取消指针草稿", () => {
    render(<DashboardLayoutEditor data={dashboardResponsePreview} periodLabel="近 7 天" />);
    fireEvent.click(screen.getByRole("button", { name: "编辑看板" }));
    vi.spyOn(
      screen.getByRole("region", { name: "经营看板卡片" }),
      "getBoundingClientRect",
    ).mockReturnValue(rect({ width: 1_200 }));
    const resizeHandle = screen.getByRole("slider", { name: "调整销售额卡片宽度" });

    fireEvent.keyDown(resizeHandle, { key: "ArrowRight" });
    expect(card("metric-sales")).toHaveAttribute("data-size", "1/2");

    fireEvent(resizeHandle, pointerEvent("pointerdown", { clientX: 600, pointerId: 8 }));
    fireEvent(resizeHandle, pointerEvent("pointermove", { clientX: 1_000, pointerId: 8 }));
    expect(card("metric-sales")).toHaveAttribute("data-preview-span", "10");
    fireEvent.keyDown(resizeHandle, { key: "Escape" });

    expect(card("metric-sales")).toHaveAttribute("data-size", "1/2");
    expect(card("metric-sales")).not.toHaveAttribute("data-preview-span");
  });

  it("移动端保持单列且所有编辑控件都有可读名称", () => {
    render(<DashboardLayoutEditor data={dashboardResponsePreview} periodLabel="近 7 天" />);
    fireEvent.click(screen.getByRole("button", { name: "编辑看板" }));

    expect(screen.getByRole("region", { name: "经营看板卡片" })).toHaveClass(
      "grid-cols-1",
      "grid-flow-dense",
      "items-start",
    );
    expect(card("sales-trend")).toHaveClass("min-w-0");
    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveAccessibleName();
    }
    expect(
      within(card("metric-sales")).getByRole("slider", { name: "调整销售额卡片宽度" }),
    ).toHaveAttribute("aria-valuemin", "4");
  });
});

function rect(overrides: Partial<DOMRect> = {}): DOMRect {
  return {
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    top: 0,
    width: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...overrides,
  };
}

function pointerEvent(
  type: "pointerdown" | "pointermove" | "pointerup",
  init: { clientX: number; pointerId: number },
): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: init.clientX });
  Object.defineProperty(event, "pointerId", { value: init.pointerId });
  return event;
}

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

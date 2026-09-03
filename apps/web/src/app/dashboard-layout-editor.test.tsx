import { DEFAULT_DASHBOARD_LAYOUT } from "@shopmate/contracts";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "./dashboard-layout-api";
import { dashboardResponsePreview } from "./dashboard-data";
import { DashboardLayoutEditor } from "./dashboard-layout-editor";

vi.mock("./dashboard-layout-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dashboard-layout-api")>();
  return { ...actual, fetchDashboardLayout: vi.fn(), saveDashboardLayout: vi.fn() };
});

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.fetchDashboardLayout).mockResolvedValue(defaultResponse());
  vi.mocked(api.saveDashboardLayout).mockImplementation(async ({ layout }) => ({
    layout,
    revision: 1,
    updatedAt: "2026-09-02T00:00:00.000Z",
  }));
});

afterEach(() => vi.restoreAllMocks());

describe("DashboardLayoutEditor", () => {
  it("重新渲染期间保持同一个快捷键监听器", async () => {
    const addListener = vi.spyOn(window, "addEventListener");
    const removeListener = vi.spyOn(window, "removeEventListener");
    const view = render(
      <DashboardLayoutEditor data={dashboardResponsePreview} periodLabel="近 7 天" />,
    );
    await screen.findByRole("button", { name: "编辑看板" });
    await waitFor(() => expect(keydownListenerCalls(addListener.mock.calls)).toBeGreaterThan(0));
    const initialAdds = keydownListenerCalls(addListener.mock.calls);

    view.rerender(<DashboardLayoutEditor data={dashboardResponsePreview} periodLabel="近 30 天" />);

    expect(keydownListenerCalls(addListener.mock.calls)).toBe(initialAdds);
    expect(keydownListenerCalls(removeListener.mock.calls)).toBe(0);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByRole("toolbar", { name: "看板布局编辑工具" })).toBeInTheDocument();
  });

  it("加载用户布局后可通过 Ctrl/Cmd+K 切换编辑模式", async () => {
    await renderEditor();
    expect(api.fetchDashboardLayout).toHaveBeenCalledOnce();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByRole("toolbar", { name: "看板布局编辑工具" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "完成并保存" })).toHaveFocus();
    expect(screen.getByRole("status", { name: "布局编辑反馈" })).toHaveTextContent(
      "已进入看板编辑模式",
    );
    fireEvent.keyDown(window, { key: "K", metaKey: true });
    expect(screen.queryByRole("toolbar", { name: "看板布局编辑工具" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑看板" })).toHaveFocus();
  });

  it("可用键盘按钮和拖放调整顺序且不提前保存", async () => {
    await renderEditor();
    enterEditMode();
    fireEvent.click(screen.getByRole("button", { name: "销售额下移" }));
    expect(cardOrder().slice(0, 2)).toEqual(["metric-orders", "metric-sales"]);
    expect(screen.getByText("草稿未保存")).toBeInTheDocument();
    fireEvent.dragStart(dragHandle("销售额"));
    fireEvent.dragEnter(card("metric-units"));
    fireEvent.drop(card("metric-units"));
    expect(cardOrder().slice(0, 3)).toEqual(["metric-orders", "metric-units", "metric-sales"]);
    expect(api.saveDashboardLayout).not.toHaveBeenCalled();
  });

  it("在表单控件或打开的对话框中不拦截快捷键", async () => {
    render(
      <>
        <input aria-label="测试输入" />
        <dialog open aria-label="测试对话框" />
        <DashboardLayoutEditor data={dashboardResponsePreview} periodLabel="近 7 天" />
      </>,
    );
    await screen.findByRole("button", { name: "编辑看板" });
    const input = screen.getByRole("textbox", { name: "测试输入" });
    input.focus();
    fireEvent.keyDown(input, { key: "k", ctrlKey: true });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.queryByRole("toolbar", { name: "看板布局编辑工具" })).not.toBeInTheDocument();
  });

  it("拖动缩放手柄连续预览并吸附到受支持尺寸", async () => {
    await renderEditor();
    enterEditMode();
    vi.spyOn(
      screen.getByRole("region", { name: "经营看板卡片" }),
      "getBoundingClientRect",
    ).mockReturnValue(rect({ width: 1_200 }));
    const resizeHandle = screen.getByRole("slider", { name: "调整销售额卡片宽度" });
    fireEvent(resizeHandle, pointerEvent("pointerdown", { clientX: 400, pointerId: 7 }));
    fireEvent(resizeHandle, pointerEvent("pointermove", { clientX: 700, pointerId: 7 }));
    expect(card("metric-sales")).toHaveAttribute("data-preview-span", "7");
    fireEvent(resizeHandle, pointerEvent("pointerup", { clientX: 700, pointerId: 7 }));
    expect(card("metric-sales")).toHaveAttribute("data-size", "2/3");
    expect(card("metric-sales")).not.toHaveAttribute("data-preview-span");
    expect(api.saveDashboardLayout).not.toHaveBeenCalled();
  });

  it("缩放支持键盘离散调整且 Escape 取消指针草稿", async () => {
    await renderEditor();
    enterEditMode();
    vi.spyOn(
      screen.getByRole("region", { name: "经营看板卡片" }),
      "getBoundingClientRect",
    ).mockReturnValue(rect({ width: 1_200 }));
    const resizeHandle = screen.getByRole("slider", { name: "调整销售额卡片宽度" });
    fireEvent.keyDown(resizeHandle, { key: "ArrowRight" });
    expect(card("metric-sales")).toHaveAttribute("data-size", "1/2");
    fireEvent(resizeHandle, pointerEvent("pointerdown", { clientX: 600, pointerId: 8 }));
    fireEvent(resizeHandle, pointerEvent("pointermove", { clientX: 1_000, pointerId: 8 }));
    fireEvent.keyDown(resizeHandle, { key: "Escape" });
    expect(card("metric-sales")).toHaveAttribute("data-size", "1/2");
    expect(card("metric-sales")).not.toHaveAttribute("data-preview-span");
  });

  it("新增组件、只读预览并显式保存", async () => {
    await renderEditor();
    enterEditMode();
    const initialCount = cardOrder().length;
    fireEvent.click(screen.getByRole("button", { name: "添加组件" }));
    fireEvent.click(screen.getByRole("button", { name: "销售趋势" }));
    fireEvent.click(screen.getByRole("button", { name: "添加到看板" }));
    expect(cardOrder()).toHaveLength(initialCount + 1);
    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "完成并保存" }));
    await waitFor(() => expect(screen.getByText("已保存")).toBeInTheDocument());
    expect(api.saveDashboardLayout).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 0 }),
    );
  });

  it("删除后可以在原位置撤销", async () => {
    await renderEditor();
    enterEditMode();
    openCardMenu("订单");
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    expect(cardOrder()).not.toContain("metric-orders");
    fireEvent.click(screen.getByRole("button", { name: "撤销删除订单" }));
    expect(cardOrder()).toEqual(DEFAULT_DASHBOARD_LAYOUT.cards.map(({ id }) => id));
  });

  it("可放弃草稿，也可确认恢复默认后再保存", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderEditor();
    enterEditMode();
    fireEvent.click(screen.getByRole("button", { name: "销售额下移" }));
    openLayoutMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "放弃修改" }));
    expect(cardOrder()).toEqual(DEFAULT_DASHBOARD_LAYOUT.cards.map(({ id }) => id));
    expect(screen.getByRole("button", { name: "编辑看板" })).toBeInTheDocument();
    enterEditMode();
    openCardMenu("订单");
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    openLayoutMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "恢复默认" }));
    expect(cardOrder()).toEqual(DEFAULT_DASHBOARD_LAYOUT.cards.map(({ id }) => id));
    expect(api.saveDashboardLayout).not.toHaveBeenCalled();
  });

  it("保存冲突时保留当前草稿", async () => {
    vi.mocked(api.saveDashboardLayout).mockRejectedValue(
      new api.DashboardLayoutApiError("布局已在其他设备更新，你的草稿仍然保留", 409, true),
    );
    await renderEditor();
    enterEditMode();
    fireEvent.click(screen.getByRole("button", { name: "销售额下移" }));
    const changedOrder = cardOrder();
    fireEvent.click(screen.getByRole("button", { name: "完成并保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("其他设备");
    expect(cardOrder()).toEqual(changedOrder);
    expect(screen.getByRole("toolbar", { name: "看板布局编辑工具" })).toBeInTheDocument();
  });

  it("读取失败时阻止保存并允许重试", async () => {
    vi.mocked(api.fetchDashboardLayout)
      .mockRejectedValueOnce(new api.DashboardLayoutApiError("布局服务暂时不可用", 503, true))
      .mockResolvedValueOnce(defaultResponse());
    render(<DashboardLayoutEditor data={dashboardResponsePreview} periodLabel="近 7 天" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("布局服务暂时不可用");
    fireEvent.click(screen.getByRole("button", { name: "重新加载布局" }));
    expect(await screen.findByRole("button", { name: "编辑看板" })).toBeInTheDocument();
    expect(api.fetchDashboardLayout).toHaveBeenCalledTimes(2);
  });

  it("移动端保持单列且所有编辑控件都有可读名称", async () => {
    await renderEditor();
    enterEditMode();
    expect(screen.getByRole("region", { name: "经营看板卡片" })).toHaveClass(
      "grid-cols-1",
      "grid-flow-dense",
      "items-start",
    );
    for (const button of screen.getAllByRole("button")) expect(button).toHaveAccessibleName();
    expect(
      within(card("metric-sales")).getByRole("slider", { name: "调整销售额卡片宽度" }),
    ).toHaveAttribute("aria-valuemin", "4");
  });
});

function keydownListenerCalls(calls: readonly (readonly unknown[])[]): number {
  return calls.filter(([eventName]) => eventName === "keydown").length;
}

async function renderEditor() {
  render(<DashboardLayoutEditor data={dashboardResponsePreview} periodLabel="近 7 天" />);
  await screen.findByRole("button", { name: "编辑看板" });
}

function enterEditMode() {
  fireEvent.click(screen.getByRole("button", { name: "编辑看板" }));
}

function openCardMenu(title: string) {
  fireEvent.click(screen.getByRole("button", { name: `${title}更多操作` }));
}

function openLayoutMenu() {
  fireEvent.click(screen.getByRole("button", { name: "更多布局操作" }));
}

function defaultResponse() {
  return { layout: DEFAULT_DASHBOARD_LAYOUT, revision: 0 as const, updatedAt: null };
}

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

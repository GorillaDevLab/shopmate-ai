import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const insightApi = vi.hoisted(() => ({ generateDashboardInsight: vi.fn() }));
vi.mock("./dashboard-insight-api", () => ({
  generateDashboardInsight: insightApi.generateDashboardInsight,
}));

import { DashboardWidgetGallery } from "./dashboard-widget-gallery";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});

describe("DashboardWidgetGallery", () => {
  beforeEach(() => vi.resetAllMocks());
  it("预览受控组件并确认选择", () => {
    const onAdd = vi.fn();
    render(<DashboardWidgetGallery open cardCount={7} onAdd={onAdd} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "销售趋势" }));
    expect(screen.getByRole("heading", { name: "销售趋势" })).toBeInTheDocument();
    expect(screen.getByText("查看当前统计周期的每日销售变化。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加到看板" }));
    expect(onAdd).toHaveBeenCalledWith("salesTrend");
  });

  it("达到 24 张时禁用新增并解释限制", () => {
    render(<DashboardWidgetGallery open cardCount={24} onAdd={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByRole("button", { name: "添加到看板" })).toBeDisabled();
    expect(screen.getByText("看板最多包含 24 张卡片")).toBeInTheDocument();
  });

  it("支持 Escape 与关闭按钮", () => {
    const onClose = vi.fn();
    render(<DashboardWidgetGallery open cardCount={7} onAdd={vi.fn()} onClose={onClose} />);

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "关闭组件库" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("关闭时不向可访问树暴露组件库", () => {
    render(<DashboardWidgetGallery open={false} cardCount={7} onAdd={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("AI 图表必须先生成预览再加入看板", async () => {
    const onAddInsight = vi.fn();
    const preview = {
      query: {
        dataset: "sales",
        metric: "revenue",
        aggregation: "sum",
        groupBy: "product",
        dateRange: { start: "2026-08-01", end: "2026-08-31" },
        filters: [],
        order: "desc",
        limit: 8,
        visualization: "pie",
      },
      result: {
        kind: "pie",
        title: "商品销售占比",
        summary: "近 30 天",
        unit: "currencyMinor",
        slices: [],
      },
    };
    insightApi.generateDashboardInsight.mockResolvedValue(preview);
    render(
      <DashboardWidgetGallery
        open
        cardCount={7}
        onAdd={vi.fn()}
        onAddInsight={onAddInsight}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "AI 图表" }));
    expect(screen.getByRole("button", { name: "添加到看板" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "想分析什么？" }), {
      target: { value: "按商品生成销售额占比" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成预览" }));
    expect(await screen.findByText("所选范围暂无可展示数据")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加到看板" }));
    expect(onAddInsight).toHaveBeenCalledWith("pieChart", preview, "pie");
  });
});

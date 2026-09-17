import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SalesTrend } from "./sales-trend";

describe("销售趋势图", () => {
  it("30 天使用可键盘操作的日期滑块，避免密集按钮互相遮挡", () => {
    const points = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-08-${String(i + 2).padStart(2, "0")}`,
      revenueMinor: i * 100,
    }));
    render(<SalesTrend points={points} periodLabel="所选时段" />);
    const slider = screen.getByRole("slider", { name: "选择趋势日期" });
    fireEvent.change(slider, { target: { value: "9" } });
    expect(screen.getByRole("status")).toHaveTextContent("8月11日");
    expect(screen.getByRole("status")).toHaveTextContent("¥9.00");
    expect(screen.getByRole("button", { name: "折线图" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "所选时段销售趋势图" })).toBeInTheDocument();
  });

  it("switches line and area presentation without changing data", () => {
    const changes: string[] = [];
    render(
      <SalesTrend
        points={[{ date: "2026-08-31", revenueMinor: 12345 }]}
        view="line"
        onViewChange={(view) => changes.push(view)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "面积图" }));
    expect(changes).toEqual(["area"]);
    expect(screen.getByText("¥123.45")).toBeInTheDocument();
  });
  it("展示 API 原始日期与人民币金额", () => {
    render(
      <SalesTrend
        points={[
          { date: "2026-08-30", revenueMinor: 110_000 },
          { date: "2026-08-31", revenueMinor: 126_800 },
        ]}
      />,
    );

    expect(screen.getByRole("img", { name: "近 2 天销售趋势图" })).toBeInTheDocument();
    expect(screen.getByText("¥1,268.00")).toBeInTheDocument();
    const previousDay = screen.getByRole("button", { name: "8月30日，销售额 ¥1,100.00" });
    fireEvent.mouseEnter(previousDay);
    expect(screen.getByRole("status")).toHaveTextContent("8月30日");
    expect(screen.getByRole("status")).toHaveTextContent("¥1,100.00");
    expect(previousDay).toHaveAttribute("aria-pressed", "true");
  });

  it("全零数据仍生成有限坐标，不出现 NaN 或 Infinity", () => {
    const { container } = render(<SalesTrend points={[{ date: "2026-08-31", revenueMinor: 0 }]} />);

    expect(container.innerHTML).not.toMatch(/NaN|Infinity/u);
    expect(screen.getByText("¥0.00")).toBeInTheDocument();
  });

  it("超大安全整数金额在手机明细单元内允许断行", () => {
    render(<SalesTrend points={[{ date: "2026-08-31", revenueMinor: Number.MAX_SAFE_INTEGER }]} />);

    expect(screen.getByText("¥90,071,992,547,409.91")).toHaveClass("break-all");
  });

  it("支持键盘聚焦和点击选择，不改动 API 金额", () => {
    render(
      <SalesTrend
        points={[
          { date: "2026-08-30", revenueMinor: 12345 },
          { date: "2026-08-31", revenueMinor: 0 },
        ]}
      />,
    );
    const previousDay = screen.getByRole("button", { name: "8月30日，销售额 ¥123.45" });
    fireEvent.focus(previousDay);
    expect(screen.getByRole("status")).toHaveTextContent("¥123.45");
    fireEvent.click(screen.getByRole("button", { name: "8月31日，销售额 ¥0.00" }));
    expect(screen.getByRole("status")).toHaveTextContent("¥0.00");
  });

  it("新响应移除已选日期后展示最新日期", () => {
    const { rerender } = render(
      <SalesTrend points={[{ date: "2026-08-30", revenueMinor: 12345 }]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "8月30日，销售额 ¥123.45" }));
    rerender(<SalesTrend points={[{ date: "2026-08-31", revenueMinor: 67890 }]} />);
    expect(screen.getByRole("status")).toHaveTextContent("8月31日");
    expect(screen.getByRole("status")).toHaveTextContent("¥678.90");
  });
});

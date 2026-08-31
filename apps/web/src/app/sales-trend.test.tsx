import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SalesTrend } from "./sales-trend";

describe("销售趋势图", () => {
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
    expect(screen.getByText("8月30日")).toBeInTheDocument();
    expect(screen.getByText("¥1,100.00")).toBeInTheDocument();
    expect(screen.getByText("¥1,268.00")).toBeInTheDocument();
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
});

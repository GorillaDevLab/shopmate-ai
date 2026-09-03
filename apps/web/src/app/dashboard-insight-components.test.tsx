import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DashboardPieChart } from "./dashboard-pie-chart";
import { DashboardReportCard } from "./dashboard-report-card";

describe("AI 经营组件", () => {
  it("饼图提供可读图例和无障碍摘要", () => {
    render(
      <DashboardPieChart
        result={{
          kind: "pie",
          title: "商品销售额占比",
          summary: "近 30 天",
          unit: "currencyMinor",
          slices: [
            { key: "p-1", label: "短袖", value: 12000 },
            { key: "p-2", label: "水杯", value: 8000 },
          ],
        }}
      />,
    );
    expect(screen.getByRole("img", { name: /短袖.*60%/ })).toBeInTheDocument();
    expect(screen.getByText("¥120.00")).toBeInTheDocument();
  });

  it("报告以纯文本结构渲染", () => {
    render(
      <DashboardReportCard
        result={{
          kind: "report",
          title: "经营报告",
          summary: "<script>alert(1)</script>",
          highlights: ["订单表现稳定"],
          metrics: [{ label: "销售额", value: "¥200.00" }],
        }}
      />,
    );
    expect(screen.getByText("<script>alert(1)</script>")).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
  });

  it("空饼图显示明确状态", () => {
    render(
      <DashboardPieChart
        result={{
          kind: "pie",
          title: "商品销售额占比",
          summary: "近 30 天",
          unit: "currencyMinor",
          slices: [],
        }}
      />,
    );
    expect(screen.getByText("所选范围暂无可展示数据")).toBeInTheDocument();
  });
});

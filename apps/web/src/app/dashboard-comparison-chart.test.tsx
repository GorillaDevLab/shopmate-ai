import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DashboardComparisonChart } from "./dashboard-comparison-chart";

describe("经营对比图", () => {
  it("平均值只能比较，不能相加形成占比", () => {
    render(
      <DashboardComparisonChart
        allowDonut={false}
        initialView="donut"
        result={{
          kind: "pie",
          title: "门店客单价对比",
          summary: "近30天",
          unit: "currencyMinor",
          slices: [{ key: "a", label: "朝阳店", value: 12345 }],
        }}
      />,
    );
    expect(screen.queryByRole("button", { name: "环形图" })).not.toBeInTheDocument();
    expect(screen.getByText("¥123.45")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
  it("显示真实金额并允许在柱状图与环形图之间切换", () => {
    render(
      <DashboardComparisonChart
        result={{
          kind: "pie",
          title: "门店销售额",
          summary: "近 30 天",
          unit: "currencyMinor",
          slices: [
            { key: "a", label: "朝阳店", value: 12345 },
            { key: "b", label: "海淀店", value: 0 },
          ],
        }}
      />,
    );
    expect(screen.getByText("¥123.45")).toBeInTheDocument();
    expect(screen.getByText("海淀店")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "环形图" }));
    expect(screen.getByRole("img", { name: /门店销售额/ })).toBeInTheDocument();
  });
  it("空数据不画出虚构的柱子", () => {
    render(
      <DashboardComparisonChart
        result={{
          kind: "pie",
          title: "门店销售额",
          summary: "近 30 天",
          unit: "currencyMinor",
          slices: [],
        }}
      />,
    );
    expect(screen.getByText("所选范围暂无可展示数据")).toBeInTheDocument();
  });
});

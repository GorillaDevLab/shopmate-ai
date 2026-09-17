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

  it("hover leave restores pinned detail and missing key resets selection", () => {
    const result = {
      kind: "pie" as const,
      title: "门店销售额",
      summary: "近 30 天",
      unit: "count" as const,
      slices: [
        { key: "a", label: "朝阳店", value: 6 },
        { key: "b", label: "海淀店", value: 4 },
      ],
    };
    const { rerender } = render(<DashboardComparisonChart initialView="donut" result={result} />);
    fireEvent.click(screen.getByRole("button", { name: /^朝阳店/ }));
    fireEvent.mouseEnter(screen.getByRole("button", { name: /^海淀店/ }));
    expect(screen.getByTestId("chart-center-detail")).toHaveTextContent("海淀店");
    fireEvent.mouseLeave(screen.getByRole("button", { name: /^海淀店/ }));
    expect(screen.getByTestId("chart-center-detail")).toHaveTextContent("朝阳店");
    rerender(
      <DashboardComparisonChart
        initialView="donut"
        result={{ ...result, slices: [result.slices[1]!] }}
      />,
    );
    expect(screen.getByTestId("chart-center-detail")).toHaveTextContent("当前展示合计");
  });

  it("supports controlled presentation without mutating the result", () => {
    const changes: string[] = [];
    const result = {
      kind: "pie" as const,
      title: "门店销售额",
      summary: "近 30 天",
      unit: "count" as const,
      slices: [{ key: "a", label: "朝阳店", value: 6 }],
    };
    render(
      <DashboardComparisonChart
        result={result}
        view="bar"
        onViewChange={(view) => changes.push(view)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "环形图" }));
    expect(changes).toEqual(["pie"]);
    expect(result.slices).toEqual([{ key: "a", label: "朝阳店", value: 6 }]);
  });
});

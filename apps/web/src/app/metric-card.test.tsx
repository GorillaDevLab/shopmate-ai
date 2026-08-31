import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DashboardMetric } from "@shopmate/contracts";
import { MetricCard, MetricGrid } from "./metric-card";

const metric: DashboardMetric = { key: "sales", value: 1268000, changeRatio: 0.186 };

describe("指标网格", () => {
  it("缺失指标保留四项空卡片", () => {
    render(<MetricGrid metrics={[]} />);
    expect(screen.getAllByRole("article")).toHaveLength(4);
    expect(screen.getAllByText("暂无数据")).toHaveLength(4);
  });

  it("输入顺序不改变卡片顺序，独立处理空值", () => {
    render(
      <MetricGrid
        metrics={[{ key: "averageOrderValue", value: 4434, changeRatio: null }, metric]}
      />,
    );
    expect(screen.getAllByRole("article").map((card) => card.getAttribute("aria-label"))).toEqual([
      "近 7 天销售额",
      "近 7 天订单",
      "近 7 天销量",
      "近 7 天客单价",
    ]);
    expect(screen.getAllByText("暂无数据")).toHaveLength(2);
    expect(screen.getByText("¥44.34")).toBeInTheDocument();
  });
});

describe("经营指标卡片", () => {
  it.each([
    ["sales", 1268000, "近 7 天销售额", "¥12,680.00"],
    ["sales", 1, "近 7 天销售额", "¥0.01"],
    ["sales", 0, "近 7 天销售额", "¥0.00"],
    ["sales", Number.MAX_SAFE_INTEGER, "近 7 天销售额", "¥90,071,992,547,409.91"],
    ["orders", 1286, "近 7 天订单", "1,286 单"],
    ["orders", 0, "近 7 天订单", "0 单"],
    ["units", 420, "近 7 天销量", "420 件"],
    ["averageOrderValue", 4434, "近 7 天客单价", "¥44.34"],
  ] as const)("格式化 %s = %s", (key, value, label, output) => {
    render(<MetricCard metric={{ ...metric, key, value }} />);
    expect(screen.getByRole("article", { name: label })).toBeInTheDocument();
    expect(screen.getByText(output)).toBeInTheDocument();
  });

  it.each([
    [0.186, "↑ 上升 18.6%"],
    [-0.052, "↓ 下降 5.2%"],
    [0, "— 持平 0.0%"],
    [-1, "↓ 下降 100.0%"],
    [2, "↑ 上升 200.0%"],
    [0.00001, "↑ 上升不足 0.1%"],
    [-0.00001, "↓ 下降不足 0.1%"],
    [null, "暂无可比数据"],
  ])("变化 %s 用文字与符号说明", (changeRatio, text) => {
    render(<MetricCard metric={{ ...metric, changeRatio }} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByText("较上一周期")).toBeInTheDocument();
  });

  it("空值不显示为零，也不展示涨跌", () => {
    render(<MetricCard metric={{ ...metric, value: null }} />);
    expect(screen.getByText("暂无数据")).toBeInTheDocument();
    expect(screen.queryByText(/18.6%|¥0.00/)).not.toBeInTheDocument();
  });

  it.each(["loading", "empty", "error"] as const)("%s 不泄漏旧数值", (state) => {
    render(<MetricCard metric={metric} state={state} />);
    expect(screen.queryByText("¥12,680.00")).not.toBeInTheDocument();
    expect(screen.queryByText(/18.6%/)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        { loading: "正在加载指标", empty: "暂无数据", error: "指标加载失败" }[state],
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("article")).toHaveAttribute("aria-busy", String(state === "loading"));
  });

  it("状态恢复后替换骨架为新数值", () => {
    const { rerender } = render(<MetricCard metric={metric} state="loading" />);
    rerender(<MetricCard metric={metric} />);
    expect(screen.queryByText("正在加载指标")).not.toBeInTheDocument();
    expect(screen.getByText("¥12,680.00")).toBeInTheDocument();
  });
});

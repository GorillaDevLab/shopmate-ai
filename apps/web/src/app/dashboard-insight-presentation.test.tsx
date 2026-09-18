import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DashboardInsightResult } from "@shopmate/contracts";
import {
  DashboardInsightPresentation,
  recommendInsightView,
} from "./dashboard-insight-presentation";

const series: Extract<DashboardInsightResult, { kind: "series" }> = {
  kind: "series",
  title: "订单趋势",
  summary: "近 3 天",
  unit: "count",
  points: [
    { date: "2026-09-01", value: 2 },
    { date: "2026-09-02", value: 4 },
  ],
};

it("把序列结果路由到趋势图并在本地切换视图", () => {
  const onViewChange = vi.fn();
  render(<DashboardInsightPresentation result={series} onViewChange={onViewChange} />);
  expect(screen.getByRole("heading", { name: "订单趋势" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "柱状图" }));
  expect(onViewChange).toHaveBeenCalledWith("bar");
});

describe("recommendInsightView", () => {
  it("为序列和报告给出稳定解释", () => {
    expect(recommendInsightView(series)).toEqual({
      view: "line",
      reason: "按日期的连续数据适合用折线图观察趋势。",
    });
    expect(
      recommendInsightView({
        kind: "report",
        title: "报告",
        summary: "摘要",
        highlights: [],
        metrics: [],
      }),
    ).toMatchObject({ view: "report" });
  });
});

"use client";

import type { DashboardChartView, DashboardInsightResult } from "@shopmate/contracts";
import { DashboardComparisonChart } from "./dashboard-comparison-chart";
import { DashboardReportCard } from "./dashboard-report-card";
import { DashboardSeriesChart } from "./dashboard-series-chart";

export type InsightPresentationProps = {
  result: DashboardInsightResult;
  view?: DashboardChartView;
  onViewChange?: (view: DashboardChartView) => void;
  allowDonut?: boolean;
};

export function DashboardInsightPresentation({
  result,
  view,
  onViewChange,
  allowDonut = true,
}: InsightPresentationProps) {
  if (result.kind === "report") return <DashboardReportCard result={result} />;
  if (result.kind === "series") {
    const seriesView = view === "line" || view === "bar" || view === "area" ? view : undefined;
    return <DashboardSeriesChart result={result} view={seriesView} onViewChange={onViewChange} />;
  }
  const categoryView = view === "bar" || view === "pie" ? view : undefined;
  return (
    <DashboardComparisonChart
      result={result}
      view={categoryView}
      allowDonut={allowDonut}
      onViewChange={onViewChange}
    />
  );
}

export function recommendInsightView(
  result: DashboardInsightResult,
  requested: DashboardChartView | "auto" = "auto",
): { view: DashboardChartView; reason: string } {
  if (result.kind === "report")
    return { view: "report", reason: "这是不分组的经营摘要，适合报告阅读。" };
  if (requested !== "auto" && requested !== "report") {
    return { view: requested, reason: `已按你的选择使用${viewLabel(requested)}。` };
  }
  if (result.kind === "series")
    return { view: "line", reason: "按日期的连续数据适合用折线图观察趋势。" };
  return { view: "bar", reason: "分类数据默认按排名展示，便于比较差异。" };
}

function viewLabel(view: DashboardChartView): string {
  return view === "pie"
    ? "环形图"
    : view === "bar"
      ? "柱状图"
      : view === "area"
        ? "面积图"
        : "折线图";
}

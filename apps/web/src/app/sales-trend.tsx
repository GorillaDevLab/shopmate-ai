"use client";
import type { AnalyticsDashboardResponse } from "@shopmate/contracts";
import { DashboardSeriesChart } from "./dashboard-series-chart";
type TrendPoint = AnalyticsDashboardResponse["trend"][number];

export function SalesTrend({
  points,
  periodLabel,
  view,
  onViewChange,
}: {
  points: readonly TrendPoint[];
  periodLabel?: string;
  view?: "line" | "area";
  onViewChange?: (view: "line" | "area") => void;
}) {
  const label = `${periodLabel ?? `近 ${points.length} 天`} · 每日销售额`;
  return (
    <DashboardSeriesChart
      result={{
        kind: "series",
        title: "销售趋势",
        summary: label,
        unit: "currencyMinor",
        points: points.map(({ date, revenueMinor }) => ({ date, value: revenueMinor })),
      }}
      heading="销售趋势"
      periodLabel={label}
      chartLabel={`${periodLabel ?? `近 ${points.length} 天`}销售趋势图`}
      view={view}
      views={["line", "area"]}
      onViewChange={(next) => {
        if (next !== "bar") onViewChange?.(next);
      }}
    />
  );
}

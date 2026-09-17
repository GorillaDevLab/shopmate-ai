"use client";
import type { DashboardInsightResult } from "@shopmate/contracts";
import { useState } from "react";
import { chartColor, formatChartShare, formatChartValue } from "./dashboard-chart-model";
import { DashboardPieChart } from "./dashboard-pie-chart";
type Result = Extract<DashboardInsightResult, { kind: "pie" }>;
type View = "bar" | "pie";
type Props = {
  result: Result;
  initialView?: "bar" | "donut";
  allowDonut?: boolean;
  view?: View;
  onViewChange?: (view: View) => void;
};

export function DashboardComparisonChart({
  result,
  initialView = "bar",
  allowDonut = true,
  view,
  onViewChange,
}: Props) {
  const [localView, setLocalView] = useState<View>(initialView === "donut" ? "pie" : initialView);
  const activeView = allowDonut ? (view ?? localView) : "bar";
  const selectView = (next: View) => {
    if (view === undefined) setLocalView(next);
    onViewChange?.(next);
  };
  return (
    <div className="comparison-chart">
      {allowDonut && (
        <div className="chart-switch" role="group" aria-label="图表显示方式">
          <button
            type="button"
            aria-pressed={activeView === "bar"}
            onClick={() => selectView("bar")}
          >
            柱状图
          </button>
          <button
            type="button"
            aria-pressed={activeView === "pie"}
            onClick={() => selectView("pie")}
          >
            环形图
          </button>
        </div>
      )}
      {activeView === "pie" ? (
        <DashboardPieChart result={result} />
      ) : (
        <ComparisonBars result={result} additive={allowDonut} />
      )}
    </div>
  );
}
function ComparisonBars({ result, additive }: { result: Result; additive: boolean }) {
  const sorted = [...result.slices].sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  const maximum = Math.max(0, ...sorted.map(({ value }) => value));
  const total = sorted.reduce((sum, { value }) => sum + value, 0);
  return (
    <section className="dashboard-insight comparison-bars">
      <header className="dashboard-insight-header">
        <div>
          <h3>{result.title.replace(/占比$/, "对比")}</h3>
          <p>{result.summary}</p>
        </div>
        <span>AI 分析</span>
      </header>
      {!sorted.length ? (
        <p>所选范围暂无可展示数据</p>
      ) : (
        <ul>
          {sorted.map((slice) => (
            <li key={slice.key}>
              <div className="comparison-bar-label">
                <span>{slice.label}</span>
                <strong>
                  {formatChartValue(slice.value, result.unit)}{" "}
                  {formatChartShare(slice.value, total, additive) && (
                    <small>{formatChartShare(slice.value, total, additive)}</small>
                  )}
                </strong>
              </div>
              <div className="comparison-bar-track" aria-hidden="true">
                <span
                  style={{
                    width: `${maximum ? (slice.value / maximum) * 100 : 0}%`,
                    background: chartColor(slice.key),
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="comparison-footnote">
        {result.unit === "currencyMinor" ? "金额单位：人民币元" : "数值以当前查询口径为准"} ·
        当前展示 {result.slices.length} 个分组
      </p>
    </section>
  );
}

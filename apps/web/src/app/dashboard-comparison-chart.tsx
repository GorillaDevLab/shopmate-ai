"use client";

import type { DashboardInsightResult } from "@shopmate/contracts";
import { useState } from "react";
import { DashboardPieChart } from "./dashboard-pie-chart";

type Result = Extract<DashboardInsightResult, { kind: "pie" }>;

export function DashboardComparisonChart({
  result,
  initialView = "bar",
  allowDonut = true,
}: {
  result: Result;
  initialView?: "bar" | "donut";
  allowDonut?: boolean;
}) {
  const [view, setView] = useState(initialView);
  return (
    <div className="comparison-chart">
      {allowDonut && (
        <div className="comparison-switch" role="group" aria-label="图表显示方式">
          <button type="button" aria-pressed={view === "bar"} onClick={() => setView("bar")}>
            柱状图
          </button>
          <button type="button" aria-pressed={view === "donut"} onClick={() => setView("donut")}>
            环形图
          </button>
        </div>
      )}
      {allowDonut && view === "donut" ? (
        <DashboardPieChart result={result} />
      ) : (
        <ComparisonBars result={result} />
      )}
    </div>
  );
}

function ComparisonBars({ result }: { result: Result }) {
  const max = Math.max(0, ...result.slices.map((slice) => slice.value));
  return (
    <section className="dashboard-insight comparison-bars" aria-label={result.title}>
      <header className="dashboard-insight-header">
        <div>
          <h3>{result.title.replace(/占比$/, "对比")}</h3>
          <p>{result.summary}</p>
        </div>
        <span>AI 分析</span>
      </header>
      {!result.slices.length ? (
        <p>所选范围暂无可展示数据</p>
      ) : (
        <ul>
          {result.slices.map((slice) => (
            <li key={slice.key}>
              <div className="comparison-bar-label">
                <span>{slice.label}</span>
                <strong>{formatValue(slice.value, result.unit)}</strong>
              </div>
              <div className="comparison-bar-track" aria-hidden="true">
                <span style={{ width: `${max ? (slice.value / max) * 100 : 0}%` }} />
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

function formatValue(value: number, unit: Result["unit"]) {
  return unit === "currencyMinor"
    ? `¥${(value / 100).toFixed(2)}`
    : unit === "ratio"
      ? `${(value * 100).toFixed(1)}%`
      : value.toLocaleString("zh-CN");
}

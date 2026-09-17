"use client";
import type { DashboardInsightResult } from "@shopmate/contracts";
import { useEffect, useState, type ReactNode } from "react";
import {
  buildPieSlices,
  chartColor,
  formatChartShare,
  formatChartValue,
} from "./dashboard-chart-model";
type Result = Extract<DashboardInsightResult, { kind: "pie" }>;

export function DashboardPieChart({ result }: { result: Result }) {
  const [expanded, setExpanded] = useState(false);
  const [pinned, setPinned] = useState<string>();
  const [hovered, setHovered] = useState<string>();
  const slices = buildPieSlices(result.slices, expanded);
  const total = result.slices.reduce((sum, slice) => sum + slice.value, 0);
  useEffect(() => {
    if (pinned && !slices.some(({ key }) => key === pinned)) setPinned(undefined);
  }, [pinned, slices]);
  if (!result.slices.length || total === 0)
    return (
      <ChartShell result={result}>
        <p>所选范围暂无可展示数据</p>
      </ChartShell>
    );
  const active = slices.find(({ key }) => key === (hovered ?? pinned));
  let cursor = 0;
  return (
    <ChartShell result={result}>
      <div className="dashboard-pie-content">
        <div className="dashboard-donut-wrap">
          <svg
            className="dashboard-donut"
            viewBox="0 0 120 120"
            role="img"
            aria-label={`${result.title}：${slices.map((s) => `${s.label} ${formatChartShare(s.value, total)}`).join("，")}`}
          >
            {slices.map((slice) => {
              const length = (slice.value / total) * 100;
              const offset = -cursor;
              cursor += length;
              return (
                <circle
                  key={slice.key}
                  cx="60"
                  cy="60"
                  r="46"
                  pathLength="100"
                  fill="none"
                  stroke={chartColor(slice.key)}
                  strokeWidth="16"
                  strokeDasharray={`${length} ${100 - length}`}
                  strokeDashoffset={offset}
                  role="button"
                  tabIndex={0}
                  aria-label={`图形：${slice.label} ${formatChartShare(slice.value, total)}`}
                  aria-pressed={pinned === slice.key}
                  onMouseEnter={() => setHovered(slice.key)}
                  onMouseLeave={() => setHovered(undefined)}
                  onFocus={() => setHovered(slice.key)}
                  onBlur={() => setHovered(undefined)}
                  onClick={() => setPinned(pinned === slice.key ? undefined : slice.key)}
                />
              );
            })}
          </svg>
          <div className="dashboard-donut-center" data-testid="chart-center-detail">
            <span>{active?.label ?? "当前展示合计"}</span>
            <strong>{formatChartValue(active?.value ?? total, result.unit)}</strong>
          </div>
        </div>
        <ul className="dashboard-pie-legend">
          {slices.map((slice) => (
            <li key={slice.key}>
              <button
                type="button"
                aria-pressed={pinned === slice.key}
                onClick={() => setPinned(pinned === slice.key ? undefined : slice.key)}
                onMouseEnter={() => setHovered(slice.key)}
                onMouseLeave={() => setHovered(undefined)}
                onFocus={() => setHovered(slice.key)}
                onBlur={() => setHovered(undefined)}
              >
                <i style={{ background: chartColor(slice.key) }} />
                <span>{slice.label}</span>
                <strong>{formatChartValue(slice.value, result.unit)}</strong>
                <small>{formatChartShare(slice.value, total)}</small>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {result.slices.length > 5 && (
        <button className="chart-expand" type="button" onClick={() => setExpanded(!expanded)}>
          {expanded ? "收起" : `展开全部 ${result.slices.length} 项`}
        </button>
      )}
    </ChartShell>
  );
}
function ChartShell({ result, children }: { result: Result; children: ReactNode }) {
  return (
    <section className="dashboard-insight dashboard-pie-card">
      <header className="dashboard-insight-header">
        <div>
          <h3>{result.title}</h3>
          <p>{result.summary}</p>
        </div>
        <span>AI 分析</span>
      </header>
      {children}
    </section>
  );
}

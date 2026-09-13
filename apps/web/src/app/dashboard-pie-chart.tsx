import type { DashboardInsightResult } from "@shopmate/contracts";
import type { CSSProperties } from "react";

type PieResult = Extract<DashboardInsightResult, { kind: "pie" }>;
const colors = ["#6550d9", "#9988ef", "#3c8f88", "#d99a43", "#6384b9", "#b6708e"];

export function DashboardPieChart({ result }: { result: PieResult }) {
  const total = result.slices.reduce((sum, slice) => sum + slice.value, 0);
  if (total === 0) return <InsightEmpty title={result.title} summary={result.summary} />;
  const segments = createSegments(
    result.slices.map((slice) => slice.value),
    total,
  );
  const description = result.slices
    .map((slice) => `${slice.label} ${formatPercent(slice.value, total)}`)
    .join("，");
  return (
    <section className="dashboard-insight dashboard-pie-card">
      <InsightHeader title={result.title} summary={result.summary} />
      <div className="dashboard-pie-content">
        <div
          className="dashboard-pie-visual"
          role="img"
          aria-label={`${result.title}：${description}`}
          style={{ "--pie-segments": segments } as CSSProperties}
        />
        <ul className="dashboard-pie-legend">
          {result.slices.map((slice, index) => (
            <li key={slice.key}>
              <span
                className="dashboard-pie-dot"
                style={{ background: colors[index % colors.length] }}
              />
              <span>{slice.label}</span>
              <strong>{formatValue(slice.value, result.unit)}</strong>
              <small>{formatPercent(slice.value, total)}</small>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function InsightHeader({ title, summary }: { title: string; summary: string }) {
  return (
    <header className="dashboard-insight-header">
      <div>
        <h3>{title}</h3>
        <p>{summary}</p>
      </div>
      <span>AI 分析</span>
    </header>
  );
}

function InsightEmpty({ title, summary }: { title: string; summary: string }) {
  return (
    <section className="dashboard-insight dashboard-insight-empty">
      <InsightHeader title={title} summary={summary} />
      <p>所选范围暂无可展示数据</p>
    </section>
  );
}

function createSegments(values: readonly number[], total: number): string {
  let cursor = 0;
  return values
    .map((value, index) => {
      const start = cursor;
      cursor += (value / total) * 100;
      return `${colors[index % colors.length]} ${start}% ${cursor}%`;
    })
    .join(", ");
}

function formatValue(value: number, unit: PieResult["unit"]): string {
  if (unit === "currencyMinor") return `¥${(value / 100).toFixed(2)}`;
  if (unit === "ratio") return `${(value * 100).toFixed(1)}%`;
  return value.toLocaleString("zh-CN");
}

function formatPercent(value: number, total: number): string {
  return `${((value / total) * 100).toFixed(0)}%`;
}

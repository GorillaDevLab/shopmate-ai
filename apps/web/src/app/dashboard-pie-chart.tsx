"use client";
import type { DashboardInsightResult } from "@shopmate/contracts";
import { useState, type ReactNode } from "react";
import { useChartSelection } from "./dashboard-chart-selection";
import {
  buildPieSlices,
  chartColor,
  formatChartShare,
  formatChartValue,
  type ChartSlice,
} from "./dashboard-chart-model";
type Result = Extract<DashboardInsightResult, { kind: "pie" }>;
type Selection = ReturnType<typeof useChartSelection>;

export function DashboardPieChart({ result }: { result: Result }) {
  const [expanded, setExpanded] = useState(false);
  const slices = buildPieSlices(result.slices, expanded);
  const selection = useChartSelection(slices.map(({ key }) => key));
  const total = result.slices.reduce((sum, slice) => sum + slice.value, 0);
  if (!result.slices.length || total === 0)
    return (
      <ChartShell result={result}>
        <p>所选范围暂无可展示数据</p>
      </ChartShell>
    );
  const active = slices.find(({ key }) => key === selection.active);
  return (
    <ChartShell result={result}>
      <div className="dashboard-pie-content">
        <DonutGraphic
          result={result}
          slices={slices}
          total={total}
          active={active}
          selection={selection}
        />
        <PieLegend unit={result.unit} slices={slices} total={total} selection={selection} />
      </div>
      {result.slices.length > 5 && (
        <button className="chart-expand" type="button" onClick={() => setExpanded(!expanded)}>
          {expanded ? "收起" : `展开全部 ${result.slices.length} 项`}
        </button>
      )}
    </ChartShell>
  );
}

type DonutGraphicProps = {
  result: Result;
  slices: ChartSlice[];
  total: number;
  active?: ChartSlice;
  selection: Selection;
};
function DonutGraphic(props: DonutGraphicProps) {
  const { result, slices, total, active, selection } = props;
  return (
    <div className="dashboard-donut-wrap">
      <svg
        className="dashboard-donut"
        viewBox="0 0 120 120"
        role="img"
        aria-label={`${result.title}：${slices.map((s) => `${s.label} ${formatChartShare(s.value, total)}`).join("，")}`}
      >
        {slices.map((slice, index) => (
          <DonutSegment
            key={slice.key}
            slice={slice}
            offset={
              -slices.slice(0, index).reduce((sum, item) => sum + (item.value / total) * 100, 0)
            }
            total={total}
            selection={selection}
          />
        ))}
      </svg>
      <div className="dashboard-donut-center" data-testid="chart-center-detail">
        <span>{active?.label ?? "当前展示合计"}</span>
        <strong>{formatChartValue(active?.value ?? total, result.unit)}</strong>
      </div>
    </div>
  );
}

function DonutSegment({
  slice,
  offset,
  total,
  selection,
}: {
  slice: ChartSlice;
  offset: number;
  total: number;
  selection: Selection;
}) {
  const length = (slice.value / total) * 100;
  return (
    <circle
      cx="60"
      cy="60"
      r="46"
      pathLength="100"
      fill="none"
      stroke={chartColor(slice.key)}
      strokeWidth="16"
      strokeDasharray={`${length} ${100 - length}`}
      strokeDashoffset={offset}
      onMouseEnter={() => selection.preview(slice.key)}
      onMouseLeave={selection.clearPreview}
      onClick={() => selection.toggle(slice.key)}
    />
  );
}

function PieLegend({
  unit,
  slices,
  total,
  selection,
}: {
  unit: Result["unit"];
  slices: ChartSlice[];
  total: number;
  selection: Selection;
}) {
  return (
    <ul className="dashboard-pie-legend">
      {slices.map((slice) => (
        <li key={slice.key}>
          <button
            type="button"
            aria-pressed={selection.pinned === slice.key}
            onClick={() => selection.toggle(slice.key)}
            onMouseEnter={() => selection.preview(slice.key)}
            onMouseLeave={selection.clearPreview}
            onFocus={() => selection.preview(slice.key)}
            onBlur={selection.clearPreview}
          >
            <i style={{ background: chartColor(slice.key) }} />
            <span>{slice.label}</span>
            <strong>{formatChartValue(slice.value, unit)}</strong>
            <small>{formatChartShare(slice.value, total)}</small>
          </button>
        </li>
      ))}
    </ul>
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

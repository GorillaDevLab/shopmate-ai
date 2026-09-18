"use client";
import type { DashboardInsightResult } from "@shopmate/contracts";
import { useState } from "react";
import { useChartSelection } from "./dashboard-chart-selection";
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
      {allowDonut && <ViewSwitch view={activeView} onChange={selectView} />}
      {activeView === "pie" ? (
        <DashboardPieChart result={result} />
      ) : (
        <ComparisonBars result={result} additive={allowDonut} />
      )}
    </div>
  );
}

function ViewSwitch({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  return (
    <div className="chart-switch" role="group" aria-label="图表显示方式">
      <button type="button" aria-pressed={view === "bar"} onClick={() => onChange("bar")}>
        柱状图
      </button>
      <button type="button" aria-pressed={view === "pie"} onClick={() => onChange("pie")}>
        环形图
      </button>
    </div>
  );
}

function ComparisonBars({ result, additive }: { result: Result; additive: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const sorted = [...result.slices].sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  const selection = useChartSelection(sorted.map(({ key }) => key));
  const active = sorted.find(({ key }) => key === selection.active);
  const total = sorted.reduce((sum, { value }) => sum + value, 0);
  const maximum = Math.max(0, ...sorted.map(({ value }) => value));
  const shown = expanded ? sorted : sorted.slice(0, 5);
  return (
    <section className="dashboard-insight comparison-bars">
      <ChartHeader result={result} />
      {sorted.length ? (
        <>
          <BarDetail result={result} active={active} total={total} additive={additive} />
          <ul>
            {shown.map((slice, index) => (
              <BarRow
                key={slice.key}
                slice={slice}
                rank={index + 1}
                maximum={maximum}
                total={total}
                additive={additive}
                unit={result.unit}
                selection={selection}
              />
            ))}
          </ul>
        </>
      ) : (
        <p>所选范围暂无可展示数据</p>
      )}
      {sorted.length > 5 && (
        <button className="chart-expand" type="button" onClick={() => setExpanded(!expanded)}>
          {expanded ? "收起" : `展开全部 ${sorted.length} 项`}
        </button>
      )}
      <p className="comparison-footnote">
        {result.unit === "currencyMinor" ? "金额单位：人民币元" : "数值以当前查询口径为准"} ·
        当前展示 {shown.length} 个分组
      </p>
    </section>
  );
}

function BarDetail({
  result,
  active,
  total,
  additive,
}: {
  result: Result;
  active?: Result["slices"][number];
  total: number;
  additive: boolean;
}) {
  return (
    <div className="comparison-detail" data-testid="bar-detail">
      <span>{active?.label ?? (additive ? "当前展示合计" : "选择一项查看明细")}</span>
      <strong>
        {active
          ? formatChartValue(active.value, result.unit)
          : additive
            ? formatChartValue(total, result.unit)
            : "—"}
      </strong>
    </div>
  );
}

type Selection = ReturnType<typeof useChartSelection>;
function BarRow({
  slice,
  rank,
  maximum,
  total,
  additive,
  unit,
  selection,
}: {
  slice: Result["slices"][number];
  rank: number;
  maximum: number;
  total: number;
  additive: boolean;
  unit: Result["unit"];
  selection: Selection;
}) {
  return (
    <li>
      <button
        type="button"
        aria-label={`第 ${rank} 名，${slice.label}，${formatChartValue(slice.value, unit)}`}
        aria-pressed={selection.pinned === slice.key}
        onMouseEnter={() => selection.preview(slice.key)}
        onMouseLeave={selection.clearPreview}
        onFocus={() => selection.preview(slice.key)}
        onBlur={selection.clearPreview}
        onClick={() => selection.toggle(slice.key)}
      >
        <div className="comparison-bar-label">
          <span>
            <b>{rank}</b>
            {slice.label}
          </span>
          <strong>
            {formatChartValue(slice.value, unit)}{" "}
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
      </button>
    </li>
  );
}

function ChartHeader({ result }: { result: Result }) {
  return (
    <header className="dashboard-insight-header">
      <div>
        <h3>{result.title.replace(/占比$/, "对比")}</h3>
        <p>{result.summary}</p>
      </div>
      <span>AI 分析</span>
    </header>
  );
}

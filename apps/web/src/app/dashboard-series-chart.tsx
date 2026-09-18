"use client";
import type { DashboardInsightResult } from "@shopmate/contracts";
import { useId, useState } from "react";
import { useChartSelection } from "./dashboard-chart-selection";
import { createSeriesPoints, formatChartValue } from "./dashboard-chart-model";
import { formatDate, SeriesDrawing, type SeriesView } from "./dashboard-series-drawing";
type Result = Extract<DashboardInsightResult, { kind: "series" }>;
type Props = {
  result: Result;
  view?: SeriesView;
  onViewChange?: (view: SeriesView) => void;
  views?: readonly SeriesView[];
  heading?: string;
  periodLabel?: string;
  chartLabel?: string;
  pointLabel?: string;
};

export function DashboardSeriesChart(props: Props) {
  const {
    result,
    view,
    onViewChange,
    views = ["line", "area", "bar"],
    heading,
    periodLabel,
    chartLabel,
    pointLabel,
  } = props;
  const [localView, setLocalView] = useState<SeriesView>(view ?? "area");
  const gradientId = useId();
  const points = createSeriesPoints(result.points);
  const selection = useChartSelection(points.map(({ date }) => date));
  const selected = points.find(({ date }) => date === selection.active) ?? points.at(-1);
  const title = heading ?? result.title;
  const changeView = (next: SeriesView) => {
    if (view === undefined) setLocalView(next);
    onViewChange?.(next);
  };
  return (
    <SeriesPresentation
      title={title}
      summary={periodLabel ?? result.summary}
      result={result}
      points={points}
      selected={selected}
      views={views}
      view={view ?? localView}
      changeView={changeView}
      gradientId={gradientId}
      selection={selection}
      chartLabel={chartLabel ?? `${title}图`}
      pointLabel={pointLabel ?? title}
    />
  );
}

type PresentationProps = {
  title: string;
  summary: string;
  result: Result;
  points: ReturnType<typeof createSeriesPoints>;
  selected?: ReturnType<typeof createSeriesPoints>[number];
  views: readonly SeriesView[];
  view: SeriesView;
  changeView: (view: SeriesView) => void;
  gradientId: string;
  selection: ReturnType<typeof useChartSelection>;
  chartLabel: string;
  pointLabel: string;
};
function SeriesPresentation(props: PresentationProps) {
  const {
    title,
    summary,
    result,
    points,
    selected,
    views,
    view,
    changeView,
    gradientId,
    selection,
    chartLabel,
    pointLabel,
  } = props;
  return (
    <section aria-label={title} className="dashboard-panel dashboard-series">
      <SeriesHeading title={title} summary={summary} selected={selected} unit={result.unit} />
      <SeriesControls views={views} view={view} onChange={changeView} />
      {points.length ? (
        <SeriesDrawing
          points={points}
          result={result}
          view={view}
          gradientId={gradientId}
          selected={selected}
          selection={selection}
          chartLabel={chartLabel}
          pointLabel={pointLabel}
        />
      ) : (
        <p className="chart-empty">所选范围暂无可展示数据</p>
      )}
    </section>
  );
}

function SeriesHeading({
  title,
  summary,
  selected,
  unit,
}: {
  title: string;
  summary: string;
  selected?: ReturnType<typeof createSeriesPoints>[number];
  unit: Result["unit"];
}) {
  return (
    <header className="series-heading">
      <div>
        <h2>{title}</h2>
        <p>{summary}</p>
      </div>
      <div role="status" aria-live="polite">
        <span>{selected ? formatDate(selected.date) : "暂无数据"}</span>
        <strong className="break-all">
          {selected ? formatChartValue(selected.value, unit) : "—"}
        </strong>
      </div>
    </header>
  );
}
function SeriesControls({
  views,
  view,
  onChange,
}: {
  views: readonly SeriesView[];
  view: SeriesView;
  onChange: (view: SeriesView) => void;
}) {
  return (
    <div className="chart-switch series-switch" role="group" aria-label="趋势图显示方式">
      {views.map((item) => (
        <button
          type="button"
          key={item}
          aria-pressed={view === item}
          onClick={() => onChange(item)}
        >
          {item === "line" ? "折线图" : item === "area" ? "面积图" : "柱状图"}
        </button>
      ))}
    </div>
  );
}

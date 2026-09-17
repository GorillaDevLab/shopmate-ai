"use client";
import type { DashboardInsightResult } from "@shopmate/contracts";
import { useEffect, useId, useState } from "react";
import { createSeriesPoints, formatChartValue } from "./dashboard-chart-model";
type Result = Extract<DashboardInsightResult, { kind: "series" }>;
type View = "line" | "area" | "bar";
type Props = {
  result: Result;
  view?: View;
  onViewChange?: (view: View) => void;
  views?: readonly View[];
  heading?: string;
  periodLabel?: string;
  chartLabel?: string;
};

export function DashboardSeriesChart({
  result,
  view,
  onViewChange,
  views = ["line", "area", "bar"],
  heading,
  periodLabel,
  chartLabel,
}: Props) {
  const [localView, setLocalView] = useState<View>(view ?? "area");
  const [selectedDate, setSelectedDate] = useState<string>();
  const gradientId = useId();
  const activeView = view ?? localView;
  const points = createSeriesPoints(result.points);
  const selected = points.find(({ date }) => date === selectedDate) ?? points.at(-1);
  useEffect(() => {
    if (selectedDate && !result.points.some(({ date }) => date === selectedDate))
      setSelectedDate(undefined);
  }, [result.points, selectedDate]);
  const changeView = (next: View) => {
    if (view === undefined) setLocalView(next);
    onViewChange?.(next);
  };
  return (
    <section aria-label={heading ?? result.title} className="dashboard-panel dashboard-series">
      <header className="series-heading">
        <div>
          <h2>{heading ?? result.title}</h2>
          <p>{periodLabel ?? result.summary}</p>
        </div>
        <div role="status" aria-live="polite">
          <span>{selected ? formatDate(selected.date) : "暂无数据"}</span>
          <strong className="break-all">
            {selected ? formatChartValue(selected.value, result.unit) : "—"}
          </strong>
        </div>
      </header>
      <div className="chart-switch series-switch" role="group" aria-label="趋势图显示方式">
        {views.map((item) => (
          <button
            type="button"
            key={item}
            aria-pressed={activeView === item}
            onClick={() => changeView(item)}
          >
            {viewLabel(item)}
          </button>
        ))}
      </div>
      {!points.length ? (
        <p className="chart-empty">所选范围暂无可展示数据</p>
      ) : (
        <div className="series-stage">
          <svg
            viewBox="0 0 1000 180"
            preserveAspectRatio="none"
            role="img"
        aria-label={chartLabel ?? `${periodLabel ?? result.summary}销售趋势图`}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--brand)" stopOpacity=".26" />
                <stop offset="100%" stopColor="var(--brand)" stopOpacity=".02" />
              </linearGradient>
            </defs>
            {[18, 68, 118, 168].map((y) => (
              <line key={y} x1="40" x2="960" y1={y} y2={y} className="series-grid" />
            ))}
            <SeriesMarks points={points} view={activeView} gradientId={gradientId} />
            {selected && (
              <line
                x1={selected.x * 10}
                x2={selected.x * 10}
                y1="10"
                y2="168"
                className="series-guide"
              />
            )}
          </svg>
          {points.length > 7 ? (
            <input
              type="range"
              min="0"
              max={points.length - 1}
              value={Math.max(
                0,
                points.findIndex(({ date }) => date === selected?.date),
              )}
              aria-label="选择趋势日期"
              aria-valuetext={
                selected
                  ? `${formatDate(selected.date)}，${formatChartValue(selected.value, result.unit)}`
                  : "暂无数据"
              }
              onChange={(event) => setSelectedDate(points[Number(event.target.value)]?.date)}
            />
          ) : (
            points.map((point) => (
              <button
                className="series-point"
                key={point.date}
                type="button"
                aria-label={`${formatDate(point.date)}，销售额 ${formatChartValue(point.value, result.unit)}`}
                aria-pressed={point.date === selected?.date}
                style={{ left: `${point.x}%`, top: `${point.y}%` }}
                onFocus={() => setSelectedDate(point.date)}
                onMouseEnter={() => setSelectedDate(point.date)}
                onClick={() => setSelectedDate(point.date)}
              >
                <i />
              </button>
            ))
          )}
        </div>
      )}
      <div className="series-axis" aria-hidden="true">
        {tickPoints(points).map((point) => (
          <span key={point.date} style={{ left: `${point.x}%` }}>
            {shortDate(point.date)}
          </span>
        ))}
      </div>
    </section>
  );
}

function SeriesMarks({
  points,
  view,
  gradientId,
}: {
  points: ReturnType<typeof createSeriesPoints>;
  view: View;
  gradientId: string;
}) {
  const line = points.map(({ x, y }) => `${x * 10},${y * 1.7}`).join(" ");
  if (view === "bar")
    return (
      <>
        {points.map((point) => (
          <rect
            key={point.date}
            x={point.x * 10 - 8}
            y={point.y * 1.7}
            width="16"
            height={168 - point.y * 1.7}
            rx="4"
            className="series-bar"
          />
        ))}
      </>
    );
  return (
    <>
      {view === "area" && (
        <polygon
          points={`${points[0]!.x * 10},168 ${line} ${points.at(-1)!.x * 10},168`}
          fill={`url(#${gradientId})`}
        />
      )}
      <polyline points={line} className="series-line" />
    </>
  );
}
function tickPoints<T>(points: readonly T[]): T[] {
  const count = Math.min(5, points.length);
  return Array.from(
    new Set(
      Array.from({ length: count }, (_, index) =>
        Math.round((index * (points.length - 1)) / Math.max(1, count - 1)),
      ),
    ),
  )
    .map((index) => points[index]!)
    .filter(Boolean);
}
function viewLabel(view: View) {
  return view === "line" ? "折线图" : view === "area" ? "面积图" : "柱状图";
}
function formatDate(date: string) {
  const [, month, day] = date.split("-");
  return `${Number(month)}月${Number(day)}日`;
}
function shortDate(date: string) {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8))}`;
}

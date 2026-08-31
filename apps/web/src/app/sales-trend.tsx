"use client";

import type { AnalyticsDashboardResponse } from "@shopmate/contracts";
import { useId, useState } from "react";
import { formatMoneyMinor } from "./metric-format";

type TrendPoint = AnalyticsDashboardResponse["trend"][number];
type ChartPoint = TrendPoint & { x: number; y: number };
const axisMoney = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });

export function SalesTrend({
  points,
  periodLabel,
}: {
  points: readonly TrendPoint[];
  periodLabel?: string;
}) {
  const gradientId = useId();
  const [selectedDate, setSelectedDate] = useState<string>();
  const maximum = chartMaximum(points);
  const chartPoints = createChartPoints(points, maximum);
  const selected = chartPoints.find((point) => point.date === selectedDate) ?? chartPoints.at(-1);
  return (
    <section aria-label="销售趋势" className="dashboard-panel flex flex-col justify-between">
      <TrendHeading count={points.length} selected={selected} periodLabel={periodLabel} />
      <div className="mt-4 grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-2">
        <ValueAxis maximum={maximum} />
        <div className="relative h-40 rounded-lg focus-within:ring-2 focus-within:ring-brand/50">
          <TrendDrawing
            points={chartPoints}
            selected={selected}
            gradientId={gradientId}
            periodLabel={periodLabel}
          />
          {chartPoints.length > 7 ? (
            <DenseSelection points={chartPoints} selected={selected} onSelect={setSelectedDate} />
          ) : (
            chartPoints.map((point) => (
              <PointButton
                key={point.date}
                point={point}
                selected={point.date === selected?.date}
                onSelect={setSelectedDate}
              />
            ))
          )}
        </div>
        <div />
        <DateAxis points={chartPoints} />
      </div>
      <ChartLegend dense={points.length > 7} />
    </section>
  );
}

function TrendHeading({
  count,
  selected,
  periodLabel,
}: {
  count: number;
  selected?: TrendPoint;
  periodLabel?: string;
}) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-4">
      <div className="shrink-0">
        <h2 className="text-base font-semibold">销售趋势</h2>
        <p className="mt-1 text-xs text-app-muted">
          {periodLabel ?? `近 ${count} 天`} · 每日销售额
        </p>
      </div>
      <div role="status" aria-live="polite" aria-atomic="true" className="min-w-0 text-right">
        <p className="text-xs text-app-muted">
          {selected ? formatDate(selected.date) : "暂无数据"}
        </p>
        <strong className="mt-1 block break-all text-lg font-bold tabular-nums text-app-text">
          {selected ? formatMoneyMinor(selected.revenueMinor) : "—"}
        </strong>
      </div>
    </div>
  );
}

function ValueAxis({ maximum }: { maximum: number }) {
  return (
    <div
      aria-hidden="true"
      className="relative h-40 text-right text-[11px] tabular-nums text-app-subtle"
    >
      {[1, 2 / 3, 1 / 3, 0].map((ratio) => (
        <span
          key={ratio}
          className="absolute right-0 -translate-y-1/2"
          style={{ top: `${95 - ratio * 90}%` }}
        >
          ¥{axisMoney.format((maximum * ratio) / 100)}
        </span>
      ))}
    </div>
  );
}

type DrawingProps = {
  points: ChartPoint[];
  selected?: ChartPoint;
  gradientId: string;
  periodLabel?: string;
};

function TrendDrawing({ points, selected, gradientId, periodLabel }: DrawingProps) {
  const line = points.map(({ x, y }) => `${x * 10},${y * 1.6}`).join(" ");
  const first = points[0];
  const last = points.at(-1);
  const area = first && last ? `${first.x * 10},152 ${line} ${last.x * 10},152` : "";
  return (
    <svg
      className="absolute inset-0 h-full w-full overflow-visible"
      viewBox="0 0 1000 160"
      preserveAspectRatio="none"
      role="img"
      aria-label={`${periodLabel ?? `近 ${points.length} 天`}销售趋势图`}
    >
      <ChartBackground gradientId={gradientId} />
      <polygon points={area} fill={`url(#${gradientId})`} />
      <polyline
        points={line}
        fill="none"
        stroke="var(--brand)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {selected && <SelectionGuide point={selected} />}
    </svg>
  );
}

function ChartLegend({ dense }: { dense: boolean }) {
  return (
    <p className="mt-3 flex items-center justify-between gap-2 text-xs text-app-muted">
      <span className="inline-flex items-center gap-2">
        <span aria-hidden="true" className="h-0.5 w-4 rounded bg-brand" />
        销售额 · 人民币
      </span>
      <span>{dense ? "拖动图表或按方向键查看" : "选择数据点查看金额"}</span>
    </p>
  );
}

function ChartBackground({ gradientId }: { gradientId: string }) {
  return (
    <>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--brand)" stopOpacity="0.2" />
          <stop offset="100%" stopColor="var(--brand)" stopOpacity="0.015" />
        </linearGradient>
      </defs>
      {[8, 56, 104, 152].map((y) => (
        <line
          key={y}
          x1="40"
          x2="960"
          y1={y}
          y2={y}
          stroke="var(--app-line)"
          strokeDasharray="3 5"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </>
  );
}

function SelectionGuide({ point }: { point: ChartPoint }) {
  return (
    <line
      x1={point.x * 10}
      x2={point.x * 10}
      y1="8"
      y2="152"
      stroke="var(--brand)"
      strokeOpacity="0.3"
      strokeDasharray="3 5"
      vectorEffect="non-scaling-stroke"
    />
  );
}

function PointButton({
  point,
  selected,
  onSelect,
}: {
  point: ChartPoint;
  selected: boolean;
  onSelect: (date: string) => void;
}) {
  return (
    <button
      type="button"
      aria-label={`${formatDate(point.date)}，销售额 ${formatMoneyMinor(point.revenueMinor)}`}
      aria-pressed={selected}
      className="absolute grid size-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full"
      style={{ left: `${point.x}%`, top: `${point.y}%` }}
      onMouseEnter={() => onSelect(point.date)}
      onFocus={() => onSelect(point.date)}
      onClick={() => onSelect(point.date)}
    >
      <span
        aria-hidden="true"
        className={
          selected
            ? "trend-point-selected size-2.5 rounded-full border-2 border-white bg-brand"
            : "size-1.5 rounded-full bg-brand"
        }
      />
    </button>
  );
}

function DateAxis({ points }: { points: ChartPoint[] }) {
  const ticks = new Set(
    Array.from({ length: Math.min(points.length, 5) }, (_, index) =>
      Math.round((index * (points.length - 1)) / Math.max(1, Math.min(points.length, 5) - 1)),
    ),
  );
  return (
    <div aria-hidden="true" className="relative mt-2 h-4 text-[11px] tabular-nums text-app-muted">
      {points
        .filter((_, index) => points.length <= 7 || ticks.has(index))
        .map((point) => (
          <span
            key={point.date}
            className="absolute -translate-x-1/2 whitespace-nowrap"
            style={{ left: `${point.x}%` }}
          >
            {Number(point.date.slice(5, 7))}/{Number(point.date.slice(8))}
          </span>
        ))}
    </div>
  );
}

function DenseSelection({
  points,
  selected,
  onSelect,
}: {
  points: ChartPoint[];
  selected?: ChartPoint;
  onSelect: (date: string) => void;
}) {
  const index = Math.max(
    0,
    points.findIndex((point) => point.date === selected?.date),
  );
  return (
    <>
      {points.map((point) => (
        <span
          key={point.date}
          aria-hidden="true"
          className={`pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand ${point.date === selected?.date ? "trend-point-selected size-2.5 border-2 border-white" : "size-1"}`}
          style={{ left: `${point.x}%`, top: `${point.y}%` }}
        />
      ))}
      <input
        type="range"
        min={0}
        max={points.length - 1}
        step={1}
        value={index}
        aria-label="选择趋势日期"
        aria-valuetext={
          selected
            ? `${formatDate(selected.date)}，销售额 ${formatMoneyMinor(selected.revenueMinor)}`
            : "暂无数据"
        }
        className="absolute inset-y-0 left-[4%] m-0 h-full w-[92%] cursor-crosshair opacity-0"
        onChange={(event) => {
          const point = points[Number(event.target.value)];
          if (point) onSelect(point.date);
        }}
      />
    </>
  );
}

function chartMaximum(points: readonly TrendPoint[]): number {
  const maximum = Math.max(100, ...points.map((point) => point.revenueMinor));
  const magnitude = 10 ** Math.floor(Math.log10(maximum / 3));
  const step = [1, 2, 5, 10].find((factor) => factor * magnitude * 3 >= maximum) ?? 10;
  return step * magnitude * 3;
}

function createChartPoints(points: readonly TrendPoint[], maximum: number): ChartPoint[] {
  return points.map((point, index) => ({
    ...point,
    x: points.length === 1 ? 50 : 4 + (index * 92) / (points.length - 1),
    y: 95 - (point.revenueMinor / maximum) * 90,
  }));
}

function formatDate(date: string): string {
  const [, month, day] = date.split("-");
  return `${Number(month)}月${Number(day)}日`;
}

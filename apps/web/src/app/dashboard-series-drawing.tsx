import type { DashboardInsightResult } from "@shopmate/contracts";
import type { PositionedSeriesDatum } from "./dashboard-chart-model";
import { formatChartValue, PLOT_BASELINE, PLOT_TOP } from "./dashboard-chart-model";
import type { useChartSelection } from "./dashboard-chart-selection";
type Result = Extract<DashboardInsightResult, { kind: "series" }>;
export type SeriesView = "line" | "area" | "bar";
type Selection = ReturnType<typeof useChartSelection>;

type DrawingProps = {
  points: PositionedSeriesDatum[];
  result: Result;
  view: SeriesView;
  gradientId: string;
  selected?: PositionedSeriesDatum;
  selection: Selection;
  chartLabel: string;
  pointLabel: string;
};
export function SeriesDrawing(props: DrawingProps) {
  const { points, result, view, gradientId, selected, selection, chartLabel, pointLabel } = props;
  const maximum = Math.max(0, ...points.map(({ value }) => value));
  return (
    <>
      <div className="series-chart-grid">
        <ValueAxis maximum={maximum} unit={result.unit} />
        <div className="series-stage">
          <ChartSvg
            points={points}
            view={view}
            gradientId={gradientId}
            selected={selected}
            label={chartLabel}
          />
          {points.length > 7 ? (
            <DenseSelector
              points={points}
              selected={selected}
              unit={result.unit}
              selection={selection}
            />
          ) : (
            <PointSelectors
              points={points}
              unit={result.unit}
              label={pointLabel}
              selection={selection}
            />
          )}
        </div>
      </div>
      <DateAxis points={points} />
      <p className="series-unit">{unitLabel(result.unit)}</p>
    </>
  );
}

type ChartSvgProps = {
  points: PositionedSeriesDatum[];
  view: SeriesView;
  gradientId: string;
  selected?: PositionedSeriesDatum;
  label: string;
};
function ChartSvg(props: ChartSvgProps) {
  const { points, view, gradientId, selected, label } = props;
  return (
    <svg viewBox="0 0 1000 180" preserveAspectRatio="none" role="img" aria-label={label}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--brand)" stopOpacity=".26" />
          <stop offset="100%" stopColor="var(--brand)" stopOpacity=".02" />
        </linearGradient>
      </defs>
      {[
        PLOT_TOP,
        PLOT_TOP + (PLOT_BASELINE - PLOT_TOP) / 3,
        PLOT_TOP + (2 * (PLOT_BASELINE - PLOT_TOP)) / 3,
        PLOT_BASELINE,
      ].map((percent) => (
        <line
          key={percent}
          x1="40"
          x2="960"
          y1={percent * 1.8}
          y2={percent * 1.8}
          className="series-grid"
        />
      ))}
      <SeriesMarks points={points} view={view} gradientId={gradientId} />
      {selected && (
        <line x1={selected.x * 10} x2={selected.x * 10} y1="10" y2="168" className="series-guide" />
      )}
    </svg>
  );
}

function PointSelectors({
  points,
  unit,
  label,
  selection,
}: {
  points: PositionedSeriesDatum[];
  unit: Result["unit"];
  label: string;
  selection: Selection;
}) {
  return (
    <>
      {points.map((point) => (
        <button
          className="series-point"
          key={point.date}
          type="button"
          aria-label={`${formatDate(point.date)}，${label} ${formatChartValue(point.value, unit)}`}
          aria-pressed={point.date === selection.pinned}
          style={{ left: `${point.x}%`, top: `${point.y}%` }}
          onFocus={() => selection.preview(point.date)}
          onBlur={selection.clearPreview}
          onMouseEnter={() => selection.preview(point.date)}
          onMouseLeave={selection.clearPreview}
          onClick={() => selection.toggle(point.date)}
        >
          <i />
        </button>
      ))}
    </>
  );
}

function DenseSelector({
  points,
  selected,
  unit,
  selection,
}: {
  points: PositionedSeriesDatum[];
  selected?: PositionedSeriesDatum;
  unit: Result["unit"];
  selection: Selection;
}) {
  return (
    <div className="series-dense-selector">
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
            ? `${formatDate(selected.date)}，${formatChartValue(selected.value, unit)}`
            : "暂无数据"
        }
        onChange={(event) => selection.select(points[Number(event.target.value)]?.date)}
      />
      <button type="button" onClick={() => selection.select(undefined)}>
        重置为最新日期
      </button>
    </div>
  );
}

function SeriesMarks({
  points,
  view,
  gradientId,
}: {
  points: PositionedSeriesDatum[];
  view: SeriesView;
  gradientId: string;
}) {
  const line = points.map(({ x, y }) => `${x * 10},${y * 1.8}`).join(" ");
  if (view === "bar")
    return (
      <>
        {points.map((point) => (
          <rect
            key={point.date}
            data-date={point.date}
            x={point.x * 10 - 8}
            y={point.y * 1.8}
            width="16"
            height={(PLOT_BASELINE - point.y) * 1.8}
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
          points={`${points[0]!.x * 10},${PLOT_BASELINE * 1.8} ${line} ${points.at(-1)!.x * 10},${PLOT_BASELINE * 1.8}`}
          fill={`url(#${gradientId})`}
        />
      )}
      <polyline points={line} className="series-line" />
    </>
  );
}

function ValueAxis({ maximum, unit }: { maximum: number; unit: Result["unit"] }) {
  return (
    <div className="series-value-axis" aria-label={`${unitLabel(unit)}纵轴`}>
      {[1, 2 / 3, 1 / 3, 0].map((ratio) => (
        <span
          key={ratio}
          style={{ top: `${PLOT_TOP + (1 - ratio) * (PLOT_BASELINE - PLOT_TOP)}%` }}
        >
          {formatChartValue(maximum * ratio, unit)}
        </span>
      ))}
    </div>
  );
}
function DateAxis({ points }: { points: PositionedSeriesDatum[] }) {
  return (
    <div className="series-axis" aria-hidden="true">
      {tickPoints(points).map((point) => (
        <span
          key={point.date}
          style={{ left: `${point.x}%` }}
        >{`${Number(point.date.slice(5, 7))}/${Number(point.date.slice(8))}`}</span>
      ))}
    </div>
  );
}
function tickPoints<T>(points: readonly T[]): T[] {
  const count = Math.min(5, points.length);
  return Array.from(
    new Set(
      Array.from({ length: count }, (_, i) =>
        Math.round((i * (points.length - 1)) / Math.max(1, count - 1)),
      ),
    ),
  )
    .map((i) => points[i]!)
    .filter(Boolean);
}
export function unitLabel(unit: Result["unit"]) {
  return unit === "currencyMinor" ? "金额 · 人民币元" : unit === "ratio" ? "比例" : "数量";
}
export function formatDate(date: string) {
  const [, month, day] = date.split("-");
  return `${Number(month)}月${Number(day)}日`;
}

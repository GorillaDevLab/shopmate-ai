"use client";

import type { DashboardChartView, DashboardInsightResult } from "@shopmate/contracts";

import { DonutChart } from "../analytics-charts";
import { CHANNEL_PALETTE, CURRENT_COLOR, OTHER_COLOR, formatShortDate } from "../analytics-model";
import {
  HitColumns,
  Tooltip,
  TooltipRow,
  XLabels,
  YAxis,
  linePath,
  niceMax,
  plot,
  round,
  useChartFocus,
  xAt,
  yAt,
  type Frame,
} from "../chart-kit";
import { formatAxisValue, formatValue } from "./explore-model";

type Series = Extract<DashboardInsightResult, { kind: "series" }>;
type Pie = Extract<DashboardInsightResult, { kind: "pie" }>;
type Report = Extract<DashboardInsightResult, { kind: "report" }>;

const FRAME: Frame = { width: 760, height: 280, left: 60, right: 8, top: 12, bottom: 28 };

export function ExploreChart({
  result,
  view,
}: {
  result: DashboardInsightResult;
  view: DashboardChartView;
}) {
  if (result.kind === "series") return <SeriesChart result={result} view={view} />;
  if (result.kind === "report") return <ReportView result={result} />;
  return view === "pie" ? <PieView result={result} /> : <RankedBars result={result} />;
}

function SeriesChart({ result, view }: { result: Series; view: DashboardChartView }) {
  const values = result.points.map((point) => point.value);
  const focus = useChartFocus(values.length);
  const max = niceMax(Math.max(0, ...values));
  const { x0, x1, y1 } = plot(FRAME);
  const i = focus.index;
  return (
    <div
      className="chart-frame"
      tabIndex={0}
      role="group"
      aria-label={`${result.title}；方向键查看每天数值`}
      onKeyDown={focus.onKeyDown}
      onBlur={() => focus.setIndex(null)}
    >
      <svg viewBox={`0 0 ${FRAME.width} ${FRAME.height}`} aria-hidden="true">
        <YAxis max={max} frame={FRAME} format={(tick) => formatAxisValue(tick, result.unit)} />
        {view === "bar" ? (
          <SeriesBars values={values} max={max} focused={i} />
        ) : (
          <>
            {view === "area" && (
              <path
                d={`${linePath(values, max, FRAME)} L${x1} ${y1} L${x0} ${y1} Z`}
                fill={CURRENT_COLOR}
                fillOpacity={0.15}
              />
            )}
            <path d={linePath(values, max, FRAME)} className="chart-line" stroke={CURRENT_COLOR} />
          </>
        )}
        {i !== null && view !== "bar" && (
          <circle
            className="chart-point"
            cx={round(xAt(i, values.length, FRAME))}
            cy={round(yAt(values[i], max, FRAME))}
            r={4}
            stroke={CURRENT_COLOR}
          />
        )}
        <XLabels
          labels={result.points.map((point) => formatShortDate(point.date))}
          frame={FRAME}
          every={Math.max(1, Math.ceil(values.length / 6))}
        />
        <HitColumns count={values.length} frame={FRAME} onHover={focus.setIndex} />
      </svg>
      {i !== null && (
        <Tooltip x={xAt(i, values.length, FRAME)} frame={FRAME}>
          <TooltipRow
            color={CURRENT_COLOR}
            label={result.points[i].date}
            value={formatValue(values[i], result.unit)}
          />
        </Tooltip>
      )}
    </div>
  );
}

function SeriesBars({
  values,
  max,
  focused,
}: {
  values: readonly number[];
  max: number;
  focused: number | null;
}) {
  const { x0, x1, y1 } = plot(FRAME);
  const slot = (x1 - x0) / values.length;
  const width = Math.max(2, Math.min(24, slot - 2));
  return (
    <g>
      {values.map((value, index) => {
        const top = yAt(value, max, FRAME);
        const x = x0 + slot * index + (slot - width) / 2;
        return (
          <rect
            key={index}
            x={round(x)}
            y={round(top)}
            width={round(width)}
            height={round(y1 - top)}
            rx={Math.min(4, width / 2)}
            fill={CURRENT_COLOR}
            className={focused !== null && focused !== index ? "is-dimmed" : undefined}
          />
        );
      })}
    </g>
  );
}

/** 分组结果：颜色按类别在结果里的首次出现分配（结果已由服务端排序），超过色板的类别统一用灰色。 */
function PieView({ result }: { result: Pie }) {
  const total = result.slices.reduce((sum, slice) => sum + slice.value, 0);
  const slices = result.slices.map((slice, index) => ({
    id: slice.key,
    name: slice.label,
    value: slice.value,
    color: CHANNEL_PALETTE[index] ?? OTHER_COLOR,
  }));
  return (
    <div className="donut-layout explore-donut">
      <DonutChart
        slices={slices}
        total={total}
        label={`${result.title}，合计 ${formatValue(total, result.unit)}`}
        centerLabel={formatAxisValue(total, result.unit)}
      />
      <ul className="donut-legend">
        {slices.map((slice) => (
          <li key={slice.id}>
            <span className="swatch" style={{ background: slice.color }} aria-hidden="true" />
            <span className="channel-name">{slice.name}</span>
            <strong>{total ? ((slice.value / total) * 100).toFixed(1) : "0.0"}%</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RankedBars({ result }: { result: Pie }) {
  const max = Math.max(1, ...result.slices.map((slice) => slice.value));
  return (
    <ol className="explore-bars">
      {result.slices.map((slice) => (
        <li key={slice.key}>
          <span className="explore-bar-label">{slice.label}</span>
          <span className="explore-bar-track">
            <span
              className="hbar"
              style={{ width: `${(slice.value / max) * 100}%`, background: CURRENT_COLOR }}
            />
          </span>
          <strong>{formatValue(slice.value, result.unit)}</strong>
        </li>
      ))}
    </ol>
  );
}

function ReportView({ result }: { result: Report }) {
  return (
    <div className="explore-report">
      {result.metrics.length > 0 && (
        <dl className="explore-report-metrics">
          {result.metrics.map((metric) => (
            <div key={metric.label}>
              <dt>{metric.label}</dt>
              <dd>{metric.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {result.highlights.length > 0 && (
        <ul className="explore-report-highlights">
          {result.highlights.map((highlight) => (
            <li key={highlight}>{highlight}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

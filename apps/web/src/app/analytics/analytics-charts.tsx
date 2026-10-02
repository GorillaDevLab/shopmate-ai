"use client";

import {
  CURRENT_COLOR,
  PREVIOUS_COLOR,
  formatShortDate,
  formatYuan,
  formatYuanShort,
  type WeekBucket,
} from "./analytics-model";
import {
  DataTable,
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
} from "./chart-kit";

const LINE_FRAME: Frame = { width: 360, height: 210, left: 48, right: 8, top: 10, bottom: 28 };
const WIDE_FRAME: Frame = { width: 760, height: 240, left: 52, right: 8, top: 10, bottom: 28 };

export function Sparkline({ values }: { values: readonly number[] }) {
  const frame: Frame = { width: 96, height: 32, left: 2, right: 2, top: 4, bottom: 4 };
  const min = Math.min(...values);
  const shifted = values.map((value) => value - min);
  const max = Math.max(...shifted) || 1;
  return (
    <svg className="sparkline" viewBox="0 0 96 32" preserveAspectRatio="none" aria-hidden="true">
      <path d={linePath(shifted, max, frame)} stroke={CURRENT_COLOR} />
    </svg>
  );
}

type SeriesPoint = { date: string; value: number };

export function ComparisonLineChart({
  current,
  previous,
}: {
  current: readonly SeriesPoint[];
  previous: readonly SeriesPoint[];
}) {
  const focus = useChartFocus(current.length);
  const max = niceMax(Math.max(...current.map((p) => p.value), ...previous.map((p) => p.value)));
  const values = current.map((p) => p.value);
  const { y1, x0, x1 } = plot(LINE_FRAME);
  const area = `${linePath(values, max, LINE_FRAME)} L${x1} ${y1} L${x0} ${y1} Z`;
  const i = focus.index;
  return (
    <div
      className="chart-frame"
      tabIndex={0}
      role="group"
      aria-label="每日销售额，本期与上一周期对比；方向键查看每天数值"
      onKeyDown={focus.onKeyDown}
      onBlur={() => focus.setIndex(null)}
    >
      <svg viewBox={`0 0 ${LINE_FRAME.width} ${LINE_FRAME.height}`} aria-hidden="true">
        <YAxis max={max} frame={LINE_FRAME} />
        <path d={area} fill={CURRENT_COLOR} fillOpacity={0.07} />
        <path
          d={linePath(
            previous.map((p) => p.value),
            max,
            LINE_FRAME,
          )}
          className="chart-line is-previous"
          stroke={PREVIOUS_COLOR}
        />
        <path d={linePath(values, max, LINE_FRAME)} className="chart-line" stroke={CURRENT_COLOR} />
        {i !== null && (
          <Crosshair
            index={i}
            count={values.length}
            values={[values[i], previous[i]?.value ?? 0]}
            max={max}
            frame={LINE_FRAME}
          />
        )}
        <XLabels
          labels={current.map((p) => formatShortDate(p.date))}
          frame={LINE_FRAME}
          every={Math.ceil(current.length / 4)}
        />
        <HitColumns count={current.length} frame={LINE_FRAME} onHover={focus.setIndex} />
      </svg>
      {i !== null && (
        <Tooltip x={xAt(i, current.length, LINE_FRAME)} frame={LINE_FRAME}>
          <TooltipRow
            color={CURRENT_COLOR}
            label={formatShortDate(current[i].date)}
            value={formatYuan(current[i].value)}
          />
          {previous[i] && (
            <TooltipRow
              color={PREVIOUS_COLOR}
              dashed
              label={formatShortDate(previous[i].date)}
              value={formatYuan(previous[i].value)}
            />
          )}
        </Tooltip>
      )}
      <DataTable
        caption="每日销售额"
        head={["本期日期", "本期销售额", "上一周期日期", "上一周期销售额"]}
        rows={current.map((p, index) => [
          p.date,
          formatYuan(p.value),
          previous[index]?.date ?? "",
          formatYuan(previous[index]?.value ?? 0),
        ])}
      />
    </div>
  );
}

function Crosshair({
  index,
  count,
  values,
  max,
  frame,
}: {
  index: number;
  count: number;
  values: readonly [number, number];
  max: number;
  frame: Frame;
}) {
  const x = round(xAt(index, count, frame));
  const { y0, y1 } = plot(frame);
  return (
    <g className="chart-crosshair">
      <line x1={x} x2={x} y1={y0} y2={y1} />
      <circle cx={x} cy={round(yAt(values[1], max, frame))} r={3.5} stroke={PREVIOUS_COLOR} />
      <circle cx={x} cy={round(yAt(values[0], max, frame))} r={4} stroke={CURRENT_COLOR} />
    </g>
  );
}

export function WeeklyBarChart({ weeks }: { weeks: readonly WeekBucket[] }) {
  const focus = useChartFocus(weeks.length);
  const max = niceMax(Math.max(...weeks.flatMap((week) => [week.current, week.previous])));
  const { x0, x1 } = plot(LINE_FRAME);
  const slot = (x1 - x0) / weeks.length;
  const bar = Math.min(18, slot / 2 - 4);
  const i = focus.index;
  return (
    <div
      className="chart-frame"
      tabIndex={0}
      role="group"
      aria-label="每周销售额，本期与上一周期对比；方向键查看每周数值"
      onKeyDown={focus.onKeyDown}
      onBlur={() => focus.setIndex(null)}
    >
      <svg viewBox={`0 0 ${LINE_FRAME.width} ${LINE_FRAME.height}`} aria-hidden="true">
        <YAxis max={max} frame={LINE_FRAME} />
        {weeks.map((week, index) => {
          const center = x0 + slot * index + slot / 2;
          return (
            <g key={week.label} className={i !== null && i !== index ? "is-dimmed" : undefined}>
              <Bar
                x={center - bar - 1}
                width={bar}
                value={week.current}
                max={max}
                color={CURRENT_COLOR}
              />
              <Bar
                x={center + 1}
                width={bar}
                value={week.previous}
                max={max}
                color={PREVIOUS_COLOR}
              />
              <text
                className="chart-axis-text"
                x={round(center)}
                y={LINE_FRAME.height - 10}
                textAnchor="middle"
              >
                {week.label}
              </text>
            </g>
          );
        })}
        <HitColumns count={weeks.length} frame={{ ...LINE_FRAME }} onHover={focus.setIndex} />
      </svg>
      {i !== null && (
        <Tooltip x={x0 + slot * i + slot / 2} frame={LINE_FRAME}>
          <p className="chart-tooltip-title">{weeks[i].label}</p>
          <TooltipRow color={CURRENT_COLOR} label="本期" value={formatYuan(weeks[i].current)} />
          <TooltipRow
            color={PREVIOUS_COLOR}
            label="上一周期"
            value={formatYuan(weeks[i].previous)}
          />
        </Tooltip>
      )}
      <DataTable
        caption="每周销售额"
        head={["周", "本期", "上一周期"]}
        rows={weeks.map((week) => [
          week.label,
          formatYuan(week.current),
          formatYuan(week.previous),
        ])}
      />
    </div>
  );
}

/** 顶端 4px 圆角、底端贴住基线的柱子。 */
function Bar({
  x,
  width,
  value,
  max,
  color,
}: {
  x: number;
  width: number;
  value: number;
  max: number;
  color: string;
}) {
  const { y1 } = plot(LINE_FRAME);
  const top = yAt(value, max, LINE_FRAME);
  const height = y1 - top;
  if (height <= 0) return null;
  const r = Math.min(4, height, width / 2);
  const d = `M${round(x)} ${y1} V${round(top + r)} Q${round(x)} ${round(top)} ${round(x + r)} ${round(top)} H${round(x + width - r)} Q${round(x + width)} ${round(top)} ${round(x + width)} ${round(top + r)} V${y1} Z`;
  return <path d={d} fill={color} />;
}

export type Slice = { id: string; name: string; value: number; color: string };

export function DonutChart({
  slices,
  total,
  label,
  centerLabel = formatYuanShort(total),
}: {
  slices: readonly Slice[];
  total: number;
  label: string;
  centerLabel?: string;
}) {
  const size = 168;
  const radius = size / 2 - 18;
  const circumference = 2 * Math.PI * radius;
  const lengths = slices.map((slice) => (total ? (slice.value / total) * circumference : 0));
  const offsets = lengths.map((_, i) => lengths.slice(0, i).reduce((sum, value) => sum + value, 0));
  return (
    <svg className="donut" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
      {slices.map((slice, i) => {
        // 相邻扇区之间留 2px 表面间隙，靠形状而不只靠颜色区分。
        const dash = Math.max(0, lengths[i] - 2);
        return (
          <circle
            key={slice.id}
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={slice.color}
            strokeWidth={24}
            strokeDasharray={`${round(dash)} ${round(circumference - dash)}`}
            strokeDashoffset={round(-offsets[i])}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        );
      })}
      <text x={size / 2} y={size / 2 + 6} textAnchor="middle" className="donut-total">
        {centerLabel}
      </text>
    </svg>
  );
}

export type StackSeries = { id: string; name: string; color: string; values: readonly number[] };

export function StackedAreaChart({
  dates,
  series,
}: {
  dates: readonly string[];
  series: readonly StackSeries[];
}) {
  const focus = useChartFocus(dates.length);
  const totals = dates.map((_, i) => series.reduce((sum, s) => sum + s.values[i], 0));
  const max = niceMax(Math.max(...totals));
  const layers = stackLayers(series, dates.length, max);
  const i = focus.index;
  return (
    <div
      className="chart-frame"
      tabIndex={0}
      role="group"
      aria-label="各渠道每日销售额堆叠图；方向键查看每天构成"
      onKeyDown={focus.onKeyDown}
      onBlur={() => focus.setIndex(null)}
    >
      <svg viewBox={`0 0 ${WIDE_FRAME.width} ${WIDE_FRAME.height}`} aria-hidden="true">
        <YAxis max={max} frame={WIDE_FRAME} />
        {layers.map((layer) => (
          <path
            key={layer.id}
            d={layer.d}
            fill={layer.color}
            fillOpacity={0.85}
            className="chart-area"
          />
        ))}
        {i !== null && (
          <line
            className="chart-crosshair-line"
            x1={round(xAt(i, dates.length, WIDE_FRAME))}
            x2={round(xAt(i, dates.length, WIDE_FRAME))}
            y1={plot(WIDE_FRAME).y0}
            y2={plot(WIDE_FRAME).y1}
          />
        )}
        <XLabels labels={dates.map(formatShortDate)} frame={WIDE_FRAME} every={7} />
        <HitColumns count={dates.length} frame={WIDE_FRAME} onHover={focus.setIndex} />
      </svg>
      {i !== null && (
        <Tooltip x={xAt(i, dates.length, WIDE_FRAME)} frame={WIDE_FRAME}>
          <p className="chart-tooltip-title">
            {formatShortDate(dates[i])} · 合计 {formatYuan(totals[i])}
          </p>
          {[...series].reverse().map((s) => (
            <TooltipRow key={s.id} color={s.color} label={s.name} value={formatYuan(s.values[i])} />
          ))}
        </Tooltip>
      )}
      <DataTable
        caption="各渠道每日销售额"
        head={["日期", ...series.map((s) => s.name)]}
        rows={dates.map((date, index) => [date, ...series.map((s) => formatYuan(s.values[index]))])}
      />
    </div>
  );
}

function stackLayers(series: readonly StackSeries[], count: number, max: number) {
  const base = new Array<number>(count).fill(0);
  return series.map((s) => {
    const lower = [...base];
    s.values.forEach((value, i) => (base[i] += value));
    const top = base.map(
      (value, i) =>
        `${i ? "L" : "M"}${round(xAt(i, count, WIDE_FRAME))} ${round(yAt(value, max, WIDE_FRAME))}`,
    );
    const bottom = lower
      .map(
        (value, i) => `L${round(xAt(i, count, WIDE_FRAME))} ${round(yAt(value, max, WIDE_FRAME))}`,
      )
      .reverse();
    return { id: s.id, color: s.color, d: `${top.join(" ")} ${bottom.join(" ")} Z` };
  });
}

"use client";

import { useState, type KeyboardEvent, type ReactNode } from "react";

import { formatYuanShort } from "./analytics-model";

export type Frame = {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
};

export function plot(frame: Frame) {
  return {
    x0: frame.left,
    x1: frame.width - frame.right,
    y0: frame.top,
    y1: frame.height - frame.bottom,
  };
}

/** 把最大值向上取到 1/2/2.5/5×10ⁿ，得到 2 段等分的整齐刻度。 */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= value) ?? 10;
  return step * magnitude;
}

export function xAt(index: number, count: number, frame: Frame): number {
  const { x0, x1 } = plot(frame);
  return count <= 1 ? (x0 + x1) / 2 : x0 + (index * (x1 - x0)) / (count - 1);
}

export function yAt(value: number, max: number, frame: Frame): number {
  const { y0, y1 } = plot(frame);
  return y1 - (value / max) * (y1 - y0);
}

export function linePath(values: readonly number[], max: number, frame: Frame): string {
  return values
    .map(
      (value, i) =>
        `${i ? "L" : "M"}${round(xAt(i, values.length, frame))} ${round(yAt(value, max, frame))}`,
    )
    .join(" ");
}

export function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export function YAxis({ max, frame }: { max: number; frame: Frame }) {
  const { x0, x1 } = plot(frame);
  return (
    <g className="chart-axis">
      {[0, max / 2, max].map((tick) => {
        const y = round(yAt(tick, max, frame));
        return (
          <g key={tick}>
            <line x1={x0} x2={x1} y1={y} y2={y} className="chart-grid" />
            <text x={x0 - 8} y={y + 4} textAnchor="end">
              {tick === 0 ? "¥0" : formatYuanShort(tick)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

export function XLabels({
  labels,
  frame,
  every,
}: {
  labels: readonly string[];
  frame: Frame;
  every: number;
}) {
  const y = frame.height - frame.bottom + 18;
  return (
    <g className="chart-axis">
      {labels.map((label, i) => {
        const last = i === labels.length - 1;
        if (i % every !== 0 && !last) return null;
        if (!last && labels.length - 1 - i < every / 2) return null;
        const anchor = i === 0 ? "start" : last ? "end" : "middle";
        return (
          <text key={label + i} x={round(xAt(i, labels.length, frame))} y={y} textAnchor={anchor}>
            {label}
          </text>
        );
      })}
    </g>
  );
}

/** 悬停/键盘选中的数据点；方向键在点之间移动，Esc 取消。 */
export function useChartFocus(count: number) {
  const [index, setIndex] = useState<number | null>(null);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") return setIndex(null);
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    setIndex((current) =>
      Math.min(count - 1, Math.max(0, (current ?? (step > 0 ? -1 : count)) + step)),
    );
  };
  return { index, setIndex, onKeyDown };
}

export function HitColumns({
  count,
  frame,
  onHover,
}: {
  count: number;
  frame: Frame;
  onHover: (index: number | null) => void;
}) {
  const { x0, x1, y0, y1 } = plot(frame);
  const width = (x1 - x0) / count;
  return (
    <g onMouseLeave={() => onHover(null)}>
      {Array.from({ length: count }, (_, i) => (
        <rect
          key={i}
          x={x0 + i * width}
          y={y0}
          width={width}
          height={y1 - y0}
          fill="transparent"
          onMouseEnter={() => onHover(i)}
        />
      ))}
    </g>
  );
}

export function Tooltip({ x, frame, children }: { x: number; frame: Frame; children: ReactNode }) {
  const percent = (x / frame.width) * 100;
  const side = percent > 60 ? { right: `${100 - percent + 2}%` } : { left: `${percent + 2}%` };
  return (
    <div className="chart-tooltip" style={side} role="presentation">
      {children}
    </div>
  );
}

export function TooltipRow({
  color,
  label,
  value,
  dashed = false,
}: {
  color: string;
  label: string;
  value: string;
  dashed?: boolean;
}) {
  return (
    <div className="chart-tooltip-row">
      <span
        className={`chart-key${dashed ? " is-dashed" : ""}`}
        style={{ color }}
        aria-hidden="true"
      />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

/** 每个图表都附带可读的数据表，屏幕阅读器与无法分辨颜色的用户都能拿到同样的数字。 */
export function DataTable({
  caption,
  head,
  rows,
}: {
  caption: string;
  head: readonly string[];
  rows: readonly (readonly string[])[];
}) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {head.map((cell) => (
            <th key={cell} scope="col">
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.join("|")}>
            {row.map((cell, i) => (
              <td key={i}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

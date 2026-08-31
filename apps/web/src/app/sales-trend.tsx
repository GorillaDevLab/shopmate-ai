import type { AnalyticsDashboardResponse } from "@shopmate/contracts";

import { formatMoneyMinor } from "./metric-format";

type TrendPoint = AnalyticsDashboardResponse["trend"][number];

export function SalesTrend({ points }: { points: readonly TrendPoint[] }) {
  const chartPoints = createChartPoints(points);
  const accessibleName = `近 ${points.length} 天销售趋势图`;

  return (
    <section className="min-w-0 rounded-3xl border border-app-line bg-app-surface p-5 lg:p-4">
      <PanelHeading detail={`近 ${points.length} 天`} />
      <svg
        className="mt-5 h-44 w-full overflow-visible lg:mt-3 lg:h-32"
        viewBox="0 0 640 180"
        role="img"
        aria-label={accessibleName}
        preserveAspectRatio="none"
      >
        <ChartGrid />
        <polyline
          points={chartPoints.map(({ x, y }) => `${x},${y}`).join(" ")}
          fill="none"
          stroke="var(--brand)"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {chartPoints.map((point) => (
          <circle
            key={point.date}
            cx={point.x}
            cy={point.y}
            r="5"
            fill="white"
            stroke="var(--brand)"
            strokeWidth="3"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <ul
        className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 lg:mt-3 xl:grid-cols-7"
        aria-label="趋势明细"
      >
        {points.map((point) => (
          <li key={point.date} className="min-w-0 rounded-xl bg-app-bg px-3 py-2">
            <span className="text-app-muted">{formatDate(point.date)}</span>
            <strong className="mt-1 block break-all tabular-nums">
              {formatMoneyMinor(point.revenueMinor)}
            </strong>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PanelHeading({ detail }: { detail: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-xs font-bold tracking-[0.14em] text-app-subtle uppercase">本期表现</p>
        <h2 className="mt-2 text-xl font-black">销售趋势</h2>
      </div>
      <span className="rounded-full bg-[#eef0ff] px-3 py-1 text-xs font-bold text-brand">
        {detail}
      </span>
    </div>
  );
}

function ChartGrid() {
  return [20, 65, 110, 155].map((y) => (
    <line
      key={y}
      x1="16"
      x2="624"
      y1={y}
      y2={y}
      stroke="var(--app-line)"
      strokeWidth="1"
      vectorEffect="non-scaling-stroke"
    />
  ));
}

function createChartPoints(points: readonly TrendPoint[]) {
  const maximum = Math.max(1, ...points.map((point) => point.revenueMinor));
  const availableWidth = 608;
  return points.map((point, index) => ({
    ...point,
    x: points.length === 1 ? 320 : 16 + (index * availableWidth) / (points.length - 1),
    y: 155 - (point.revenueMinor / maximum) * 135,
  }));
}

function formatDate(date: string): string {
  const [, month, day] = date.split("-");
  return `${Number(month)}月${Number(day)}日`;
}

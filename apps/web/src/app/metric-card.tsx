import type { DashboardMetric } from "@shopmate/contracts";
import { formatMetricChange, formatMetricValue } from "./metric-format";

export type MetricCardState = "ready" | "loading" | "empty" | "error";
const labels = {
  sales: "销售额",
  orders: "订单",
  units: "销量",
  averageOrderValue: "客单价",
} satisfies Record<DashboardMetric["key"], string>;
const keys = ["sales", "orders", "units", "averageOrderValue"] as const;

export function MetricGrid({
  metrics,
  state = "ready",
  periodLabel = "近 7 天",
}: {
  metrics: readonly DashboardMetric[];
  state?: MetricCardState;
  periodLabel?: string;
}) {
  return (
    <section aria-label="经营指标" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {keys.map((key) => (
        <MetricCard
          key={key}
          state={state}
          periodLabel={periodLabel}
          metric={
            metrics.find((metric) => metric.key === key) ?? { key, value: null, changeRatio: null }
          }
        />
      ))}
    </section>
  );
}

export function MetricCard({
  metric,
  state = "ready",
  periodLabel = "近 7 天",
}: {
  metric: DashboardMetric;
  state?: MetricCardState;
  periodLabel?: string;
}) {
  const accessibleLabel = `${periodLabel}${labels[metric.key]}${state === "loading" ? "，正在加载" : ""}`;
  return (
    <article
      aria-label={accessibleLabel}
      aria-busy={state === "loading"}
      className="dashboard-panel"
    >
      <div className="flex items-center justify-between gap-2 text-sm text-app-muted">
        <h2>
          {periodLabel}
          {labels[metric.key]}
        </h2>
      </div>
      <div className="mt-3 min-h-20 lg:mt-2 lg:min-h-16" aria-live="polite">
        <MetricContent metric={metric} state={state} />
      </div>
    </article>
  );
}

function MetricContent({ metric, state }: { metric: DashboardMetric; state: MetricCardState }) {
  if (state === "loading") return <MetricSkeleton />;
  if (state === "error") return <p className="text-sm text-app-muted">指标加载失败</p>;
  if (state === "empty" || metric.value === null) {
    return <p className="text-sm text-app-muted">暂无数据</p>;
  }
  return (
    <>
      <p className="break-all text-3xl font-semibold tracking-tight tabular-nums">
        {formatMetricValue(metric)}
      </p>
      <MetricChange ratio={metric.changeRatio} />
    </>
  );
}

function MetricChange({ ratio }: { ratio: number | null }) {
  const color =
    ratio === null || ratio === 0 ? "text-app-muted" : ratio > 0 ? "text-positive" : "text-danger";
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <p className={`break-all font-bold tabular-nums ${color}`}>{formatMetricChange(ratio)}</p>
      <p className="text-app-muted">较上一周期</p>
    </div>
  );
}

function MetricSkeleton() {
  return (
    <>
      <span className="sr-only">正在加载指标</span>
      <div aria-hidden="true" className="space-y-3 motion-safe:animate-pulse">
        <div className="h-9 w-3/4 rounded-lg bg-app-line" />
        <div className="h-3 w-1/2 rounded bg-app-line" />
        <div className="h-3 w-1/3 rounded bg-app-line" />
      </div>
    </>
  );
}

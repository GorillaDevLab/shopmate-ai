"use client";

import type { AnalyticsChannel, AnalyticsOverviewResponse } from "@shopmate/contracts";

import { AppShell } from "../app-shell";
import { AppearanceAmbient } from "../appearance-controls";
import { DashboardRangeControls, type DashboardRange } from "../dashboard-range";
import {
  ComparisonLineChart,
  DonutChart,
  StackedAreaChart,
  WeeklyBarChart,
} from "./analytics-charts";
import { buildInsights } from "./analytics-insights";
import {
  CURRENT_COLOR,
  PREVIOUS_COLOR,
  channelColors,
  formatShortDate,
  formatYuan,
  formatYuanShort,
  isEmptyOverview,
  weeklyBuckets,
} from "./analytics-model";
import {
  Change,
  ChannelRanking,
  ChannelSplitCard,
  ChartCard,
  InsightCard,
  KpiTiles,
  ProductBars,
  SparkIcon,
} from "./analytics-panels";

export type OverviewState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: AnalyticsOverviewResponse }
  | { readonly status: "error"; readonly authRequired: boolean; readonly message: string };

type Ask = (question: string) => void;

type Props = {
  readonly state: OverviewState;
  readonly refreshing: boolean;
  readonly range: DashboardRange;
  readonly latestDate: string;
  readonly onRangeChange: (range: DashboardRange) => void;
  readonly onRetry: () => void;
  readonly onAsk: Ask;
};

export function AnalyticsView({
  state,
  refreshing,
  range,
  latestDate,
  onRangeChange,
  onRetry,
  onAsk,
}: Props) {
  const data = state.status === "ready" ? state.data : null;
  return (
    <AppShell active="analytics" notificationsEnabled={state.status === "ready"}>
      <AppearanceAmbient />
      <div
        className="analytics-page"
        id="main-content"
        aria-busy={state.status === "loading" || refreshing}
      >
        <header className="analytics-header">
          <h1>经营分析</h1>
          <button type="button" className="btn-primary" onClick={() => onAsk(NEW_CHART_PROMPT)}>
            <SparkIcon size={15} />
            新建 AI 图表
          </button>
        </header>
        <div className="analytics-filters">
          <DashboardRangeControls value={range} latestDate={latestDate} onChange={onRangeChange} />
          {data && (
            <p className="analytics-compare">
              对比上一周期：{formatShortDate(data.comparisonPeriod.startDate)}–
              {formatShortDate(data.comparisonPeriod.endDate)}
            </p>
          )}
        </div>
        <div className={refreshing ? "analytics-body is-refreshing" : "analytics-body"}>
          {state.status === "loading" && <LoadingState />}
          {state.status === "error" && <ErrorState state={state} onRetry={onRetry} />}
          {data &&
            (isEmptyOverview(data) ? <EmptyState /> : <Overview data={data} onAsk={onAsk} />)}
        </div>
      </div>
    </AppShell>
  );
}

const NEW_CHART_PROMPT = "帮我生成一张新的经营图表：";

function Overview({ data, onAsk }: { data: AnalyticsOverviewResponse; onAsk: Ask }) {
  const insights = buildInsights(data);
  return (
    <>
      {insights.length > 0 && (
        <InsightCard insights={insights} asOfDate={data.period.endDate} onAsk={onAsk} />
      )}
      <h2 className="analytics-section-title">经营总览</h2>
      <KpiTiles data={data} />
      <section className="analytics-grid" aria-label="经营图表">
        <SalesCard data={data} onAsk={onAsk} />
        <WeeklyCard data={data} onAsk={onAsk} />
        {data.channels.length > 0 ? (
          <ChannelCards data={data} onAsk={onAsk} />
        ) : (
          <ChartCard title="门店与店铺" className="span-2">
            <p className="card-note">
              还没有门店或店铺数据。给订单关联门店或线上店铺后，这里会显示各渠道的占比、排行和每日走势。
            </p>
          </ChartCard>
        )}
        <ChartCard
          title="商品销售额 Top 5"
          onAsk={() => onAsk("本期销售额前 5 的商品表现如何？哪些值得加推或补货？")}
        >
          {data.products.length ? (
            <>
              <ProductBars products={data.products} />
              <PeriodSwatches />
            </>
          ) : (
            <p className="card-note">本期没有商品销售。</p>
          )}
        </ChartCard>
        <button
          type="button"
          className="analytics-new-chart"
          onClick={() => onAsk(NEW_CHART_PROMPT)}
        >
          <span className="analytics-new-chart-icon">
            <SparkIcon size={18} />
          </span>
          <strong>让 AI 生成新图表</strong>
          <span>例如“对比各渠道的客单价”</span>
        </button>
      </section>
    </>
  );
}

function SalesCard({ data, onAsk }: { data: AnalyticsOverviewResponse; onAsk: Ask }) {
  const { current, previous } = data.totals;
  return (
    <ChartCard
      title="销售额"
      onAsk={() => onAsk("本期每日销售额走势有什么特点？和上一周期比哪几天差异最大？")}
    >
      <p className="card-headline">
        <strong>{formatYuan(current.revenueMinor)}</strong>
        <Change current={current.revenueMinor} previous={previous.revenueMinor} />
      </p>
      <ComparisonLineChart
        current={data.daily.map((day) => ({ date: day.date, value: day.revenueMinor }))}
        previous={data.previousDaily.map((day) => ({ date: day.date, value: day.revenueMinor }))}
      />
      <div className="chart-legend">
        <LineKey color={CURRENT_COLOR} label={periodText(data.period)} />
        <LineKey color={PREVIOUS_COLOR} label={periodText(data.comparisonPeriod)} dashed />
      </div>
    </ChartCard>
  );
}

function WeeklyCard({ data, onAsk }: { data: AnalyticsOverviewResponse; onAsk: Ask }) {
  const weeks = weeklyBuckets(data);
  const best = weeks.reduce((top, week) => (week.current > top.current ? week : top), weeks[0]);
  return (
    <ChartCard
      title="每周销售额"
      onAsk={() => onAsk("按周看，本期销售额和上一周期相比有什么变化？")}
    >
      <p className="card-headline">
        <strong>{formatYuanShort(best.current)}</strong>
        <span className="muted">最高周 · {best.label}</span>
      </p>
      <WeeklyBarChart weeks={weeks} />
      <PeriodSwatches />
    </ChartCard>
  );
}

function ChannelCards({ data, onAsk }: { data: AnalyticsOverviewResponse; onAsk: Ask }) {
  const colors = channelColors(data.channels);
  // 堆叠从下往上按销售额降序，最大的渠道贴着基线，读数最稳。
  const series = data.channels.map((channel) => ({
    id: channel.id,
    name: channel.name,
    color: colors.get(channel.id) ?? PREVIOUS_COLOR,
    values: channel.dailyRevenueMinor,
  }));
  return (
    <>
      <ShareCard channels={data.channels} colors={colors} onAsk={onAsk} />
      <ChartCard
        title="门店与店铺销售排行"
        onAsk={() => onAsk("各门店和线上店铺的销售额排行有什么变化？")}
      >
        <ChannelRanking channels={data.channels} colors={colors} />
      </ChartCard>
      <ChartCard
        title="各渠道每日销售额"
        className="span-2"
        onAsk={() => onAsk("各渠道每日销售额走势有什么差异？")}
      >
        <StackedAreaChart dates={data.daily.map((day) => day.date)} series={series} />
        <div className="chart-legend">
          {series.map((item) => (
            <Swatch key={item.id} color={item.color} label={item.name} />
          ))}
        </div>
      </ChartCard>
      <ChartCard
        title="线下门店与线上店铺"
        onAsk={() => onAsk("线下门店和线上店铺的销售额对比如何？")}
      >
        <ChannelSplitCard channels={data.channels} />
      </ChartCard>
    </>
  );
}

function ShareCard({
  channels,
  colors,
  onAsk,
}: {
  channels: readonly AnalyticsChannel[];
  colors: Map<string, string>;
  onAsk: Ask;
}) {
  const total = channels.reduce((sum, channel) => sum + channel.revenueMinor, 0);
  const slices = channels.map((channel) => ({
    id: channel.id,
    name: channel.name,
    value: channel.revenueMinor,
    color: colors.get(channel.id) ?? PREVIOUS_COLOR,
  }));
  const share = (value: number) => (total ? ((value / total) * 100).toFixed(1) : "0.0");
  return (
    <ChartCard title="各渠道销售额占比" onAsk={() => onAsk("各渠道的销售额占比说明了什么？")}>
      <div className="donut-layout">
        <DonutChart
          slices={slices}
          total={total}
          label={`各渠道销售额占比，合计 ${formatYuan(total)}`}
        />
        <ul className="donut-legend">
          {slices.map((slice) => (
            <li key={slice.id}>
              <span className="swatch" style={{ background: slice.color }} aria-hidden="true" />
              <span className="channel-name">{slice.name}</span>
              <strong>{share(slice.value)}%</strong>
            </li>
          ))}
        </ul>
      </div>
    </ChartCard>
  );
}

function periodText(period: { startDate: string; endDate: string }) {
  return `${formatShortDate(period.startDate)}–${formatShortDate(period.endDate)}`;
}

function LineKey({
  color,
  label,
  dashed = false,
}: {
  color: string;
  label: string;
  dashed?: boolean;
}) {
  return (
    <span className="legend-item">
      <span
        className={`chart-key${dashed ? " is-dashed" : ""}`}
        style={{ color }}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="legend-item">
      <span className="swatch" style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
  );
}

function PeriodSwatches() {
  return (
    <div className="chart-legend">
      <Swatch color={CURRENT_COLOR} label="本期" />
      <Swatch color={PREVIOUS_COLOR} label="上一周期" />
    </div>
  );
}

function LoadingState() {
  return (
    <div className="analytics-state" role="status" aria-live="polite">
      <div className="analytics-skeleton" aria-hidden="true">
        {Array.from({ length: 4 }, (_, i) => (
          <span key={i} />
        ))}
      </div>
      <p>正在整理你的经营数据…</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="analytics-state" role="status">
      <h2>还没有经营数据</h2>
      <p>导入第一批商品并产生订单后，这里会自动生成经营分析。</p>
    </div>
  );
}

function ErrorState({
  state,
  onRetry,
}: {
  state: Extract<OverviewState, { status: "error" }>;
  onRetry: () => void;
}) {
  return (
    <div className="analytics-state" role="alert">
      <h2>数据暂时加载失败</h2>
      <p>{state.authRequired ? "登录已失效，请重新登录后查看经营数据。" : state.message}</p>
      <div className="analytics-state-actions">
        {state.authRequired && (
          <a className="btn-primary" href="/login">
            重新登录
          </a>
        )}
        <button type="button" className="btn-secondary" onClick={onRetry}>
          重新加载
        </button>
      </div>
    </div>
  );
}

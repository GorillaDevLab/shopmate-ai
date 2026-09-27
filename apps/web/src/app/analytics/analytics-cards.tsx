"use client";

import {
  isAnalyticsAiCard,
  type AnalyticsCardId,
  type AnalyticsChannel,
  type AnalyticsLayoutCard,
  type AnalyticsOverviewResponse,
} from "@shopmate/contracts";
import Link from "next/link";
import type { ReactNode } from "react";

import {
  ComparisonLineChart,
  DonutChart,
  StackedAreaChart,
  WeeklyBarChart,
} from "./analytics-charts";
import { AiChartCard } from "./analytics-ai-card";
import { buildInsights } from "./analytics-insights";
import { CHANNEL_CARDS } from "./analytics-layout";
import {
  CURRENT_COLOR,
  PREVIOUS_COLOR,
  channelColors,
  formatShortDate,
  formatYuan,
  formatYuanShort,
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

export const EXPLORE_HREF = "/analytics/explore";

type Ask = (question: string) => void;

export type CardContext = {
  readonly data: AnalyticsOverviewResponse;
  readonly onAsk: Ask;
  /** 没有渠道数据时，只在第一张可见的渠道卡位置显示说明，其余渠道卡不渲染。 */
  readonly noChannelsNoteAt: AnalyticsCardId | null;
};

/** 返回 null 表示这张卡在当前数据下没有内容（编辑模式会显示占位）。 */
export function renderCard(card: AnalyticsLayoutCard, context: CardContext): ReactNode {
  const { data, onAsk } = context;
  if (isAnalyticsAiCard(card))
    return <AiChartCard card={card} period={data.period} onAsk={onAsk} />;
  const { id } = card;
  if (context.noChannelsNoteAt !== null && CHANNEL_CARDS.includes(id)) {
    return id === context.noChannelsNoteAt ? <NoChannelsCard /> : null;
  }
  switch (id) {
    case "insights":
      return <Insights data={data} onAsk={onAsk} />;
    case "kpis":
      return (
        <section className="analytics-kpis" aria-label="经营总览">
          <h2 className="analytics-section-title">经营总览</h2>
          <KpiTiles data={data} />
        </section>
      );
    case "sales":
      return <SalesCard data={data} onAsk={onAsk} />;
    case "weekly":
      return <WeeklyCard data={data} onAsk={onAsk} />;
    case "products":
      return <ProductsCard data={data} onAsk={onAsk} />;
    case "newChart":
      return <NewChartCard />;
    default:
      return <ChannelCard id={id} data={data} onAsk={onAsk} />;
  }
}

function Insights({ data, onAsk }: { data: AnalyticsOverviewResponse; onAsk: Ask }) {
  const insights = buildInsights(data);
  if (!insights.length) return null;
  return <InsightCard insights={insights} asOfDate={data.period.endDate} onAsk={onAsk} />;
}

function NoChannelsCard() {
  return (
    <ChartCard title="门店与店铺">
      <p className="card-note">
        还没有门店或店铺数据。给订单关联门店或线上店铺后，这里会显示各渠道的占比、排行和每日走势。
      </p>
    </ChartCard>
  );
}

function ProductsCard({ data, onAsk }: { data: AnalyticsOverviewResponse; onAsk: Ask }) {
  return (
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
  );
}

function NewChartCard() {
  return (
    <Link className="analytics-new-chart" href={EXPLORE_HREF}>
      <span className="analytics-new-chart-icon">
        <SparkIcon size={18} />
      </span>
      <strong>让 AI 生成新图表</strong>
      <span>例如“对比各渠道的客单价”</span>
    </Link>
  );
}

function ChannelCard({
  id,
  data,
  onAsk,
}: {
  id: AnalyticsCardId;
  data: AnalyticsOverviewResponse;
  onAsk: Ask;
}) {
  const colors = channelColors(data.channels);
  if (id === "channelShare")
    return <ShareCard channels={data.channels} colors={colors} onAsk={onAsk} />;
  if (id === "channelRanking") {
    return (
      <ChartCard
        title="门店与店铺销售排行"
        onAsk={() => onAsk("各门店和线上店铺的销售额排行有什么变化？")}
      >
        <ChannelRanking channels={data.channels} colors={colors} />
      </ChartCard>
    );
  }
  if (id === "channelDaily") return <DailyChannelsCard data={data} colors={colors} onAsk={onAsk} />;
  return (
    <ChartCard
      title="线下门店与线上店铺"
      onAsk={() => onAsk("线下门店和线上店铺的销售额对比如何？")}
    >
      <ChannelSplitCard channels={data.channels} />
    </ChartCard>
  );
}

function DailyChannelsCard({
  data,
  colors,
  onAsk,
}: {
  data: AnalyticsOverviewResponse;
  colors: Map<string, string>;
  onAsk: Ask;
}) {
  // 堆叠从下往上按销售额降序，最大的渠道贴着基线，读数最稳。
  const series = data.channels.map((channel) => ({
    id: channel.id,
    name: channel.name,
    color: colors.get(channel.id) ?? PREVIOUS_COLOR,
    values: channel.dailyRevenueMinor,
  }));
  return (
    <ChartCard title="各渠道每日销售额" onAsk={() => onAsk("各渠道每日销售额走势有什么差异？")}>
      <StackedAreaChart dates={data.daily.map((day) => day.date)} series={series} />
      <div className="chart-legend">
        {series.map((item) => (
          <Swatch key={item.id} color={item.color} label={item.name} />
        ))}
      </div>
    </ChartCard>
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

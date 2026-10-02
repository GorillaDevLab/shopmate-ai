"use client";

import type {
  AnalyticsChannel,
  AnalyticsOverviewResponse,
  AnalyticsProduct,
} from "@shopmate/contracts";
import { useState, type ReactNode } from "react";

import type { Insight } from "./analytics-insights";
import {
  CURRENT_COLOR,
  PREVIOUS_COLOR,
  changeRatio,
  channelSplit,
  formatChineseDate,
  formatPercent,
  formatYuan,
  formatYuanShort,
  type ChannelGroup,
} from "./analytics-model";
import { Sparkline } from "./analytics-charts";

export function Change({ current, previous }: { current: number; previous: number }) {
  const ratio = changeRatio(current, previous);
  if (ratio === null) return <span className="change is-flat">无对比</span>;
  const tone = ratio > 0 ? "is-up" : ratio < 0 ? "is-down" : "is-flat";
  const arrow = ratio > 0 ? "↗" : ratio < 0 ? "↘" : "→";
  return (
    <span className={`change ${tone}`}>
      <span aria-hidden="true">{arrow}</span>
      <span className="sr-only">{ratio > 0 ? "上升" : ratio < 0 ? "下降" : "持平"}</span>
      {formatPercent(ratio).replace("+", "")}
    </span>
  );
}

export function ChartCard({
  title,
  className = "",
  onAsk,
  children,
}: {
  title: string;
  className?: string;
  onAsk?: () => void;
  children: ReactNode;
}) {
  return (
    <article className={`analytics-card ${className}`} aria-label={title}>
      <div className="analytics-card-head">
        <h3 className="analytics-card-title">
          <span>{title}</span>
        </h3>
        {onAsk && (
          <button
            type="button"
            className="analytics-icon-button"
            aria-label={`${title}：问 AI`}
            onClick={onAsk}
          >
            <SparkIcon />
          </button>
        )}
      </div>
      {children}
    </article>
  );
}

const KPI = [
  { key: "revenue", label: "销售额", unit: "" },
  { key: "orders", label: "订单", unit: "单" },
  { key: "units", label: "销量", unit: "件" },
  { key: "aov", label: "客单价", unit: "" },
] as const;

export function KpiTiles({ data }: { data: AnalyticsOverviewResponse }) {
  const { current, previous } = data.totals;
  const aov = (t: typeof current) => (t.orders ? Math.round(t.revenueMinor / t.orders) : 0);
  const values = {
    revenue: [current.revenueMinor, previous.revenueMinor, data.daily.map((d) => d.revenueMinor)],
    orders: [current.orders, previous.orders, data.daily.map((d) => d.orders)],
    units: [current.units, previous.units, data.daily.map((d) => d.units)],
    aov: [
      aov(current),
      aov(previous),
      data.daily.map((d) => (d.orders ? d.revenueMinor / d.orders : 0)),
    ],
  } as const;
  return (
    <section className="kpi-grid" aria-label="经营指标">
      {KPI.map(({ key, label, unit }) => {
        const [now, before, series] = values[key];
        const money = key === "revenue" || key === "aov";
        return (
          <article key={key} className="analytics-card kpi-tile" aria-label={label}>
            <h3 className="analytics-card-title">
              <span>{label}</span>
            </h3>
            <div className="kpi-body">
              <p className="kpi-value">
                <strong>{money ? formatYuan(now) : now.toLocaleString("zh-CN")}</strong>
                {unit && <span className="kpi-unit">{unit}</span>}
                <Change current={now} previous={before} />
              </p>
              <Sparkline values={series} />
            </div>
          </article>
        );
      })}
    </section>
  );
}

export function InsightCard({
  insights,
  asOfDate,
  onAsk,
}: {
  insights: readonly Insight[];
  asOfDate: string;
  onAsk: (question: string) => void;
}) {
  const [selectedId, setSelectedId] = useState(insights[0]?.id);
  const selected = insights.find((insight) => insight.id === selectedId) ?? insights[0];
  if (!selected) return null;
  return (
    <section className="analytics-card insight-card" aria-label="经营洞察">
      <div className="insight-topics" role="tablist" aria-label="洞察列表">
        {insights.map((insight) => (
          <button
            key={insight.id}
            type="button"
            role="tab"
            aria-selected={insight.id === selected.id}
            onClick={() => setSelectedId(insight.id)}
          >
            <span aria-hidden="true" className={`insight-dot is-${insight.tone}`} />
            {insight.title}
          </button>
        ))}
      </div>
      <div className="insight-body" role="tabpanel">
        <div className="insight-copy">
          <p className="insight-meta">自动洞察 · {formatChineseDate(asOfDate)}</p>
          <p className="insight-title">{selected.title}</p>
          <p className="insight-detail">{selected.detail}</p>
          <button type="button" className="btn-secondary" onClick={() => onAsk(selected.question)}>
            问 AI 为什么
          </button>
        </div>
        <figure className="insight-chart">
          <Sparkline values={selected.series} />
          <figcaption>{selected.seriesLabel}</figcaption>
        </figure>
      </div>
    </section>
  );
}

export function ChannelRanking({
  channels,
  colors,
}: {
  channels: readonly AnalyticsChannel[];
  colors: Map<string, string>;
}) {
  return (
    <ol className="channel-ranking">
      {channels.map((channel) => (
        <li key={channel.id}>
          <span
            className="swatch"
            style={{ background: colors.get(channel.id) }}
            aria-hidden="true"
          />
          <span className="channel-name">{channel.name}</span>
          <strong>{formatYuan(channel.revenueMinor)}</strong>
          <Change current={channel.revenueMinor} previous={channel.previousRevenueMinor} />
        </li>
      ))}
    </ol>
  );
}

export function ProductBars({ products }: { products: readonly AnalyticsProduct[] }) {
  const max = Math.max(...products.flatMap((p) => [p.revenueMinor, p.previousRevenueMinor]), 1);
  return (
    <ol className="product-bars">
      {products.map((product) => (
        <li key={product.productId}>
          <span className="product-name">
            {product.name}
            <span className="muted"> · {product.units} 件</span>
          </span>
          <span className="product-bar-row">
            <span
              className="hbar"
              style={{ width: `${(product.revenueMinor / max) * 70}%`, background: CURRENT_COLOR }}
            />
            <strong>{formatYuanShort(product.revenueMinor)}</strong>
            <Change current={product.revenueMinor} previous={product.previousRevenueMinor} />
          </span>
          <span
            className="hbar"
            style={{
              width: `${(product.previousRevenueMinor / max) * 70}%`,
              background: PREVIOUS_COLOR,
            }}
            aria-label={`上一周期 ${formatYuan(product.previousRevenueMinor)}`}
            role="img"
          />
        </li>
      ))}
    </ol>
  );
}

export function ChannelSplitCard({ channels }: { channels: readonly AnalyticsChannel[] }) {
  const split = channelSplit(channels);
  if (!split) return <p className="card-note">需要同时有线下门店和线上店铺的数据才能对比。</p>;
  const total = split.offline.revenue + split.online.revenue || 1;
  const share = (group: ChannelGroup) => (group.revenue / total) * 100;
  return (
    <div className="channel-split">
      <div
        className="split-bar"
        role="img"
        aria-label={`线下 ${share(split.offline).toFixed(1)}%，线上 ${share(split.online).toFixed(1)}%`}
      >
        <span style={{ width: `${share(split.offline)}%`, background: CURRENT_COLOR }} />
        <span style={{ width: `${share(split.online)}%`, background: PREVIOUS_COLOR }} />
      </div>
      <div className="split-groups">
        <SplitGroup
          label="线下门店"
          color={CURRENT_COLOR}
          group={split.offline}
          share={share(split.offline)}
        />
        <SplitGroup
          label="线上店铺"
          color={PREVIOUS_COLOR}
          group={split.online}
          share={share(split.online)}
        />
      </div>
    </div>
  );
}

function SplitGroup({
  label,
  color,
  group,
  share,
}: {
  label: string;
  color: string;
  group: ChannelGroup;
  share: number;
}) {
  return (
    <div className="split-group">
      <span className="legend-item">
        <span className="swatch" style={{ background: color }} aria-hidden="true" />
        {label} · {share.toFixed(1)}%
      </span>
      <strong>{formatYuan(group.revenue)}</strong>
      <Change current={group.revenue} previous={group.previous} />
      <span className="muted">{group.names.join("、")}</span>
    </div>
  );
}

export function SparkIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="spark-icon" aria-hidden="true">
      <path d="m12 3 2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2Z" />
    </svg>
  );
}

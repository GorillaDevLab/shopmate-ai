import type { AnalyticsChannel, AnalyticsOverviewResponse } from "@shopmate/contracts";

import { changeRatio, formatPercent, formatYuan } from "./analytics-model";

export type Insight = {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  /** “问 AI 为什么”预填到助手草稿的问题。 */
  readonly question: string;
  readonly tone: "up" | "down" | "neutral";
  readonly series: readonly number[];
  readonly seriesLabel: string;
};

const WEEKEND_RATIO_THRESHOLD = 1.2;

/** 基于真实统计的规则洞察，不调用模型；每条都能从页面上的数字复核。 */
export function buildInsights(data: AnalyticsOverviewResponse): Insight[] {
  if (data.totals.current.orders === 0 && data.totals.previous.orders === 0) return [];
  return [
    totalInsight(data),
    channelGrowthInsight(data),
    productInsight(data),
    weekdayInsight(data),
  ]
    .filter((insight): insight is Insight => insight !== null)
    .slice(0, 4);
}

function totalInsight(data: AnalyticsOverviewResponse): Insight | null {
  const current = data.totals.current.revenueMinor;
  const previous = data.totals.previous.revenueMinor;
  if (previous === 0) return null;
  const delta = current - previous;
  const verb = delta >= 0 ? "多" : "少";
  const driver = largestContributor(data.channels, delta);
  const title = driver
    ? `本期销售额比上一周期${verb} ${formatYuan(Math.abs(delta))}，${delta >= 0 ? "增长" : "下降"}最多的是${driver.channel.name}`
    : `本期销售额比上一周期${verb} ${formatYuan(Math.abs(delta))}（${formatPercent(delta / previous)}）`;
  const detail = driver
    ? `${driver.channel.name}本期销售额 ${formatYuan(driver.channel.revenueMinor)}，比上一周期${verb} ${formatYuan(Math.abs(driver.delta))}，占全部变化额的 ${Math.round((driver.delta / delta) * 100)}%。`
    : `本期共 ${data.totals.current.orders} 笔订单，上一周期 ${data.totals.previous.orders} 笔。`;
  return {
    id: "total",
    title,
    detail,
    question: `为什么本期销售额比上一周期${verb}了 ${formatYuan(Math.abs(delta))}？${driver ? `${driver.channel.name}发生了什么变化？` : ""}`,
    tone: delta > 0 ? "up" : delta < 0 ? "down" : "neutral",
    series: driver ? driver.channel.dailyRevenueMinor : data.daily.map((day) => day.revenueMinor),
    seriesLabel: driver ? `${driver.channel.name}每日销售额` : "每日销售额",
  };
}

// 只有与总变化同向的渠道才算“贡献者”，避免把逆势渠道说成主因。
function largestContributor(channels: readonly AnalyticsChannel[], total: number) {
  if (channels.length < 2 || total === 0) return null;
  const candidates = channels
    .map((channel) => ({ channel, delta: channel.revenueMinor - channel.previousRevenueMinor }))
    .filter(({ delta }) => Math.sign(delta) === Math.sign(total))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return candidates[0] ?? null;
}

function channelGrowthInsight(data: AnalyticsOverviewResponse): Insight | null {
  const growing = data.channels
    .map((channel) => ({
      channel,
      ratio: changeRatio(channel.revenueMinor, channel.previousRevenueMinor),
    }))
    .filter(
      (item): item is { channel: AnalyticsChannel; ratio: number } =>
        item.ratio !== null && item.ratio > 0,
    )
    .sort((a, b) => b.ratio - a.ratio);
  if (!growing.length || growing.length === data.channels.length) return null;
  const best = growing[0];
  const title =
    growing.length === 1
      ? `${best.channel.name}是唯一环比增长的渠道`
      : `${growing.length} 个渠道环比增长，${best.channel.name}增幅最大`;
  return {
    id: "channel-growth",
    title,
    detail: `${best.channel.name}本期销售额 ${formatYuan(best.channel.revenueMinor)}，环比 ${formatPercent(best.ratio)}。`,
    question: `${best.channel.name}为什么能环比增长 ${formatPercent(best.ratio)}？其他渠道可以借鉴什么？`,
    tone: "up",
    series: best.channel.dailyRevenueMinor,
    seriesLabel: `${best.channel.name}每日销售额`,
  };
}

function productInsight(data: AnalyticsOverviewResponse): Insight | null {
  const ranked = data.products
    .map((product) => ({
      product,
      ratio: changeRatio(product.revenueMinor, product.previousRevenueMinor),
    }))
    .filter(
      (item): item is { product: (typeof data.products)[number]; ratio: number } =>
        item.ratio !== null,
    )
    .sort((a, b) => Math.abs(b.ratio) - Math.abs(a.ratio));
  const pick = ranked[0];
  if (!pick || pick.ratio === 0) return null;
  const up = pick.ratio > 0;
  return {
    id: "product",
    title: `${pick.product.name} 销售额${up ? "增长" : "下降"} ${formatPercent(Math.abs(pick.ratio)).slice(1)}`,
    detail: `本期卖出 ${pick.product.units} 件，销售额 ${formatYuan(pick.product.revenueMinor)}，上一周期 ${formatYuan(pick.product.previousRevenueMinor)}。`,
    question: `${pick.product.name}的销售额为什么${up ? "增长" : "下降"}了？需要调整库存或推广吗？`,
    tone: up ? "up" : "down",
    series: data.daily.map((day) => day.revenueMinor),
    seriesLabel: "每日销售额",
  };
}

function weekdayInsight(data: AnalyticsOverviewResponse): Insight | null {
  const weekend: number[] = [];
  const weekday: number[] = [];
  for (const day of data.daily) {
    const dow = new Date(`${day.date}T00:00:00Z`).getUTCDay();
    (dow === 0 || dow === 6 ? weekend : weekday).push(day.revenueMinor);
  }
  const average = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
  if (!weekend.length || !weekday.length) return null;
  const [weekendAvg, weekdayAvg] = [average(weekend), average(weekday)];
  if (weekendAvg === 0 || weekdayAvg === 0) return null;
  const ratio = weekendAvg / weekdayAvg;
  const weekendHigher = ratio >= 1;
  const multiple = weekendHigher ? ratio : 1 / ratio;
  if (multiple < WEEKEND_RATIO_THRESHOLD) return null;
  const [high, low] = weekendHigher ? ["周末", "工作日"] : ["工作日", "周末"];
  return {
    id: "weekday",
    title: `${high}日均销售额约为${low}的 ${multiple.toFixed(1)} 倍`,
    detail: `周末日均 ${formatYuan(Math.round(weekendAvg))}，工作日日均 ${formatYuan(Math.round(weekdayAvg))}。`,
    question: `${high}销售明显高于${low}，排班、备货和促销应该怎么安排？`,
    tone: "neutral",
    series: data.daily.map((day) => day.revenueMinor),
    seriesLabel: "每日销售额",
  };
}

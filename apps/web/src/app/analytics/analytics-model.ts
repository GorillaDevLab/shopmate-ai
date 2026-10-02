import type { AnalyticsChannel, AnalyticsOverviewResponse } from "@shopmate/contracts";

import { formatMoneyMinor } from "../metric-format";

/**
 * 分类色按 dataviz 校验脚本通过的顺序排列（相邻色在色弱与常规视觉下均可区分）。
 * 颜色跟随渠道本身（按 id 排序分配），不随排名变化。
 */
export const CHANNEL_PALETTE = [
  "#2a78d6",
  "#eb6834",
  "#1baf7a",
  "#eda100",
  "#e87ba4",
  "#008300",
  "#4a3aa7",
  "#e34948",
] as const;
export const OTHER_COLOR = "#8a8a8a";
export const CURRENT_COLOR = "#2a78d6";
export const PREVIOUS_COLOR = "#86b6ef";

export function changeRatio(current: number, previous: number): number | null {
  return previous === 0 ? null : (current - previous) / previous;
}

export function formatYuan(minor: number): string {
  return formatMoneyMinor(minor);
}

/** 图表轴与紧凑标签：万元以上用“万”，否则取整到元。 */
export function formatYuanShort(minor: number): string {
  const yuan = minor / 100;
  if (Math.abs(yuan) >= 10_000) return `¥${(yuan / 10_000).toFixed(1).replace(/\.0$/, "")}万`;
  return `¥${Math.round(yuan).toLocaleString("zh-CN")}`;
}

export function formatPercent(ratio: number): string {
  return `${ratio < 0 ? "−" : "+"}${Math.abs(ratio * 100).toFixed(1)}%`;
}

export function formatShortDate(date: string): string {
  const [, month, day] = date.split("-");
  return `${Number(month)}/${Number(day)}`;
}

export function formatChineseDate(date: string): string {
  const [year, month, day] = date.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}

export type WeekBucket = { label: string; current: number; previous: number };

/** 从周期首日起每 7 天一组；末尾不足 7 天的一组以起止日期标注。 */
export function weeklyBuckets(data: AnalyticsOverviewResponse): WeekBucket[] {
  const buckets: WeekBucket[] = [];
  for (let start = 0; start < data.daily.length; start += 7) {
    const days = data.daily.slice(start, start + 7);
    const previous = data.previousDaily.slice(start, start + 7);
    const first = formatShortDate(days[0].date);
    buckets.push({
      label: days.length === 7 ? `${first} 周` : `${first}–${formatShortDate(days.at(-1)!.date)}`,
      current: days.reduce((sum, day) => sum + day.revenueMinor, 0),
      previous: previous.reduce((sum, day) => sum + day.revenueMinor, 0),
    });
  }
  return buckets;
}

export function channelColors(channels: readonly AnalyticsChannel[]): Map<string, string> {
  const ids = channels.map((channel) => channel.id).sort();
  return new Map(ids.map((id, index) => [id, CHANNEL_PALETTE[index] ?? OTHER_COLOR]));
}

export type ChannelGroup = { revenue: number; previous: number; names: string[] };

/** 线下 = OFFLINE 平台；其余已知平台视为线上。任一组为空时返回 null，卡片改为说明。 */
export function channelSplit(channels: readonly AnalyticsChannel[]) {
  const group = (match: (channel: AnalyticsChannel) => boolean): ChannelGroup => {
    const list = channels.filter(match);
    return {
      revenue: list.reduce((sum, channel) => sum + channel.revenueMinor, 0),
      previous: list.reduce((sum, channel) => sum + channel.previousRevenueMinor, 0),
      names: list.map((channel) => channel.name),
    };
  };
  const offline = group((channel) => channel.platform === "OFFLINE");
  const online = group((channel) => channel.platform !== null && channel.platform !== "OFFLINE");
  if (!offline.names.length || !online.names.length) return null;
  return { offline, online };
}

export function isEmptyOverview(data: AnalyticsOverviewResponse): boolean {
  return data.totals.current.orders === 0 && data.totals.previous.orders === 0;
}

import type { AnalyticsOverviewResponse } from "@shopmate/contracts";

// 14 天测试夹具：2026-08-18（周二）起。周末销售额约为工作日的 1.5 倍。
const DAYS = 14;
const dates = Array.from({ length: DAYS }, (_, i) =>
  new Date(Date.UTC(2026, 7, 18 + i)).toISOString().slice(0, 10),
);
const previousDates = Array.from({ length: DAYS }, (_, i) =>
  new Date(Date.UTC(2026, 7, 4 + i)).toISOString().slice(0, 10),
);
const isWeekend = (date: string) => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
const daily = (weekdayMinor: number) =>
  dates.map((date) => (isWeekend(date) ? weekdayMinor * 1.5 : weekdayMinor));

const chaoyang = daily(40_000);
const xicheng = daily(30_000);
const xhs = daily(20_000);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

export function overviewFixture(
  patch: Partial<AnalyticsOverviewResponse> = {},
): AnalyticsOverviewResponse {
  const current = sum(chaoyang) + sum(xicheng) + sum(xhs);
  return {
    period: { startDate: dates[0], endDate: dates[DAYS - 1], days: DAYS },
    comparisonPeriod: { startDate: previousDates[0], endDate: previousDates[DAYS - 1], days: DAYS },
    totals: {
      current: { revenueMinor: current, orders: 140, units: 300 },
      previous: { revenueMinor: current + 50_000, orders: 142, units: 310 },
    },
    daily: dates.map((date, i) => ({
      date,
      revenueMinor: chaoyang[i] + xicheng[i] + xhs[i],
      orders: 10,
      units: 21,
    })),
    previousDaily: previousDates.map((date, i) => ({
      date,
      revenueMinor: chaoyang[i] + xicheng[i] + xhs[i] + (i === 0 ? 50_000 : 0),
    })),
    channels: [
      channel("s1", "北京朝阳店", "OFFLINE", chaoyang, sum(chaoyang) + 10_000),
      channel("s2", "北京西城店", "OFFLINE", xicheng, sum(xicheng) + 45_000),
      channel("s3", "小红书店", "XIAOHONGSHU", xhs, sum(xhs) - 5_000),
    ],
    products: [
      {
        productId: "p1",
        name: "304不锈钢保温杯",
        units: 108,
        revenueMinor: 3_756_200,
        previousRevenueMinor: 3_443_200,
      },
      {
        productId: "p2",
        name: "桌面静音小风扇",
        units: 101,
        revenueMinor: 3_651_200,
        previousRevenueMinor: 4_012_700,
      },
    ],
    ...patch,
  };
}

function channel(
  id: string,
  name: string,
  platform: string,
  series: number[],
  previousRevenueMinor: number,
) {
  return {
    id,
    name,
    platform,
    revenueMinor: sum(series),
    previousRevenueMinor,
    orders: 40,
    units: 90,
    dailyRevenueMinor: series,
  };
}

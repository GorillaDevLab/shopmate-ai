import { AnalyticsOverviewResponseSchema } from "@shopmate/contracts";
import { describe, expect, it } from "vitest";

import { overviewFixture } from "./analytics-fixture";
import { buildInsights } from "./analytics-insights";
import {
  CHANNEL_PALETTE,
  changeRatio,
  channelColors,
  channelSplit,
  formatPercent,
  formatYuanShort,
  isEmptyOverview,
  weeklyBuckets,
} from "./analytics-model";

describe("经营分析数据模型", () => {
  it("夹具本身符合接口契约", () => {
    expect(AnalyticsOverviewResponseSchema.safeParse(overviewFixture()).success).toBe(true);
  });

  it("上一周期为 0 时不计算环比", () => {
    expect(changeRatio(100, 0)).toBeNull();
    expect(changeRatio(90, 100)).toBeCloseTo(-0.1);
  });

  it("金额与百分比使用中文紧凑格式", () => {
    expect(formatYuanShort(46_358_370)).toBe("¥46.4万");
    expect(formatYuanShort(98_009)).toBe("¥980");
    expect(formatPercent(-0.0123)).toBe("−1.2%");
    expect(formatPercent(0.091)).toBe("+9.1%");
  });

  it("按 7 天分组，末尾不足一周时标注起止日期", () => {
    const data = overviewFixture();
    const trimmed = {
      ...data,
      daily: data.daily.slice(0, 9),
      previousDaily: data.previousDaily.slice(0, 9),
    };
    const weeks = weeklyBuckets(trimmed);
    expect(weeks.map((week) => week.label)).toEqual(["8/18 周", "8/25–8/26"]);
    expect(weeks[0].current).toBe(
      trimmed.daily.slice(0, 7).reduce((s, d) => s + d.revenueMinor, 0),
    );
  });

  it("渠道颜色跟随渠道 id，与排名无关", () => {
    const { channels } = overviewFixture();
    const colors = channelColors(channels);
    const reversed = channelColors([...channels].reverse());
    expect(colors.get("s2")).toBe(CHANNEL_PALETTE[1]);
    expect(reversed.get("s2")).toBe(colors.get("s2"));
  });

  it("线下/线上拆分只在两类渠道都存在时成立", () => {
    const { channels } = overviewFixture();
    const split = channelSplit(channels);
    expect(split?.offline.names).toEqual(["北京朝阳店", "北京西城店"]);
    expect(split?.online.names).toEqual(["小红书店"]);
    expect(channelSplit(channels.slice(0, 2))).toBeNull();
  });

  it("本期与上一周期都没有订单时视为空数据", () => {
    const empty = overviewFixture({
      totals: {
        current: { revenueMinor: 0, orders: 0, units: 0 },
        previous: { revenueMinor: 0, orders: 0, units: 0 },
      },
    });
    expect(isEmptyOverview(empty)).toBe(true);
    expect(buildInsights(empty)).toEqual([]);
  });
});

describe("规则洞察", () => {
  const insights = buildInsights(overviewFixture());
  const byId = Object.fromEntries(insights.map((insight) => [insight.id, insight]));

  it("总变化洞察指出与总变化同向、变化额最大的渠道", () => {
    expect(byId.total.title).toBe("本期销售额比上一周期少 ¥500.00，下降最多的是北京西城店");
    expect(byId.total.detail).toContain("占全部变化额的 90%");
    expect(byId.total.tone).toBe("down");
    expect(byId.total.question).toContain("北京西城店");
  });

  it("只有一个渠道增长时单独指出", () => {
    expect(byId["channel-growth"].title).toBe("小红书店是唯一环比增长的渠道");
  });

  it("商品洞察选择环比变化幅度最大的商品", () => {
    expect(byId.product.title).toBe("304不锈钢保温杯 销售额增长 9.1%");
  });

  it("周末与工作日差异达到阈值时给出倍数", () => {
    expect(byId.weekday.title).toBe("周末日均销售额约为工作日的 1.5 倍");
  });

  it("没有渠道数据时仍给出总变化洞察", () => {
    const noChannels = buildInsights(overviewFixture({ channels: [] }));
    expect(noChannels[0].title).toBe("本期销售额比上一周期少 ¥500.00（−3.4%）");
    expect(noChannels.some((insight) => insight.id === "channel-growth")).toBe(false);
  });
});

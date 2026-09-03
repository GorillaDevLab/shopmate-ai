import { describe, expect, it } from "vitest";

import { monitoringPeriod, nextRunAt } from "./monitoring-schedule.js";

describe("监听执行时钟", () => {
  it("按固定持续时间计算每日与每周下次执行", () => {
    const completedAt = new Date("2026-09-03T00:00:00.000Z");
    expect(nextRunAt("daily", completedAt)).toEqual(new Date("2026-09-04T00:00:00.000Z"));
    expect(nextRunAt("weekly", completedAt)).toEqual(new Date("2026-09-10T00:00:00.000Z"));
  });

  it("生成包含当天的规范化销售统计范围", () => {
    expect(monitoringPeriod("30d", new Date("2026-09-03T08:00:00.000Z"))).toEqual({
      startDate: "2026-08-05",
      endDate: "2026-09-03",
      periodStart: "2026-08-05T00:00:00.000Z",
      periodEnd: "2026-09-03T23:59:59.999Z",
    });
  });
});

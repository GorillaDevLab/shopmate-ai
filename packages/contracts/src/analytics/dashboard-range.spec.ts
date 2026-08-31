import { describe, expect, it } from "vitest";
import { AnalyticsDashboardQuerySchema } from "./dashboard-api.schema.js";

describe("看板自选时段", () => {
  it.each(["1000-01-01", "2023-01-02", "2026-08-01", "2026-08-02", "2026-08-25", "2026-08-31"])(
    "接受任意历史范围 %s",
    (startDate) => {
      expect(
        AnalyticsDashboardQuerySchema.safeParse({ asOfDate: "2026-08-31", startDate }).success,
      ).toBe(true);
    },
  );
  it.each(["2026-09-01", "2026-02-30", "", "0001-01-01"])("拒绝非法范围 %s", (startDate) => {
    expect(
      AnalyticsDashboardQuerySchema.safeParse({ asOfDate: "2026-08-31", startDate }).success,
    ).toBe(false);
  });
  it("保留默认七天并拒绝 scope 注入", () => {
    expect(AnalyticsDashboardQuerySchema.parse({ asOfDate: "2026-08-31" })).toEqual({
      asOfDate: "2026-08-31",
    });
    expect(
      AnalyticsDashboardQuerySchema.safeParse({
        asOfDate: "2026-08-31",
        startDate: "2026-08-02",
        merchantId: "other",
      }).success,
    ).toBe(false);
  });
});

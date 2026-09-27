import type { DashboardInsightQuery } from "@shopmate/contracts";
import { describe, expect, it } from "vitest";

import { applyConfig, formatAxisValue, isEmptyResult, resultRows } from "./explore-model";

const base: DashboardInsightQuery = {
  dataset: "sales",
  metric: "revenue",
  aggregation: "sum",
  groupBy: "store",
  dateRange: { start: "2026-08-02", end: "2026-08-31" },
  filters: [{ field: "platform", operator: "equals", values: ["TAOBAO"] }],
  order: "desc",
  limit: 8,
  visualization: "pie",
};

describe("applyConfig", () => {
  it("derives dataset and aggregation from the metric and clears stale filters", () => {
    const next = applyConfig(base, { metric: "averageOrderValue" });
    expect(next).toMatchObject({ aggregation: "average", groupBy: "store", filters: [] });
    // 平均值不适合饼图，自动切到柱状图。
    expect(next.visualization).toBe("bar");
  });

  it("falls back to the metric's first dimension when the grouping is not supported", () => {
    const next = applyConfig(base, { metric: "inventory" });
    expect(next).toMatchObject({ dataset: "inventory", groupBy: "product" });
  });

  it("switches to a time-series view when grouping by date", () => {
    expect(applyConfig(base, { groupBy: "date" }).visualization).toBe("line");
  });

  it("uses a text report when grouping is removed", () => {
    expect(applyConfig(base, { groupBy: null }).visualization).toBe("report");
  });

  it("keeps filters when only the view or range changes", () => {
    const next = applyConfig(base, { visualization: "bar" });
    expect(next.filters).toHaveLength(1);
    expect(next.visualization).toBe("bar");
  });
});

describe("result helpers", () => {
  it("formats rows by unit", () => {
    const rows = resultRows({
      kind: "pie",
      title: "t",
      summary: "s",
      unit: "currencyMinor",
      slices: [{ key: "a", label: "北京朝阳店", value: 11417900 }],
    });
    expect(rows).toEqual([{ key: "a", label: "北京朝阳店", value: "¥114,179.00" }]);
  });

  it("treats all-zero results as empty", () => {
    expect(
      isEmptyResult({
        kind: "series",
        title: "t",
        summary: "s",
        unit: "count",
        points: [{ date: "2026-08-02", value: 0 }],
      }),
    ).toBe(true);
  });

  it("keeps axis labels compact", () => {
    expect(formatAxisValue(5_000_000, "currencyMinor")).toBe("¥5万");
    expect(formatAxisValue(25_000, "count")).toBe("2.5万");
    expect(formatAxisValue(0.25, "ratio")).toBe("25%");
  });
});

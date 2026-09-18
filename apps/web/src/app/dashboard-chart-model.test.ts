import { describe, expect, it } from "vitest";
import {
  buildPieSlices,
  chartColor,
  createSeriesPoints,
  formatChartShare,
  formatChartValue,
} from "./dashboard-chart-model";

describe("dashboard chart model", () => {
  it("aggregates every item after the top five into an exact Other slice", () => {
    const slices = buildPieSlices(
      [9, 8, 7, 6, 5, 4, 3].map((value, index) => ({
        key: `k${index}`,
        label: `Item ${index}`,
        value,
      })),
    );
    expect(slices).toHaveLength(6);
    expect(slices.at(-1)).toMatchObject({ label: "其他", value: 7 });
    expect(slices.reduce((sum, slice) => sum + slice.value, 0)).toBe(42);
  });

  it("does not collide with a real category using an internal-looking key", () => {
    const slices = buildPieSlices(
      ["__chart_other__", "b", "c", "d", "e", "f", "g"].map((key, index) => ({
        key,
        label: key,
        value: 10 - index,
      })),
    );
    expect(new Set(slices.map(({ key }) => key)).size).toBe(slices.length);
  });

  it("uses top five plus Other when exactly six categories are present", () => {
    const slices = buildPieSlices(
      [6, 5, 4, 3, 2, 1].map((value) => ({
        key: String(value),
        label: String(value),
        value,
      })),
    );
    expect(slices).toHaveLength(6);
    expect(slices.at(-1)).toMatchObject({ label: "其他", value: 1 });
  });

  it("keeps colors stable when data is reordered", () => {
    expect(chartColor("store-a")).toBe(chartColor("store-a"));
    expect(["store-b", "store-a"].map(chartColor)[1]).toBe(
      ["store-a", "store-b"].map(chartColor)[0],
    );
  });

  it("does not describe non-additive values as percentages", () => {
    expect(formatChartShare(5, 10, false)).toBeNull();
    expect(formatChartShare(5, 10, true)).toBe("50%");
  });

  it("rounds fractional minor currency and preserves large integer cents", () => {
    expect(formatChartValue(100.6, "currencyMinor")).toBe("¥1.01");
    expect(formatChartValue(Number.MAX_SAFE_INTEGER, "currencyMinor")).toBe(
      "¥90,071,992,547,409.91",
    );
    expect(formatChartValue(Number.POSITIVE_INFINITY, "count")).toBe("—");
  });

  it("sorts series chronologically and positions points by actual date gaps", () => {
    const points = createSeriesPoints([
      { date: "2026-09-11", value: 30 },
      { date: "2026-09-01", value: 10 },
      { date: "2026-09-02", value: 20 },
    ]);
    expect(points.map(({ date }) => date)).toEqual(["2026-09-01", "2026-09-02", "2026-09-11"]);
    expect(points[1]!.x).toBeCloseTo(13.2, 1);
  });

  it("uses one honest plot baseline for zero, maximum, and all-zero series", () => {
    const points = createSeriesPoints([
      { date: "2026-09-01", value: 0 },
      { date: "2026-09-02", value: 10 },
    ]);
    expect(points.map(({ y }) => y)).toEqual([90, 10]);
    expect(createSeriesPoints([{ date: "2026-09-01", value: 0 }])[0]!.y).toBe(90);
  });

  it("keeps thirty points in chronological render order", () => {
    const points = Array.from({ length: 30 }, (_, index) => ({
      date: `2026-08-${String(31 - index).padStart(2, "0")}`,
      value: index,
    }));
    expect(createSeriesPoints(points).map(({ date }) => date)).toEqual(
      [...points].reverse().map(({ date }) => date),
    );
  });
});

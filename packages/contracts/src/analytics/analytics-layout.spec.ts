import { describe, expect, it } from "vitest";

import {
  AnalyticsLayoutReadResponseSchema,
  AnalyticsLayoutSaveRequestSchema,
  AnalyticsLayoutSchema,
  DEFAULT_ANALYTICS_LAYOUT,
} from "./analytics-layout.schema.js";

describe("AnalyticsLayoutSchema", () => {
  it("accepts the default layout with every card once", () => {
    expect(AnalyticsLayoutSchema.parse(DEFAULT_ANALYTICS_LAYOUT)).toEqual(DEFAULT_ANALYTICS_LAYOUT);
  });

  it("allows hiding cards by leaving them out", () => {
    expect(
      AnalyticsLayoutSchema.safeParse({ version: 1, cards: [{ id: "sales", span: 2 }] }).success,
    ).toBe(true);
  });

  it("rejects duplicates, unknown cards and invalid spans", () => {
    const parse = (cards: unknown) =>
      AnalyticsLayoutSchema.safeParse({ version: 1, cards }).success;
    expect(
      parse([
        { id: "sales", span: 1 },
        { id: "sales", span: 2 },
      ]),
    ).toBe(false);
    expect(parse([{ id: "legacyWidget", span: 1 }])).toBe(false);
    expect(parse([{ id: "sales", span: 4 }])).toBe(false);
    expect(parse([{ id: "sales", span: 1, extra: true }])).toBe(false);
  });

  it("bounds the expected revision and response revision", () => {
    expect(
      AnalyticsLayoutSaveRequestSchema.safeParse({
        layout: DEFAULT_ANALYTICS_LAYOUT,
        expectedRevision: -1,
      }).success,
    ).toBe(false);
    expect(
      AnalyticsLayoutReadResponseSchema.safeParse({
        layout: DEFAULT_ANALYTICS_LAYOUT,
        revision: 0,
        updatedAt: null,
      }).success,
    ).toBe(true);
  });
});

describe("AI chart cards", () => {
  const query = {
    dataset: "sales",
    metric: "revenue",
    aggregation: "sum",
    groupBy: "store",
    dateRange: { start: "2026-08-02", end: "2026-08-31" },
    filters: [],
    order: "desc",
    limit: 8,
    visualization: "bar",
  } as const;
  const aiCard = (id: string) => ({ id, kind: "aiChart", span: 1, title: "各门店销售额", query });

  it("accepts saved AI charts alongside built-in cards", () => {
    const layout = { version: 1, cards: [{ id: "sales", span: 1 }, aiCard("ai-0123456789abcdef")] };
    expect(AnalyticsLayoutSchema.safeParse(layout).success).toBe(true);
  });

  it("rejects malformed ids, invalid queries and more than the AI card limit", () => {
    const parse = (cards: unknown[]) =>
      AnalyticsLayoutSchema.safeParse({ version: 1, cards }).success;
    expect(parse([aiCard("ai-<script>")])).toBe(false);
    expect(parse([{ ...aiCard("ai-0123456789abcdef"), query: { ...query, limit: 99 } }])).toBe(
      false,
    );
    const many = Array.from({ length: 13 }, (_, i) => aiCard(`ai-${String(i).padStart(16, "0")}`));
    expect(parse(many)).toBe(false);
  });
});

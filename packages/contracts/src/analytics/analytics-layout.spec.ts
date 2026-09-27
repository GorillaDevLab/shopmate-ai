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

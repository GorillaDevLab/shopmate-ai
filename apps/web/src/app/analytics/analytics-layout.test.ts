import { DEFAULT_ANALYTICS_LAYOUT, type AnalyticsAiCard } from "@shopmate/contracts";
import { describe, expect, it } from "vitest";

import {
  addAiCard,
  createAiCardId,
  resetLayout,
  dropCard,
  hiddenCards,
  removeCard,
  moveCard,
  setSpan,
  showCard,
} from "./analytics-layout";

const ids = (layout: typeof DEFAULT_ANALYTICS_LAYOUT) => layout.cards.map((card) => card.id);

describe("analytics layout editing", () => {
  it("moves a card by one step and ignores moves past either end", () => {
    const moved = moveCard(DEFAULT_ANALYTICS_LAYOUT, "weekly", -1);
    expect(ids(moved).slice(2, 4)).toEqual(["weekly", "sales"]);
    expect(moveCard(DEFAULT_ANALYTICS_LAYOUT, "insights", -1)).toBe(DEFAULT_ANALYTICS_LAYOUT);
  });

  it("drops a dragged card onto another card's position", () => {
    const dropped = dropCard(DEFAULT_ANALYTICS_LAYOUT, "products", "insights");
    expect(ids(dropped)[0]).toBe("products");
    expect(ids(dropped)[1]).toBe("insights");
  });

  it("changes width only for the chosen card", () => {
    const wide = setSpan(DEFAULT_ANALYTICS_LAYOUT, "sales", 3);
    expect(wide.cards.find((card) => card.id === "sales")?.span).toBe(3);
    expect(wide.cards.find((card) => card.id === "weekly")?.span).toBe(1);
  });

  it("hides a card and restores it at the end with its default width", () => {
    const hidden = removeCard(DEFAULT_ANALYTICS_LAYOUT, "channelDaily");
    expect(hiddenCards(hidden)).toEqual(["channelDaily"]);
    const shown = showCard(hidden, "channelDaily");
    expect(shown.cards.at(-1)).toEqual({ id: "channelDaily", span: 2 });
    expect(hiddenCards(shown)).toEqual([]);
  });

  it("keeps saved AI charts when resetting built-in cards to default", () => {
    const withAi = addAiCard(removeCard(DEFAULT_ANALYTICS_LAYOUT, "sales"), aiCard());
    const reset = resetLayout(withAi);
    expect(ids(reset)).toEqual([...ids(DEFAULT_ANALYTICS_LAYOUT), withAi.cards.at(-1)!.id]);
  });

  it("refuses to add more than 12 AI charts", () => {
    let layout = DEFAULT_ANALYTICS_LAYOUT;
    for (let i = 0; i < 12; i += 1) layout = addAiCard(layout, aiCard());
    expect(() => addAiCard(layout, aiCard())).toThrow("最多保存 12 张 AI 图表");
  });

  it("creates ids the server accepts", () => {
    expect(createAiCardId()).toMatch(/^ai-[a-f0-9]{24}$/);
  });
});

function aiCard(): AnalyticsAiCard {
  return {
    id: createAiCardId(),
    kind: "aiChart",
    span: 1,
    title: "各门店销售额",
    query: {
      dataset: "sales",
      metric: "revenue",
      aggregation: "sum",
      groupBy: "store",
      dateRange: { start: "2026-08-02", end: "2026-08-31" },
      filters: [],
      order: "desc",
      limit: 8,
      visualization: "bar",
    },
  };
}

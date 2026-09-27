import { DEFAULT_ANALYTICS_LAYOUT } from "@shopmate/contracts";
import { describe, expect, it } from "vitest";

import { dropCard, hiddenCards, hideCard, moveCard, setSpan, showCard } from "./analytics-layout";

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
    const hidden = hideCard(DEFAULT_ANALYTICS_LAYOUT, "channelDaily");
    expect(hiddenCards(hidden)).toEqual(["channelDaily"]);
    const shown = showCard(hidden, "channelDaily");
    expect(shown.cards.at(-1)).toEqual({ id: "channelDaily", span: 2 });
    expect(hiddenCards(shown)).toEqual([]);
  });
});

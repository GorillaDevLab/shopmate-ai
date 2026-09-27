import {
  AnalyticsCardIdSchema,
  DEFAULT_ANALYTICS_LAYOUT,
  type AnalyticsCardId,
  type AnalyticsCardSpan,
  type AnalyticsLayout,
} from "@shopmate/contracts";

export const CARD_LABELS: Record<AnalyticsCardId, string> = {
  insights: "经营洞察",
  kpis: "经营总览指标",
  sales: "销售额",
  weekly: "每周销售额",
  channelShare: "各渠道销售额占比",
  channelRanking: "门店与店铺销售排行",
  channelDaily: "各渠道每日销售额",
  channelSplit: "线下门店与线上店铺",
  products: "商品销售额 Top 5",
  newChart: "让 AI 生成新图表",
};

export const CHANNEL_CARDS: readonly AnalyticsCardId[] = [
  "channelShare",
  "channelRanking",
  "channelDaily",
  "channelSplit",
];

export function moveCard(
  layout: AnalyticsLayout,
  id: AnalyticsCardId,
  offset: number,
): AnalyticsLayout {
  const from = layout.cards.findIndex((card) => card.id === id);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= layout.cards.length) return layout;
  const cards = [...layout.cards];
  const [card] = cards.splice(from, 1);
  cards.splice(to, 0, card);
  return { ...layout, cards };
}

/** 拖放：把 id 放到 target 当前的位置上（target 顺延）。 */
export function dropCard(
  layout: AnalyticsLayout,
  id: AnalyticsCardId,
  target: AnalyticsCardId,
): AnalyticsLayout {
  const from = layout.cards.findIndex((card) => card.id === id);
  const to = layout.cards.findIndex((card) => card.id === target);
  if (from < 0 || to < 0 || from === to) return layout;
  return moveCard(layout, id, to - from);
}

export function setSpan(
  layout: AnalyticsLayout,
  id: AnalyticsCardId,
  span: AnalyticsCardSpan,
): AnalyticsLayout {
  return {
    ...layout,
    cards: layout.cards.map((card) => (card.id === id ? { ...card, span } : card)),
  };
}

export function hideCard(layout: AnalyticsLayout, id: AnalyticsCardId): AnalyticsLayout {
  return { ...layout, cards: layout.cards.filter((card) => card.id !== id) };
}

/** 重新显示的卡片放到末尾，宽度沿用默认布局。 */
export function showCard(layout: AnalyticsLayout, id: AnalyticsCardId): AnalyticsLayout {
  if (layout.cards.some((card) => card.id === id)) return layout;
  const span = DEFAULT_ANALYTICS_LAYOUT.cards.find((card) => card.id === id)?.span ?? 1;
  return { ...layout, cards: [...layout.cards, { id, span }] };
}

export function hiddenCards(layout: AnalyticsLayout): AnalyticsCardId[] {
  const visible = new Set(layout.cards.map((card) => card.id));
  return AnalyticsCardIdSchema.options.filter((id) => !visible.has(id));
}

export function sameLayout(a: AnalyticsLayout, b: AnalyticsLayout): boolean {
  return JSON.stringify(a.cards) === JSON.stringify(b.cards);
}

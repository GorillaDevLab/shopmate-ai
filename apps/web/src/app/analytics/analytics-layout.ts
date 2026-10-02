import {
  ANALYTICS_MAX_AI_CARDS,
  AnalyticsCardIdSchema,
  DEFAULT_ANALYTICS_LAYOUT,
  isAnalyticsAiCard,
  type AnalyticsAiCard,
  type AnalyticsCardId,
  type AnalyticsCardSpan,
  type AnalyticsLayout,
  type AnalyticsLayoutCard,
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

export function cardLabel(card: AnalyticsLayoutCard): string {
  return isAnalyticsAiCard(card) ? card.title : CARD_LABELS[card.id];
}

export function moveCard(layout: AnalyticsLayout, id: string, offset: number): AnalyticsLayout {
  const from = layout.cards.findIndex((card) => card.id === id);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= layout.cards.length) return layout;
  const cards = [...layout.cards];
  const [card] = cards.splice(from, 1);
  cards.splice(to, 0, card);
  return { ...layout, cards };
}

/** 拖放：把 id 放到 target 当前的位置上（target 顺延）。 */
export function dropCard(layout: AnalyticsLayout, id: string, target: string): AnalyticsLayout {
  const from = layout.cards.findIndex((card) => card.id === id);
  const to = layout.cards.findIndex((card) => card.id === target);
  if (from < 0 || to < 0 || from === to) return layout;
  return moveCard(layout, id, to - from);
}

export function setSpan(
  layout: AnalyticsLayout,
  id: string,
  span: AnalyticsCardSpan,
): AnalyticsLayout {
  return {
    ...layout,
    cards: layout.cards.map((card) => (card.id === id ? { ...card, span } : card)),
  };
}

/** 内置卡片移出后可在“已隐藏”里加回；AI 图表移出即删除。 */
export function removeCard(layout: AnalyticsLayout, id: string): AnalyticsLayout {
  return { ...layout, cards: layout.cards.filter((card) => card.id !== id) };
}

/** 重新显示的卡片放到末尾，宽度沿用默认布局。 */
export function showCard(layout: AnalyticsLayout, id: AnalyticsCardId): AnalyticsLayout {
  if (layout.cards.some((card) => card.id === id)) return layout;
  const span = DEFAULT_ANALYTICS_LAYOUT.cards.find((card) => card.id === id)?.span ?? 1;
  return { ...layout, cards: [...layout.cards, { id, span }] };
}

/** 内置卡片回到默认布局，已保存的 AI 图表按原顺序保留在末尾。 */
export function resetLayout(layout: AnalyticsLayout): AnalyticsLayout {
  return {
    ...DEFAULT_ANALYTICS_LAYOUT,
    cards: [...DEFAULT_ANALYTICS_LAYOUT.cards, ...layout.cards.filter(isAnalyticsAiCard)],
  };
}

export function hiddenCards(layout: AnalyticsLayout): AnalyticsCardId[] {
  const visible = new Set<string>(layout.cards.map((card) => card.id));
  return AnalyticsCardIdSchema.options.filter((id) => !visible.has(id));
}

export class AiCardLimitError extends Error {
  constructor() {
    super(`经营分析最多保存 ${ANALYTICS_MAX_AI_CARDS} 张 AI 图表，请先在编辑看板里删除一些`);
    this.name = "AiCardLimitError";
  }
}

export function addAiCard(layout: AnalyticsLayout, card: AnalyticsAiCard): AnalyticsLayout {
  if (layout.cards.filter(isAnalyticsAiCard).length >= ANALYTICS_MAX_AI_CARDS) {
    throw new AiCardLimitError();
  }
  return { ...layout, cards: [...layout.cards, card] };
}

/** 卡片 id 只用于区分卡片，不是安全凭证；HTTP 访问时没有 randomUUID，退回 getRandomValues。 */
export function createAiCardId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(12));
  return `ai-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

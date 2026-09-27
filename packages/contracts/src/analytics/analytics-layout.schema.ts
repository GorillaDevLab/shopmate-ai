import { z } from "zod";

import { DashboardInsightQuerySchema } from "../ai/dashboard-insight.schema.js";

const POSTGRESQL_INT_MAX = 2_147_483_647;

/** 经营分析页可编辑的卡片。新增卡片时追加到末尾，旧布局里没有的卡片视为隐藏。 */
export const AnalyticsCardIdSchema = z.enum([
  "insights",
  "kpis",
  "sales",
  "weekly",
  "channelShare",
  "channelRanking",
  "channelDaily",
  "channelSplit",
  "products",
  "newChart",
]);
export type AnalyticsCardId = z.infer<typeof AnalyticsCardIdSchema>;

/** 占几列（桌面三列网格）；窄屏统一单列。 */
export const AnalyticsCardSpanSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type AnalyticsCardSpan = z.infer<typeof AnalyticsCardSpanSchema>;

export const AnalyticsBuiltinCardSchema = z.strictObject({
  id: AnalyticsCardIdSchema,
  span: AnalyticsCardSpanSchema,
});
export type AnalyticsBuiltinCard = z.infer<typeof AnalyticsBuiltinCardSchema>;

/** 从「AI 图表探索」保存的图表上限，防止首页一次发起过多查询。 */
export const ANALYTICS_MAX_AI_CARDS = 12;

/**
 * 只保存结构化查询，不保存模型输出或结果数据：首页按当前时段重新执行查询，
 * 不再调用模型，数据也始终是最新的。
 */
export const AnalyticsAiCardSchema = z.strictObject({
  id: z.string().regex(/^ai-[a-f0-9]{16,40}$/u),
  kind: z.literal("aiChart"),
  span: AnalyticsCardSpanSchema,
  title: z.string().trim().min(1).max(120),
  query: DashboardInsightQuerySchema,
});
export type AnalyticsAiCard = z.infer<typeof AnalyticsAiCardSchema>;

export const AnalyticsLayoutCardSchema = z.union([
  AnalyticsAiCardSchema,
  AnalyticsBuiltinCardSchema,
]);
export type AnalyticsLayoutCard = z.infer<typeof AnalyticsLayoutCardSchema>;

export function isAnalyticsAiCard(card: AnalyticsLayoutCard): card is AnalyticsAiCard {
  return "kind" in card && card.kind === "aiChart";
}

export const AnalyticsLayoutSchema = z
  .strictObject({
    version: z.literal(1),
    // 列表即显示顺序；不在列表中的内置卡片被隐藏，AI 卡片被删除即移出列表。
    cards: z
      .array(AnalyticsLayoutCardSchema)
      .max(AnalyticsCardIdSchema.options.length + ANALYTICS_MAX_AI_CARDS),
  })
  .superRefine(({ cards }, context) => {
    const seen = new Set<string>();
    cards.forEach((card, index) => {
      if (seen.has(card.id)) {
        context.addIssue({ code: "custom", path: ["cards", index, "id"], message: "卡片重复" });
      }
      seen.add(card.id);
    });
    if (cards.filter(isAnalyticsAiCard).length > ANALYTICS_MAX_AI_CARDS) {
      context.addIssue({
        code: "custom",
        path: ["cards"],
        message: `最多保存 ${ANALYTICS_MAX_AI_CARDS} 张 AI 图表`,
      });
    }
  });
export type AnalyticsLayout = z.infer<typeof AnalyticsLayoutSchema>;

export const DEFAULT_ANALYTICS_LAYOUT: AnalyticsLayout = {
  version: 1,
  cards: [
    { id: "insights", span: 3 },
    { id: "kpis", span: 3 },
    { id: "sales", span: 1 },
    { id: "weekly", span: 1 },
    { id: "channelShare", span: 1 },
    { id: "channelRanking", span: 1 },
    { id: "channelDaily", span: 2 },
    { id: "channelSplit", span: 1 },
    { id: "products", span: 1 },
    { id: "newChart", span: 1 },
  ],
};

export const AnalyticsLayoutSaveRequestSchema = z.strictObject({
  layout: AnalyticsLayoutSchema,
  expectedRevision: z
    .number()
    .int()
    .min(0)
    .max(POSTGRESQL_INT_MAX - 1),
});
export type AnalyticsLayoutSaveRequest = z.infer<typeof AnalyticsLayoutSaveRequestSchema>;

export const AnalyticsLayoutReadResponseSchema = z.union([
  z.strictObject({ layout: AnalyticsLayoutSchema, revision: z.literal(0), updatedAt: z.null() }),
  z.strictObject({
    layout: AnalyticsLayoutSchema,
    revision: z.number().int().min(1).max(POSTGRESQL_INT_MAX),
    updatedAt: z.iso.datetime({ offset: true }),
  }),
]);
export type AnalyticsLayoutReadResponse = z.infer<typeof AnalyticsLayoutReadResponseSchema>;

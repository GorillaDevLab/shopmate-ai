import { z } from "zod";

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

export const AnalyticsLayoutSchema = z
  .strictObject({
    version: z.literal(1),
    // 列表即显示顺序；不在列表中的卡片被隐藏。
    cards: z
      .array(z.strictObject({ id: AnalyticsCardIdSchema, span: AnalyticsCardSpanSchema }))
      .max(AnalyticsCardIdSchema.options.length),
  })
  .superRefine(({ cards }, context) => {
    const seen = new Set<string>();
    cards.forEach((card, index) => {
      if (seen.has(card.id)) {
        context.addIssue({ code: "custom", path: ["cards", index, "id"], message: "卡片重复" });
      }
      seen.add(card.id);
    });
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

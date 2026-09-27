import { z } from "zod";

/** 待确认操作的有效期；过期后必须让 AI 重新生成，避免按过时的数据执行。 */
export const AGENT_ACTION_TTL_MS = 15 * 60 * 1000;
export const AGENT_ACTION_MAX_PER_REPLY = 3;

export const AgentActionKindSchema = z.enum([
  "updateInventoryThreshold",
  "createMonitoringRule",
  "saveChartToAnalytics",
]);
export type AgentActionKind = z.infer<typeof AgentActionKindSchema>;

export const AgentActionIdSchema = z.uuid();

/**
 * AI 只能“提出”操作：卡片展示将要发生的变化，只有用户点确认后，
 * 客户端直接调用确认接口执行；模型没有确认能力。
 */
export const AgentActionProposalSchema = z.strictObject({
  actionId: AgentActionIdSchema,
  kind: AgentActionKindSchema,
  title: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(280),
  details: z
    .array(
      z.strictObject({
        label: z.string().trim().min(1).max(40),
        value: z.string().trim().min(1).max(160),
      }),
    )
    .max(8),
  expiresAt: z.iso.datetime(),
});
export type AgentActionProposal = z.infer<typeof AgentActionProposalSchema>;

// 只允许站内相对路径，确认结果里的链接不能把用户带到外部站点。
const internalHref = z
  .string()
  .regex(/^\/(?!\/)[\w\-/?=&.]*$/u)
  .max(200);

export const AgentActionConfirmResponseSchema = z.strictObject({
  status: z.literal("done"),
  message: z.string().trim().min(1).max(280),
  href: internalHref.optional(),
});
export type AgentActionConfirmResponse = z.infer<typeof AgentActionConfirmResponseSchema>;

export const AgentActionCancelResponseSchema = z.strictObject({
  status: z.literal("cancelled"),
});

/** 保存在本地对话里的卡片结果，刷新后仍显示“已执行 / 已取消 / 已过期”。 */
export const AgentActionOutcomeSchema = z.strictObject({
  status: z.enum(["done", "cancelled", "failed", "expired"]),
  message: z.string().max(280),
  href: internalHref.optional(),
});
export type AgentActionOutcome = z.infer<typeof AgentActionOutcomeSchema>;

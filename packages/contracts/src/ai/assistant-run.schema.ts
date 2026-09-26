import { z } from "zod";
import { AiChatRequestSchema, AiChatResponseSchema } from "./chat-api.schema.js";
import {
  DashboardInsightPreviewResponseSchema,
  DashboardInsightQuerySchema,
} from "./dashboard-insight.schema.js";

const requestId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/u);
export const AssistantReplySchema = AiChatResponseSchema.shape.message.extend({
  insightPreview: DashboardInsightPreviewResponseSchema.optional(),
  insightQuery: DashboardInsightQuerySchema.optional(),
});
export const AssistantRunRequestSchema = AiChatRequestSchema.extend({ requestId });
export const AssistantProgressSchema = z.enum([
  "accepted",
  "tool-started",
  "tool-completed",
  "composing",
]);
export const AssistantRunEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: AssistantProgressSchema, requestId, label: z.string().min(1).max(120) }),
  z.strictObject({ type: z.literal("completed"), requestId, reply: AssistantReplySchema }),
  z.strictObject({
    type: z.literal("failed"),
    requestId,
    code: z.string().max(80),
    message: z.string().max(200),
  }),
]);
export type AssistantReply = z.infer<typeof AssistantReplySchema>;
export type AssistantRunRequest = z.infer<typeof AssistantRunRequestSchema>;
export type AssistantRunEvent = z.infer<typeof AssistantRunEventSchema>;
export type AssistantProgress = z.infer<typeof AssistantProgressSchema>;

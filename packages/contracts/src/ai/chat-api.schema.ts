import { z } from "zod";
import { ChatHistorySchema } from "./chat-history.schema.js";
import { DashboardInsightQuerySchema } from "./dashboard-insight.schema.js";

import { ProductCopyOutputSchema, ProductCopyRequestSchema } from "./product-copy.schema.js";

const userMessageSchema = z.strictObject({
  role: z.literal("user"),
  content: z.string().trim().min(1).max(2000),
});

const assistantMessageSchema = z.strictObject({
  role: z.literal("assistant"),
  content: z.string().trim().min(1).max(8000),

  productCopy: ProductCopyOutputSchema.optional(),
});

export const AiChatRequestSchema = z.strictObject({
  message: userMessageSchema,
  history: ChatHistorySchema.optional(),
  insightQuery: DashboardInsightQuerySchema.optional(),
  productCopy: ProductCopyRequestSchema.optional(),
});

export const AiChatResponseSchema = z.strictObject({
  message: assistantMessageSchema,
});

export type AiChatRequest = z.infer<typeof AiChatRequestSchema>;

export type AiChatResponse = z.infer<typeof AiChatResponseSchema>;

import { z } from "zod";

export const ChatHistorySchema = z
  .array(
    z.discriminatedUnion("role", [
      z.strictObject({ role: z.literal("user"), content: z.string().trim().min(1).max(2000) }),
      z.strictObject({ role: z.literal("assistant"), content: z.string().trim().min(1).max(8000) }),
    ]),
  )
  .max(12)
  .refine(
    (messages) =>
      messages.length % 2 === 0 &&
      messages.every(
        (message, index) => message.role === (index % 2 === 0 ? "user" : "assistant"),
      ) &&
      messages.reduce((size, message) => size + message.content.length, 0) <= 24000,
    "History must contain bounded completed turns",
  );

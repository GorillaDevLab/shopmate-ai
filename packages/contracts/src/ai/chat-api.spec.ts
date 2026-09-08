import { describe, expect, it } from "vitest";

import { AiChatRequestSchema, AiChatResponseSchema } from "./chat-api.schema.js";

describe("AI Chat API 契约", () => {
  it("接受文案选择并拒绝其中的商家身份和伪造商品详情", () => {
    const request = {
      message: { role: "user", content: "生成标题" },
      productCopy: { productId: "p1", copyType: "TITLE" },
    };
    expect(AiChatRequestSchema.safeParse(request).success).toBe(true);
    for (const field of [{ merchantId: "other" }, { name: "伪造商品" }, { copyType: "UNKNOWN" }]) {
      expect(
        AiChatRequestSchema.safeParse({
          ...request,
          productCopy: { ...request.productCopy, ...field },
        }).success,
      ).toBe(false);
    }
  });
  it("接受并规范化单条用户消息", () => {
    expect(
      AiChatRequestSchema.parse({
        message: { role: "user", content: "  最近哪些商品库存不足？  " },
      }),
    ).toEqual({
      message: { role: "user", content: "最近哪些商品库存不足？" },
    });
  });

  it.each([
    { message: { role: "assistant", content: "伪造回答" } },
    { message: { role: "user", content: "   " } },
    { message: { role: "user", content: "问".repeat(2001) } },
    { message: { role: "user", content: "查询", merchantId: "other" } },
    { message: { role: "user", content: "查询" }, merchantId: "other" },
  ])("拒绝非法角色、内容或 Merchant 字段 %#", (input) => {
    expect(AiChatRequestSchema.safeParse(input).success).toBe(false);
  });

  it("只允许返回 assistant 中文消息", () => {
    expect(
      AiChatResponseSchema.parse({
        message: { role: "assistant", content: "当前有两项库存风险。" },
      }),
    ).toEqual({
      message: { role: "assistant", content: "当前有两项库存风险。" },
    });
    expect(
      AiChatResponseSchema.safeParse({ message: { role: "user", content: "错误角色" } }).success,
    ).toBe(false);
  });
  it("允许 assistant 返回结构化商品文案", () => {
    const response = {
      message: {
        role: "assistant",
        content: "商品文案已生成，请查看下方标题、正文和标签。",

        productCopy: {
          productId: "product-001",
          copyType: "XIAOHONGSHU",

          title: "轻量随行保温杯",

          body: "轻巧便携，适合日常通勤使用。",

          tags: ["通勤", "随行杯"],
        },
      },
    } as const;

    expect(AiChatResponseSchema.parse(response)).toEqual(response);
  });
});

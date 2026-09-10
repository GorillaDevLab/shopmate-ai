import { beforeEach, describe, expect, it, vi } from "vitest";

import { sendChatMessage } from "./chat-api";

describe("sendChatMessage", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("超时给出明确提示且不自动重试，也不透传服务端敏感文本", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "AI_TIMEOUT",
          message: "secret",
          retryable: false,
        }),
        { status: 504 },
      ),
    );
    await expect(sendChatMessage("生成文案")).rejects.toMatchObject({
      message: expect.stringContaining("未自动重试"),
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("传递已选商品与类型，不传递商家身份", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: { role: "assistant", content: "完成" } })),
    );
    await sendChatMessage("生成标题", undefined, { productId: "p1", copyType: "TITLE" });
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/ai/chat",
      expect.objectContaining({
        body: JSON.stringify({
          message: { role: "user", content: "生成标题" },
          productCopy: { productId: "p1", copyType: "TITLE" },
        }),
      }),
    );
  });

  it("发送中文消息并解析 assistant 回复", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: { role: "assistant", content: "库存还有 5 件。" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(sendChatMessage("请查询库存")).resolves.toEqual({
      role: "assistant",
      content: "库存还有 5 件。",
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/ai/chat",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ message: { role: "user", content: "请查询库存" } }),
      }),
    );
  });

  it("服务失败时返回可重试的中文错误", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));

    await expect(sendChatMessage("查询趋势")).rejects.toMatchObject({
      status: 503,
      message: "AI 服务暂时不可用，请稍后重试",
      retryable: true,
    });
  });
});

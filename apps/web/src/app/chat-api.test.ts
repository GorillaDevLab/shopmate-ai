import { beforeEach, describe, expect, it, vi } from "vitest";

import { sendChatMessage } from "./chat-api";

describe("sendChatMessage", () => {
  beforeEach(() => vi.restoreAllMocks());

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

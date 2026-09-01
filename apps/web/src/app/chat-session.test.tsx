import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ sendChatMessage: vi.fn() }));
vi.mock("./chat-api", () => ({ sendChatMessage: api.sendChatMessage }));

import { useChatSession } from "./chat-session";

describe("共享聊天会话", () => {
  beforeEach(() => vi.resetAllMocks());

  it("清理输入后发送，并保留用户和助手消息", async () => {
    api.sendChatMessage.mockResolvedValue({ role: "assistant", content: "建议优先补货。" });
    const { result } = renderHook(() => useChatSession());

    await act(() => result.current.submit("  最近哪些商品值得补货？  "));

    expect(api.sendChatMessage).toHaveBeenCalledWith("最近哪些商品值得补货？");
    expect(result.current.messages).toEqual([
      { role: "user", content: "最近哪些商品值得补货？" },
      { role: "assistant", content: "建议优先补货。" },
    ]);
  });

  it("失败后使用原问题重试", async () => {
    api.sendChatMessage
      .mockRejectedValueOnce(new Error("AI 服务暂时不可用，请稍后重试"))
      .mockResolvedValueOnce({ role: "assistant", content: "已恢复。" });
    const { result } = renderHook(() => useChatSession());

    await act(() => result.current.submit("请看销售趋势"));
    expect(result.current.error).toBe("AI 服务暂时不可用，请稍后重试");

    await act(() => result.current.retry());

    expect(api.sendChatMessage).toHaveBeenNthCalledWith(2, "请看销售趋势");
    expect(result.current.error).toBeNull();
    expect(result.current.messages.at(-1)).toEqual({ role: "assistant", content: "已恢复。" });
  });
});

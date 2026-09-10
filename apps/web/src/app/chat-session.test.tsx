import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ sendChatMessage: vi.fn() }));
vi.mock("./chat-api", () => ({ sendChatMessage: api.sendChatMessage }));

import { useChatSession } from "./chat-session";

describe("共享聊天会话", () => {
  beforeEach(() => vi.resetAllMocks());

  it("同一帧重复发送只提交一次请求", async () => {
    let finish!: (value: { role: string; content: string }) => void;
    api.sendChatMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = renderHook(() => useChatSession());
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.submit("查库存");
      void result.current.submit("查库存");
    });
    expect(api.sendChatMessage).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({ role: "assistant", content: "完成" });
      await pending;
    });
    expect(result.current.isSending).toBe(false);
  });

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
      .mockRejectedValueOnce(
        Object.assign(new Error("AI 服务暂时不可用，请稍后重试"), {
          retryable: true,
        }),
      )
      .mockResolvedValueOnce({
        role: "assistant",
        content: "已恢复。",
      });

    const { result } = renderHook(() => useChatSession());

    await act(() => result.current.submit("请看销售趋势"));
    expect(result.current.error).toBe("AI 服务暂时不可用，请稍后重试");
    expect(result.current.retryable).toBe(true);

    await act(() => result.current.retry());

    expect(api.sendChatMessage).toHaveBeenNthCalledWith(2, "请看销售趋势");
    expect(result.current.error).toBeNull();
    expect(result.current.messages.at(-1)).toEqual({
      role: "assistant",
      content: "已恢复。",
    });
  });

  it("不可重试错误不会重新提交原问题", async () => {
    api.sendChatMessage.mockRejectedValueOnce(
      Object.assign(new Error("回答未通过数据校验，请缩小查询范围"), {
        retryable: false,
      }),
    );

    const { result } = renderHook(() => useChatSession());

    await act(() => result.current.submit("分析全部销售数据"));

    expect(result.current.error).toBe("回答未通过数据校验，请缩小查询范围");
    expect(result.current.retryable).toBe(false);

    await act(() => result.current.retry());

    expect(api.sendChatMessage).toHaveBeenCalledTimes(1);
  });
});

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ sendChatMessage: vi.fn() }));
vi.mock("./chat-api", () => ({ sendChatMessage: api.sendChatMessage }));

import { useChatSession } from "./chat-session";

describe("共享聊天会话", () => {
  beforeEach(() => vi.resetAllMocks());

  it("超出字符预算时按完整轮次裁剪", async () => {
    api.sendChatMessage.mockResolvedValue({ role: "assistant", content: "答".repeat(8000) });
    const { result } = renderHook(() => useChatSession());
    for (let i = 0; i < 4; i++) await act(() => result.current.submit("问".repeat(2000)));
    const history = api.sendChatMessage.mock.calls[3]?.[3];
    expect(history).toHaveLength(4);
    expect(history[0].role).toBe("user");
    expect(history[3].role).toBe("assistant");
  });

  it("只保留最近六轮，新的聊天实例没有旧上下文", async () => {
    api.sendChatMessage.mockResolvedValue({ role: "assistant", content: "已完成。" });
    const { result } = renderHook(() => useChatSession());
    for (let i = 0; i < 8; i++) await act(() => result.current.submit(`问题${i}`));
    const history = api.sendChatMessage.mock.calls[7]?.[3];
    expect(history).toHaveLength(12);
    expect(history[0].content).toBe("问题1");
    const other = renderHook(() => useChatSession());
    await act(() => other.result.current.submit("新问题"));
    expect(api.sendChatMessage).toHaveBeenLastCalledWith("新问题");
  });

  it("数字追问带上已完成对话，重试不重复加入失败问题", async () => {
    const reply = { role: "assistant", content: "可以查销售汇总，回复 1 继续。" };
    api.sendChatMessage
      .mockResolvedValueOnce(reply)
      .mockRejectedValueOnce(Object.assign(new Error("暂不可用"), { retryable: true }))
      .mockResolvedValueOnce({ role: "assistant", content: "已查询汇总。" });
    const { result } = renderHook(() => useChatSession());
    await act(() => result.current.submit("分析趋势"));
    await act(() => result.current.submit("1"));
    const history = [{ role: "user", content: "分析趋势" }, reply];
    expect(api.sendChatMessage).toHaveBeenNthCalledWith(2, "1", undefined, undefined, history);
    await act(() => result.current.retry());
    expect(api.sendChatMessage).toHaveBeenNthCalledWith(3, "1", undefined, undefined, history);
  });

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

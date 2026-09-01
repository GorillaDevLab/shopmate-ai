import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ sendChatMessage: vi.fn() }));
vi.mock("./chat-api", () => ({ sendChatMessage: api.sendChatMessage }));

import { DashboardAiAssistant } from "./dashboard-ai-assistant";

function AssistantHarness() {
  const [open, setOpen] = useState(false);
  return <DashboardAiAssistant open={open} onOpenChange={setOpen} />;
}

describe("看板悬浮 AI 助手", () => {
  beforeEach(() => vi.resetAllMocks());

  it("从胶囊展开、聚焦输入并可关闭后恢复焦点", async () => {
    render(<AssistantHarness />);
    const trigger = screen.getByRole("button", { name: "Ask AI" });

    fireEvent.click(trigger);

    expect(screen.getByRole("dialog", { name: "AI 经营助手" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "消息" })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("使用经营建议发起对话并提供完整页面入口", async () => {
    api.sendChatMessage.mockResolvedValue({
      role: "assistant",
      content: "根据近 7 天销量，建议优先补货无线蓝牙耳机。",
    });
    render(<AssistantHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Ask AI" }));
    fireEvent.click(screen.getByRole("button", { name: "查看低库存" }));
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("最近哪些商品值得补货？");

    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    expect(await screen.findByText(/建议优先补货无线蓝牙耳机/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开完整聊天" })).toHaveAttribute("href", "/chat");
    expect(api.sendChatMessage).toHaveBeenCalledWith("最近哪些商品值得补货？");
  });

  it("失败时显示具体错误并可重试", async () => {
    api.sendChatMessage
      .mockRejectedValueOnce(new Error("AI 服务暂时不可用，请稍后重试"))
      .mockResolvedValueOnce({ role: "assistant", content: "已恢复，可以继续查询。" });
    render(<AssistantHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Ask AI" }));
    fireEvent.change(screen.getByRole("textbox", { name: "消息" }), {
      target: { value: "总结销售趋势" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("暂时不可用");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByText("已恢复，可以继续查询。")).toBeInTheDocument();
    expect(api.sendChatMessage).toHaveBeenCalledTimes(2);
  });
});

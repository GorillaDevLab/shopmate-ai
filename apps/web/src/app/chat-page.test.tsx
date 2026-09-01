import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ sendChatMessage: vi.fn() }));
vi.mock("./chat-api", () => ({ sendChatMessage: api.sendChatMessage }));

import ChatPage from "./chat/page";

describe("中文聊天页", () => {
  beforeEach(() => vi.resetAllMocks());

  it("展示三类经营问题示例并可发送消息", async () => {
    api.sendChatMessage.mockResolvedValue({ role: "assistant", content: "当前库存还有 5 件。" });
    render(<ChatPage />);

    expect(screen.getByRole("heading", { name: "AI 经营助手" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查库存" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "看热销" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "看趋势" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查库存" }));
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("请查询当前库存");
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    expect(await screen.findByText("当前库存还有 5 件。"),).toBeInTheDocument();
    expect(api.sendChatMessage).toHaveBeenCalledWith("请查询当前库存");
  });

  it("发送期间禁用输入，失败后提供重试", async () => {
    api.sendChatMessage.mockRejectedValue(new Error("AI 服务暂时不可用，请稍后重试"));
    render(<ChatPage />);
    const input = screen.getByRole("textbox", { name: "消息" });
    fireEvent.change(input, { target: { value: "请看销售趋势" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("暂时不可用"));
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(input).not.toBeDisabled();
  });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendChatMessage: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock("./chat-api", () => ({
  sendChatMessage: mocks.sendChatMessage,
}));

import ChatPage from "./chat/page";

const copyCases = [
  ["标题文案", "TITLE"],
  ["商品描述", "DESCRIPTION"],
  ["小红书文案", "XIAOHONGSHU"],
  ["抖音文案", "DOUYIN"],
  ["通用文案", "GENERAL"],
] as const;

describe("中文聊天页", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    mocks.writeText.mockResolvedValue(undefined);

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: mocks.writeText,
      },
    });
  });

  it("展示三类经营问题示例并可发送消息", async () => {
    mocks.sendChatMessage.mockResolvedValue({
      role: "assistant",
      content: "当前库存还有 5 件。",
    });

    render(<ChatPage />);

    expect(
      screen.getByRole("heading", {
        name: "AI 经营助手",
      }),
    ).toBeInTheDocument();

    expect(
      screen.getByRole("button", {
        name: "查库存",
      }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "查库存",
      }),
    );

    expect(
      screen.getByRole("textbox", {
        name: "消息",
      }),
    ).toHaveValue("请查询当前库存");

    fireEvent.click(
      screen.getByRole("button", {
        name: "发送消息",
      }),
    );

    expect(await screen.findByText("当前库存还有 5 件。")).toBeInTheDocument();

    expect(mocks.sendChatMessage).toHaveBeenCalledWith("请查询当前库存");
  });

  it.each(copyCases)("%s 可以生成结构化商品文案", async (label, copyType) => {
    mocks.sendChatMessage.mockResolvedValue(productCopyReply(copyType));

    render(<ChatPage />);

    const productIdInput = screen.getByRole("textbox", {
      name: "商品 ID",
    });

    fireEvent.change(productIdInput, {
      target: {
        value: "product-001",
      },
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: label,
      }),
    );

    expect(await screen.findByText(`${copyType} 示例标题`)).toBeInTheDocument();

    expect(screen.getByText("适合日常通勤使用。")).toBeInTheDocument();

    expect(screen.getByText("#通勤")).toBeInTheDocument();

    expect(screen.getByText("#实用")).toBeInTheDocument();

    expect(mocks.sendChatMessage).toHaveBeenCalledWith(
      `请为商品 product-001 生成${label}。商品 ID：product-001；文案类型：${copyType}。请使用真实商品信息。`,
    );
  });

  it("复制文案后显示中文反馈", async () => {
    mocks.sendChatMessage.mockResolvedValue({
      role: "assistant",
      content: "商品文案已生成，请查看下方标题、正文和标签。",
      productCopy: {
        productId: "product-001",
        copyType: "GENERAL",
        title: "轻量随行保温杯",
        body: "适合日常通勤使用。",
        tags: ["通勤", "实用"],
      },
    });

    render(<ChatPage />);

    fireEvent.change(
      screen.getByRole("textbox", {
        name: "商品 ID",
      }),
      {
        target: {
          value: "product-001",
        },
      },
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "通用文案",
      }),
    );

    await screen.findByText("轻量随行保温杯");

    fireEvent.click(
      screen.getByRole("button", {
        name: "复制文案",
      }),
    );

    await waitFor(() =>
      expect(mocks.writeText).toHaveBeenCalledWith(
        "轻量随行保温杯\n\n适合日常通勤使用。\n\n#通勤 #实用",
      ),
    );

    expect(await screen.findByText("文案已复制")).toBeInTheDocument();
  });

  it("生成失败后保留商品 ID，重试继续使用原商品上下文", async () => {
    mocks.sendChatMessage
      .mockRejectedValueOnce(new Error("AI 服务暂时不可用，请稍后重试"))
      .mockResolvedValueOnce(productCopyReply("DOUYIN"));

    render(<ChatPage />);

    const productIdInput = screen.getByRole("textbox", {
      name: "商品 ID",
    });

    fireEvent.change(productIdInput, {
      target: {
        value: "product-001",
      },
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "抖音文案",
      }),
    );

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("暂时不可用"));

    expect(productIdInput).toHaveValue("product-001");

    const expectedPrompt =
      "请为商品 product-001 生成抖音文案。商品 ID：product-001；文案类型：DOUYIN。请使用真实商品信息。";

    expect(mocks.sendChatMessage).toHaveBeenNthCalledWith(1, expectedPrompt);

    fireEvent.click(
      screen.getByRole("button", {
        name: "重试",
      }),
    );

    expect(await screen.findByText("DOUYIN 示例标题")).toBeInTheDocument();

    expect(mocks.sendChatMessage).toHaveBeenNthCalledWith(2, expectedPrompt);
  });

  it("普通聊天失败后仍提供重试", async () => {
    mocks.sendChatMessage.mockRejectedValue(new Error("AI 服务暂时不可用，请稍后重试"));

    render(<ChatPage />);

    const input = screen.getByRole("textbox", {
      name: "消息",
    });

    fireEvent.change(input, {
      target: {
        value: "请看销售趋势",
      },
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "发送消息",
      }),
    );

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("暂时不可用"));

    expect(
      screen.getByRole("button", {
        name: "重试",
      }),
    ).toBeInTheDocument();

    expect(input).not.toBeDisabled();
  });
});

function productCopyReply(
  copyType: "TITLE" | "DESCRIPTION" | "XIAOHONGSHU" | "DOUYIN" | "GENERAL",
) {
  return {
    role: "assistant" as const,
    content: "商品文案已生成，请查看下方标题、正文和标签。",
    productCopy: {
      productId: "product-001",
      copyType,
      title: `${copyType} 示例标题`,
      body: "适合日常通勤使用。",
      tags: ["通勤", "实用"],
    },
  };
}

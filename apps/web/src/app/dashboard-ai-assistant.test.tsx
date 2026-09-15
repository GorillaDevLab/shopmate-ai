import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ sendChatMessage: vi.fn() }));
vi.mock("./chat-api", () => ({ sendChatMessage: api.sendChatMessage }));
const insightApi = vi.hoisted(() => ({ generateDashboardInsight: vi.fn() }));
vi.mock("./dashboard-insight-api", () => ({
  generateDashboardInsight: insightApi.generateDashboardInsight,
}));

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
      content:
        "## 库存风险\n\n建议优先补货无线蓝牙耳机。\n\n| 商品 | 库存 |\n| --- | --- |\n| 耳机 | 5 |",
    });
    render(<AssistantHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Ask AI" }));
    fireEvent.click(screen.getByRole("button", { name: "查看低库存" }));
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("最近哪些商品值得补货？");

    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    expect(await screen.findByText(/建议优先补货无线蓝牙耳机/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "库存风险" })).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveTextContent("耳机");
    expect(screen.getByRole("link", { name: "打开完整聊天" })).toHaveAttribute("href", "/chat");
    expect(api.sendChatMessage).toHaveBeenCalledWith("最近哪些商品值得补货？");
  });

  it("失败时显示具体错误并可重试", async () => {
    api.sendChatMessage
      .mockRejectedValueOnce(
        Object.assign(new Error("AI 服务暂时不可用，请稍后重试"), {
          retryable: true,
        }),
      )
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

  it("不可重试错误只显示提示，不显示重试按钮", async () => {
    api.sendChatMessage.mockRejectedValueOnce(
      Object.assign(new Error("回答未通过数据校验，请缩小查询范围"), {
        retryable: false,
      }),
    );

    render(<AssistantHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Ask AI" }));

    fireEvent.change(screen.getByRole("textbox", { name: "消息" }), {
      target: { value: "分析全部销售数据" },
    });

    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("缩小查询范围");
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
  });

  it("无数据时展示空态，不创建空白组件", async () => {
    const onInsightCreated = vi.fn();
    insightApi.generateDashboardInsight.mockResolvedValue({
      query: { visualization: "pie" },
      result: { kind: "pie", title: "商品销售占比", slices: [] },
    });
    render(
      <DashboardAiAssistant open onOpenChange={vi.fn()} onInsightCreated={onInsightCreated} />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "消息" }), {
      target: { value: "生成商品销售额饼图" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    expect(await screen.findByText("所选范围暂无可展示数据")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "加入看板并查看" })).not.toBeInTheDocument();
    expect(onInsightCreated).not.toHaveBeenCalled();
    expect(api.sendChatMessage).not.toHaveBeenCalled();
  });

  it("加入失败保留预览；成功后重新打开也不能重复加入", async () => {
    const onInsightCreated = vi.fn().mockImplementationOnce(() => {
      throw new Error("看板最多包含 24 张卡片");
    });
    insightApi.generateDashboardInsight.mockResolvedValue({
      query: { visualization: "pie" },
      result: {
        kind: "pie",
        title: "销售占比",
        summary: "近30天",
        unit: "currencyMinor",
        slices: [{ key: "p", label: "商品", value: 100 }],
      },
    });
    const view = render(
      <DashboardAiAssistant open onOpenChange={vi.fn()} onInsightCreated={onInsightCreated} />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "消息" }), {
      target: { value: "生成饼图" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    fireEvent.click(await screen.findByRole("button", { name: "加入看板并查看" }));
    expect(screen.getByRole("alert")).toHaveTextContent("24 张卡片");
    expect(screen.getByRole("heading", { name: "销售占比" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加入看板并查看" }));
    view.rerender(
      <DashboardAiAssistant
        open={false}
        onOpenChange={vi.fn()}
        onInsightCreated={onInsightCreated}
      />,
    );
    view.rerender(
      <DashboardAiAssistant open onOpenChange={vi.fn()} onInsightCreated={onInsightCreated} />,
    );
    expect(screen.getByRole("button", { name: "已加入看板草稿" })).toBeDisabled();
    expect(onInsightCreated).toHaveBeenCalledTimes(2);
    view.rerender(
      <DashboardAiAssistant
        open
        onOpenChange={vi.fn()}
        onInsightCreated={onInsightCreated}
        isInsightAdded={() => false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "加入看板并查看" }));
    expect(onInsightCreated).toHaveBeenCalledTimes(3);
    expect(insightApi.generateDashboardInsight).toHaveBeenCalledTimes(1);
    expect(api.sendChatMessage).not.toHaveBeenCalled();
  });
});

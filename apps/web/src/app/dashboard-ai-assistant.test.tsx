import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantStore } from "./assistant/store";
import { AssistantStoreProvider } from "./assistant/provider";
import { DashboardAiAssistant } from "./dashboard-ai-assistant";
import type { DashboardInsightPreviewResponse } from "@shopmate/contracts";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const preview: DashboardInsightPreviewResponse = {
  query: {
    dataset: "sales",
    metric: "revenue",
    aggregation: "sum",
    groupBy: "store",
    dateRange: { start: "2026-09-01", end: "2026-09-25" },
    filters: [],
    order: "desc",
    limit: 8,
    visualization: "bar",
  },
  result: {
    kind: "pie",
    title: "门店销售额",
    summary: "已查询",
    unit: "currencyMinor",
    slices: [{ key: "s1", label: "朝阳店", value: 12000 }],
  },
};
const run = vi.fn();
function setup(onAdd = vi.fn(), initialOpen = true) {
  const store = new AssistantStore(undefined, run);
  store.activate({ userId: "u", merchantId: "m" });
  function Harness() {
    const [open, setOpen] = useState(initialOpen);
    return <DashboardAiAssistant open={open} onOpenChange={setOpen} onInsightCreated={onAdd} />;
  }
  render(
    <AssistantStoreProvider store={store}>
      <Harness />
    </AssistantStoreProvider>,
  );
  return store;
}
function send(content: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: content } });
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
}
describe("共享看板助手", () => {
  beforeEach(() => {
    run.mockReset();
    HTMLDialogElement.prototype.show = function () {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute("open");
    };
  });
  it("图表后普通追问传递历史和查询范围", async () => {
    run
      .mockResolvedValueOnce({ role: "assistant", content: "分析完成", insightPreview: preview })
      .mockResolvedValueOnce({ role: "assistant", content: "这是查询时的快照。" });
    setup();
    send("近30天各门店销售额");
    await screen.findByRole("heading", { name: "门店销售额" });
    send("销量是实时的吗");
    await screen.findByText("这是查询时的快照。");
    expect(run.mock.calls[1][0]).toMatchObject({
      message: { content: "销量是实时的吗" },
      insightQuery: preview.query,
      history: expect.arrayContaining([expect.objectContaining({ content: "近30天各门店销售额" })]),
    });
  });
  it("收起重开保留消息、草稿和面板宽度", async () => {
    run.mockResolvedValue({ role: "assistant", content: "可以继续追问。" });
    setup(vi.fn(), false);
    fireEvent.click(screen.getByRole("button", { name: "Ask AI" }));
    send("我有几个店铺");
    await screen.findByText("可以继续追问。");
    fireEvent.change(screen.getByRole("textbox", { name: "消息" }), {
      target: { value: "下一问" },
    });
    fireEvent.click(screen.getByRole("button", { name: "加宽聊天面板" }));
    expect(screen.getByRole("dialog").style.getPropertyValue("--assistant-width")).toBe("820px");
    fireEvent.click(screen.getByRole("button", { name: "关闭 AI 助手" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask AI" }));
    expect(screen.getByText("可以继续追问。")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("下一问");
  });
  it("短句换图复用数据，不再调用模型", async () => {
    const add = vi.fn();
    run.mockResolvedValue({ role: "assistant", content: "分析完成", insightPreview: preview });
    setup(add);
    send("生成门店销售图");
    await screen.findByRole("heading", { name: "门店销售额" });
    send("我要饼图");
    await screen.findByText(/已将上一张图切换/);
    fireEvent.click(screen.getByRole("button", { name: "加入看板并查看" }));
    expect(add).toHaveBeenCalledWith(preview, "pie");
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("没有前一张图时说明缺少范围，不调用模型", async () => {
    setup();
    send("我要饼图");
    await screen.findByText(/请先说明要分析的指标/);
    expect(run).not.toHaveBeenCalled();
  });
  it("错误保留输入，不偷偷重发", async () => {
    run.mockRejectedValue(new Error("服务暂时不可用，未自动重试。"));
    setup();
    send("经营怎么样");
    await screen.findByText("服务暂时不可用，未自动重试。");
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("经营怎么样");
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("空图不能加入看板", async () => {
    run.mockResolvedValue({
      role: "assistant",
      content: "没有数据",
      insightPreview: { ...preview, result: { ...preview.result, slices: [] } },
    });
    setup();
    send("画门店销售额");
    await screen.findByText(/当前没有可展示数据/);
    expect(screen.queryByRole("button", { name: "加入看板并查看" })).not.toBeInTheDocument();
  });
  it("加入失败保留预览并允许重新加入", async () => {
    const add = vi.fn().mockImplementationOnce(() => {
      throw new Error("布局尚未就绪");
    });
    run.mockResolvedValue({ role: "assistant", content: "完成", insightPreview: preview });
    setup(add);
    send("画门店销售额");
    const button = await screen.findByRole("button", { name: "加入看板并查看" });
    fireEvent.click(button);
    expect(screen.getByRole("alert")).toHaveTextContent("布局尚未就绪");
    fireEvent.click(button);
    expect(add).toHaveBeenCalledTimes(2);
  });
});

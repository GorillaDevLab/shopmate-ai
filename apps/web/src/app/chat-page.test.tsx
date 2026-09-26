import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ChatPage from "./chat/page";
import { AssistantStore } from "./assistant/store";
import { AssistantStoreProvider } from "./assistant/provider";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
const run = vi.fn(),
  writeText = vi.fn();
function setup() {
  const store = new AssistantStore(undefined, run);
  store.activate({ userId: "u", merchantId: "m" });
  render(
    <AssistantStoreProvider store={store}>
      <ChatPage />
    </AssistantStoreProvider>,
  );
  return store;
}
describe("完整助手工作区", () => {
  beforeEach(() => {
    run.mockReset();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  });
  it("建议仅填草稿，用户发送后才调用", async () => {
    run.mockResolvedValue({ role: "assistant", content: "门店经营正常。" });
    setup();
    fireEvent.click(screen.getByRole("button", { name: /最近经营怎么样/ }));
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await screen.findByText("门店经营正常。");
    expect(run.mock.calls[0][0].message.content).toBe("最近经营怎么样？");
  });
  it.each([
    ["标题文案", "TITLE"],
    ["商品描述", "DESCRIPTION"],
    ["小红书文案", "XIAOHONGSHU"],
    ["抖音文案", "DOUYIN"],
    ["通用文案", "GENERAL"],
  ])("保留%s功能", async (label, copyType) => {
    run.mockResolvedValue({
      role: "assistant",
      content: "文案已生成",
      productCopy: {
        productId: "p1",
        copyType,
        title: "示例标题",
        body: "日常通勤",
        tags: ["实用"],
      },
    });
    setup();
    fireEvent.click(screen.getByText("商品文案工具"));
    fireEvent.change(screen.getByRole("textbox", { name: "商品 ID" }), { target: { value: "p1" } });
    fireEvent.click(screen.getByRole("button", { name: label }));
    await screen.findByText("示例标题");
    expect(run.mock.calls[0][0].productCopy).toEqual({ productId: "p1", copyType });
    fireEvent.click(screen.getByRole("button", { name: "复制文案" }));
    await screen.findByText("文案已复制");
    expect(writeText).toHaveBeenCalledWith("示例标题\n\n日常通勤\n\n#实用");
  });
  it("失败保留问题和商品 ID，不自动重试", async () => {
    run.mockRejectedValue(new Error("文案暂时不可用"));
    setup();
    fireEvent.click(screen.getByText("商品文案工具"));
    fireEvent.change(screen.getByRole("textbox", { name: "商品 ID" }), { target: { value: "p1" } });
    fireEvent.click(screen.getByRole("button", { name: "标题文案" }));
    await screen.findByText("文案暂时不可用");
    expect(screen.getByRole("textbox", { name: "商品 ID" })).toHaveValue("p1");
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("请为商品 p1 生成标题文案");
  });
});

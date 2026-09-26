import { beforeEach, describe, it, expect, vi } from "vitest";
import { AssistantStore } from "./store";
const identity = { userId: "u", merchantId: "m" };
describe("shared assistant store", () => {
  beforeEach(() => localStorage.clear());
  it("重命名和删除只影响目标会话", () => {
    const store = new AssistantStore(localStorage);
    store.activate(identity);
    store.create();
    const first = store.getSnapshot().currentId;
    store.rename(first, "经营分析");
    store.create();
    const second = store.getSnapshot().currentId;
    store.remove(first);
    expect(store.getSnapshot().currentId).toBe(second);
    expect(store.getSnapshot().sessions).toHaveLength(1);
    store.remove(second);
    expect(store.getSnapshot().currentId).toBe("");
    expect(store.getSnapshot().sessions).toHaveLength(0);
  });
  it("重复发送只执行一次", async () => {
    let resolve: (value: { role: "assistant"; content: string }) => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<{ role: "assistant"; content: string }>((r) => {
          resolve = r;
        }),
    );
    const store = new AssistantStore(localStorage, run);
    store.activate(identity);
    const first = store.submit("经营分析");
    await store.submit("重复问题");
    expect(run).toHaveBeenCalledOnce();
    resolve({ role: "assistant", content: "完成" });
    await first;
  });
  it("keeps draft and history across selection and hydration", async () => {
    const store = new AssistantStore(
      localStorage,
      vi.fn().mockResolvedValue({ role: "assistant", content: "完成" }),
    );
    store.activate(identity);
    store.create();
    const first = store.getSnapshot().currentId;
    store.setDraft("经营怎么样");
    await store.submit();
    store.create();
    store.select(first);
    expect(store.getSnapshot().sessions.find((s) => s.id === first)?.messages).toHaveLength(2);
    store.flush();
    const restored = new AssistantStore(localStorage);
    restored.activate(identity);
    expect(restored.getSnapshot().currentId).toBe(first);
  });
  it("stops and ignores late replies", async () => {
    let resolve: (v: { role: "assistant"; content: string }) => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<{ role: "assistant"; content: string }>((r) => {
          resolve = r;
        }),
    );
    const store = new AssistantStore(localStorage, run);
    store.activate(identity);
    store.create();
    store.setDraft("问题");
    const task = store.submit();
    store.stop();
    resolve({ role: "assistant", content: "迟到" });
    await task;
    expect(store.getSnapshot().sessions[0]?.messages.some((m) => m.content === "迟到")).toBe(false);
    expect(store.getSnapshot().runningId).toBe("");
  });
  it("clears identity data and isolates tenants", () => {
    const store = new AssistantStore(localStorage);
    store.activate(identity);
    store.create();
    store.setDraft("私密");
    store.flush();
    store.clear();
    store.activate({ userId: "u", merchantId: "other" });
    expect(store.getSnapshot().sessions).toHaveLength(0);
    store.activate(identity);
    expect(store.getSnapshot().sessions).toHaveLength(0);
  });
  it("刷新时标记未完成请求，不自动重发", async () => {
    const run = vi.fn(() => new Promise<never>(() => undefined));
    const store = new AssistantStore(localStorage, run);
    store.activate(identity);
    void store.submit("查询经营");
    store.flush();
    const restored = new AssistantStore(localStorage, run);
    restored.activate(identity);
    expect(restored.getSnapshot().sessions[0]?.messages.at(-1)?.status).toBe("stopped");
    expect(restored.getSnapshot().sessions[0]?.draft).toBe("查询经营");
    expect(run).toHaveBeenCalledTimes(1);
    store.stop();
  });
  it("请求失败不覆盖等待期间输入的新草稿", async () => {
    let reject: (e: Error) => void = () => undefined;
    const store = new AssistantStore(
      localStorage,
      vi.fn(
        () =>
          new Promise<never>((_resolve, r) => {
            reject = r;
          }),
      ),
    );
    store.activate(identity);
    const task = store.submit("查询经营");
    store.setDraft("接下来比较门店");
    reject(new Error("失败"));
    await task;
    expect(store.getSnapshot().sessions[0]?.draft).toBe("接下来比较门店");
  });
  it("存储失败仍可使用会话，并明确提示未保存", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: vi.fn(),
    };
    const store = new AssistantStore(storage);
    store.activate(identity);
    store.setDraft("草稿");
    store.flush();
    expect(store.getSnapshot().warning).toContain("历史暂未保存");
    expect(store.getSnapshot().sessions[0]?.draft).toBe("草稿");
  });
});

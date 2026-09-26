import { describe, expect, it, vi } from "vitest";
import { BusinessAgent } from "./business-agent.js";
import { ToolRegistry } from "../tools/tool-registry.js";
describe("agent execution control", () => {
  it("does not call provider when already cancelled", async () => {
    const provider = { name: "fake", generate: vi.fn() };
    const controller = new AbortController();
    controller.abort();
    await expect(
      new BusinessAgent(provider, new ToolRegistry({ allowedToolNames: [] })).run({
        question: "你好",
        context: { userId: "u", merchantId: "m", permissions: [] },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(provider.generate).not.toHaveBeenCalled();
  });
  it("reports actual model stage and forwards signal", async () => {
    const signal = new AbortController().signal;
    const provider = {
      name: "fake",
      generate: vi
        .fn()
        .mockResolvedValue({
          message: { role: "assistant", content: "可以帮你分析经营数据。" },
          finishReason: "stop",
        }),
    };
    const onProgress = vi.fn();
    await new BusinessAgent(provider, new ToolRegistry({ allowedToolNames: [] })).run({
      question: "你好",
      context: { userId: "u", merchantId: "m", permissions: [] },
      signal,
      onProgress,
    });
    expect(provider.generate.mock.calls[0]?.[0].signal).toBe(signal);
    expect(onProgress).toHaveBeenCalledWith("composing", expect.any(String));
  });
});

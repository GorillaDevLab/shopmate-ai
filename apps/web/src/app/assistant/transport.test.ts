import { describe, it, expect, vi, afterEach } from "vitest";
import { runAssistant } from "./transport";
afterEach(() => vi.unstubAllGlobals());
const request = { requestId: "r", message: { role: "user" as const, content: "你好" } };
function mockStream(chunks: string[]) {
  const bytes = new TextEncoder();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            for (const chunk of chunks) c.enqueue(bytes.encode(chunk));
            c.close();
          },
        }),
        { headers: { "Content-Type": "application/x-ndjson" } },
      ),
    ),
  );
}
describe("assistant transport", () => {
  it("parses split records and emits real progress", async () => {
    mockStream([
      '{"type":"accepted","requestId":"r","label":"正在',
      '查询"}\n',
      JSON.stringify({
        type: "completed",
        requestId: "r",
        reply: { role: "assistant", content: "完成" },
      }) + "\n",
    ]);
    const onEvent = vi.fn();
    expect((await runAssistant(request, new AbortController().signal, onEvent)).content).toBe(
      "完成",
    );
    expect(onEvent).toHaveBeenCalledTimes(2);
  });
  it("does not resend incomplete streams", async () => {
    mockStream(['{"type":"accepted","requestId":"r","label":"收到"}\n']);
    await expect(runAssistant(request, new AbortController().signal, vi.fn())).rejects.toThrow(
      "连接中断",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

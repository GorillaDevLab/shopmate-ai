import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { AssistantRunController } from "./assistant-run.controller.js";
import type { AiChatService } from "./ai-chat.service.js";
function response() {
  return Object.assign(new EventEmitter(), {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    writableEnded: false,
  });
}
const context = { userId: "u", merchantId: "m", permissions: [] };
const body = { requestId: "r", message: { role: "user", content: "经营怎么样" } };
describe("assistant run transport", () => {
  it("emits verified completion and rejects duplicate execution", async () => {
    const chat = vi.fn().mockResolvedValue({ message: { role: "assistant", content: "查询完成" } });
    const controller = new AssistantRunController({ chat } as unknown as AiChatService);
    const res = response();
    await controller.run(context, body, res);
    expect(res.write.mock.calls.map(([s]) => JSON.parse(s).type)).toEqual([
      "accepted",
      "completed",
    ]);
    await expect(controller.run(context, body, response())).rejects.toMatchObject({ status: 409 });
    expect(chat).toHaveBeenCalledTimes(1);
  });
  it("disconnect aborts model signal and ignores late response", async () => {
    const res = response();
    const chat = vi.fn(async (_c, _b, control) => {
      res.emit("close");
      expect(control.signal.aborted).toBe(true);
      return { message: { role: "assistant", content: "迟到" } };
    });
    await new AssistantRunController({ chat } as unknown as AiChatService).run(context, body, res);
    expect(res.write.mock.calls.some(([s]) => JSON.parse(s).type === "completed")).toBe(false);
  });
});

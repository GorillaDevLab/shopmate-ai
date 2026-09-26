import {
  AssistantRunEventSchema,
  type AssistantRunRequest,
  type AssistantRunEvent,
  type AssistantReply,
} from "@shopmate/contracts";

export class AssistantTransportError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

export async function runAssistant(
  request: AssistantRunRequest,
  signal: AbortSignal,
  onEvent: (event: AssistantRunEvent) => void,
): Promise<AssistantReply> {
  const response = await fetch("/api/v1/ai/assistant/run", {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    signal,
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
    body: JSON.stringify(request),
  });
  if (!response.ok)
    throw new AssistantTransportError(
      response.status === 401
        ? "登录已失效，请重新登录。"
        : response.status === 409
          ? "已有请求正在执行或该请求已经提交，请勿重复发送。"
          : "服务暂时无法接收请求，未自动重试。",
      response.status,
    );
  if (!response.headers.get("content-type")?.includes("application/x-ndjson") || !response.body)
    throw new AssistantTransportError("服务返回格式异常，请检查部署版本。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("Stopped", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 2 * 1024 * 1024) throw new AssistantTransportError("回复过长，请缩小查询范围。");
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          const event = AssistantRunEventSchema.parse(JSON.parse(line));
          if (event.requestId !== request.requestId)
            throw new AssistantTransportError("回复与当前请求不匹配。");
          onEvent(event);
          if (event.type === "failed") throw new AssistantTransportError(event.message);
          if (event.type === "completed") return event.reply;
        }
        newline = buffer.indexOf("\n");
      }
    }
    throw new AssistantTransportError("连接中断，结果尚未确认。没有自动重新提交。");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

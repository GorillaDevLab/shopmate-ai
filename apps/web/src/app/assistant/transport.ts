import {
  AgentActionConfirmResponseSchema,
  AssistantRunEventSchema,
  type AgentActionConfirmResponse,
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
          const event = parseEvent(line);
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

function parseEvent(line: string): AssistantRunEvent {
  try {
    return AssistantRunEventSchema.parse(JSON.parse(line));
  } catch {
    throw new AssistantTransportError("回复格式校验失败，未自动重试。请检查前后端部署版本。");
  }
}

/** 用户在确认卡片上点确认/取消；模型不会调用这两个接口。 */
export async function confirmAgentAction(actionId: string): Promise<AgentActionConfirmResponse> {
  const response = await postAction(actionId, "confirm");
  const parsed = AgentActionConfirmResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success)
    throw new AssistantTransportError("执行结果格式异常，请刷新后查看是否已生效。");
  return parsed.data;
}

export async function cancelAgentAction(actionId: string): Promise<void> {
  await postAction(actionId, "cancel");
}

async function postAction(actionId: string, action: "confirm" | "cancel"): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/ai/actions/${encodeURIComponent(actionId)}/${action}`, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  } catch {
    throw new AssistantTransportError("无法连接服务，操作结果未知，请刷新后确认是否已生效。");
  }
  if (response.ok) return response;
  const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
  throw new AssistantTransportError(
    actionErrorMessage(response.status, body?.message),
    response.status,
  );
}

function actionErrorMessage(status: number, serverMessage: unknown): string {
  if (status === 401) return "登录已失效，请重新登录。";
  if (status === 404) return "这张卡片已失效（可能已处理或服务已重启），请让 AI 重新生成。";
  if (status === 410) return "确认已过期，请让 AI 按最新数据重新生成。";
  if (status === 403) return "当前账号没有执行此操作的权限。";
  // 冲突、上限等由服务端给出具体原因（已按 schema 限长）。
  if (typeof serverMessage === "string" && serverMessage.length <= 280) return serverMessage;
  return "操作未能执行，请稍后重试。";
}

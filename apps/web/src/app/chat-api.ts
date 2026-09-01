import { AiChatResponseSchema, type AiChatResponse } from "@shopmate/contracts";

export class ChatApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ChatApiError";
  }
}

export async function sendChatMessage(content: string, signal?: AbortSignal): Promise<AiChatResponse["message"]> {
  const message = content.trim();
  if (!message) throw new ChatApiError("请输入想了解的经营问题", 400);

  let response: Response;
  try {
    response = await fetch("/api/v1/ai/chat", {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ message: { role: "user", content: message } }),
      signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ChatApiError("无法连接 AI 服务，请稍后重试", 0, true);
  }

  if (!response.ok) {
    throw new ChatApiError(
      response.status === 401 ? "登录已失效，请重新登录" : "AI 服务暂时不可用，请稍后重试",
      response.status,
      response.status >= 500,
    );
  }
  const payload = await readJson(response);
  const parsed = AiChatResponseSchema.safeParse(payload);
  if (!parsed.success) throw new ChatApiError("AI 回复格式异常，请稍后重试", 502, true);
  return parsed.data.message;
}

function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => {
    throw new ChatApiError("AI 回复格式异常，请稍后重试", 502, true);
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

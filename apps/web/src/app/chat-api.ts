import {
  AiChatResponseSchema,
  type AiChatResponse,
  type AiChatRequest,
  type ProductCopyRequest,
} from "@shopmate/contracts";

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

export async function sendChatMessage(
  content: string,
  signal?: AbortSignal,
  productCopy?: ProductCopyRequest,
  history?: AiChatRequest["history"],
): Promise<AiChatResponse["message"]> {
  const message = content.trim();
  if (!message) throw new ChatApiError("请输入想了解的经营问题", 400);

  let response: Response;
  try {
    response = await fetch("/api/v1/ai/chat", {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        message: { role: "user", content: message },
        ...(productCopy ? { productCopy } : {}),
        ...(history?.length ? { history } : {}),
      }),
      signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ChatApiError("无法连接 AI 服务，请稍后重试", 0, true);
  }

  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const code =
      payload && typeof payload === "object" && "code" in payload ? String(payload.code) : "";

    const retryable =
      payload &&
      typeof payload === "object" &&
      "retryable" in payload &&
      typeof payload.retryable === "boolean"
        ? payload.retryable
        : response.status >= 500;

    throw new ChatApiError(
      response.status === 401
        ? "登录已失效，请重新登录"
        : Object.hasOwn(CHAT_ERRORS, code)
          ? CHAT_ERRORS[code]!
          : "AI 服务暂时不可用，请稍后重试",
      response.status,
      retryable,
    );
  }
  const payload = await readJson(response);
  const parsed = AiChatResponseSchema.safeParse(payload);
  if (!parsed.success) throw new ChatApiError("AI 回复格式异常，请稍后重试", 502, true);
  return parsed.data.message;
}

const CHAT_ERRORS: Record<string, string> = {
  AI_TIMEOUT: "生成请求超时，结果尚未确认。未自动重试；再次提交可能产生费用。",
  AI_CONFIGURATION: "AI 服务配置异常，请联系管理员。",
  AI_RATE_LIMIT: "AI 服务繁忙，请稍后再试。未自动重试。",
  AI_INVALID_RESPONSE: "生成结果格式不符合要求，未自动重试。",
  AI_RESPONSE_REJECTED: "自动修正后仍未通过数据校验，请缩小查询范围。",
  AI_TOOL_LIMIT: "本次查询达到处理上限，请缩小查询范围。未自动重试。",
  PRODUCT_NOT_FOUND: "当前店铺未找到该商品，请检查商品 ID（不是 SKU 编码）。",
  AI_FORBIDDEN: "没有访问该商品的权限。",
};

function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => {
    throw new ChatApiError("AI 回复格式异常，请稍后重试", 502, true);
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

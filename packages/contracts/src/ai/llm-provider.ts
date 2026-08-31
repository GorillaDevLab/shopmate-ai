export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type LLMRole = "system" | "user" | "assistant" | "tool";

export interface LLMSystemMessage {
  readonly role: "system";
  readonly content: string;
}

export interface LLMUserMessage {
  readonly role: "user";
  readonly content: string;
}

export interface LLMToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonObject;
}

export interface LLMAssistantMessage {
  readonly role: "assistant";
  readonly content: string | null;
  readonly toolCalls?: readonly LLMToolCall[];
}

export interface LLMToolMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly name: string;
  readonly content: string;
}

export type LLMMessage = LLMSystemMessage | LLMUserMessage | LLMAssistantMessage | LLMToolMessage;

export interface LLMToolDefinition {
  readonly name: string;
  readonly description: string;

  /**
   * Provider-neutral JSON Schema object.
   *
   * The Provider adapter is responsible for translating this
   * definition into the format required by the concrete model API.
   */
  readonly inputSchema: JsonObject;
}

export type LLMFinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "error";

export interface LLMTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface LLMGenerationRequest {
  readonly messages: readonly LLMMessage[];
  readonly tools?: readonly LLMToolDefinition[];

  /**
   * Stable model identifier understood by the selected Provider.
   * G3 will validate the concrete configured model.
   */
  readonly model?: string;

  readonly temperature?: number;
  readonly maxOutputTokens?: number;

  /**
   * Defaults to zh-CN when omitted.
   */
  readonly locale?: string;
}

export interface LLMGenerationResult {
  readonly message: LLMAssistantMessage;
  readonly finishReason: LLMFinishReason;
  readonly usage?: LLMTokenUsage;

  /**
   * Optional provider request ID for diagnostics.
   * It must never contain credentials.
   */
  readonly requestId?: string;
}

export interface LLMProvider {
  readonly name: string;

  generate(request: LLMGenerationRequest): Promise<LLMGenerationResult>;
}

export type LLMProviderErrorCode =
  | "CONFIGURATION"
  | "AUTHENTICATION"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "NETWORK"
  | "INVALID_REQUEST"
  | "INVALID_RESPONSE"
  | "CONTENT_FILTER"
  | "UNKNOWN";

export interface LLMProviderErrorOptions {
  readonly code: LLMProviderErrorCode;
  readonly message: string;
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

export class LLMProviderError extends Error {
  readonly code: LLMProviderErrorCode;
  readonly retryable: boolean;

  constructor(options: LLMProviderErrorOptions) {
    super(options.message, {
      cause: options.cause,
    });

    this.name = "LLMProviderError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
  }
}

export const DEFAULT_LLM_LOCALE = "zh-CN";

export const DEFAULT_LLM_SYSTEM_POLICY_ZH_CN = [
  "默认使用简体中文回答。",
  "仅依据用户提供的信息、系统上下文以及已验证工具返回的数据作答。",
  "不得编造、猜测或虚构任何经营数据，包括销售额、订单、销量、库存、SKU、成本、商品表现和趋势。",
  "当经营数据缺失、无法验证或工具未返回所需信息时，必须明确说明数据不足，不得用假设值替代真实数据。",
  "需要经营数据时，应优先请求必要信息或调用已经注册并授权的工具。",
].join("\n");

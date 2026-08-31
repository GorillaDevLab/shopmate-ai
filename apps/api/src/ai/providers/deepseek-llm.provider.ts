import { Injectable } from "@nestjs/common";
import OpenAI from "openai";

import {
  DEFAULT_LLM_LOCALE,
  DEFAULT_LLM_SYSTEM_POLICY_ZH_CN,
  LLMProviderError,
  type JsonObject,
  type JsonValue,
  type LLMFinishReason,
  type LLMGenerationRequest,
  type LLMGenerationResult,
  type LLMMessage,
  type LLMProvider,
  type LLMToolDefinition,
} from "@shopmate/contracts";

import {
  DEEPSEEK_MODELS,
  readDeepSeekEnv,
  requireDeepSeekApiKey,
  type DeepSeekConfig,
  type DeepSeekModel,
} from "../../config/deepseek-env.js";

type DeepSeekCompletionRequest = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
  readonly thinking: {
    readonly type: "disabled";
  };
};

interface DeepSeekCompletionResponse {
  readonly id: string;

  readonly choices: readonly {
    readonly finish_reason: string | null;

    readonly message: {
      readonly content: string | null;
      readonly tool_calls?:
        | readonly OpenAI.Chat.Completions.ChatCompletionMessageToolCall[]
        | undefined;
    };
  }[];

  readonly usage?:
    | {
        readonly prompt_tokens: number;
        readonly completion_tokens: number;
        readonly total_tokens: number;
      }
    | null
    | undefined;

  readonly _request_id?: string | null;
}

export interface DeepSeekChatCompletionsClient {
  create(
    request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<DeepSeekCompletionResponse>;
}

export interface DeepSeekLLMProviderOptions {
  readonly env?: NodeJS.ProcessEnv;

  /**
   * Tests may inject a fake client.
   * Production leaves this undefined and uses the OpenAI-compatible SDK.
   */
  readonly client?: DeepSeekChatCompletionsClient;
}

@Injectable()
export class DeepSeekLLMProvider implements LLMProvider {
  readonly name = "deepseek";

  private readonly config: DeepSeekConfig;
  private readonly client: DeepSeekChatCompletionsClient;

  constructor(options: DeepSeekLLMProviderOptions = {}) {
    this.config = loadConfig(options.env ?? process.env);

    if (options.client) {
      this.client = options.client;
      return;
    }

    let apiKey: string;

    try {
      apiKey = requireDeepSeekApiKey(this.config);
    } catch {
      throw new LLMProviderError({
        code: "CONFIGURATION",
        message: "DeepSeek Provider 配置不完整：缺少 DEEPSEEK_API_KEY。",
        retryable: false,
      });
    }

    const sdk = new OpenAI({
      apiKey,
      baseURL: this.config.baseUrl,
      timeout: this.config.timeoutMs,

      /**
       * Provider 层统一控制错误行为，
       * 避免 SDK 自动重试让测试和调用时间不可预测。
       */
      maxRetries: 0,
    });

    this.client = {
      create: (request) => sdk.chat.completions.create(request),
    };
  }

  async generate(request: LLMGenerationRequest): Promise<LLMGenerationResult> {
    const model = resolveModel(request.model, this.config.model);

    const body = buildCompletionRequest(request, model);

    try {
      const response = await this.client.create(body);

      return mapCompletionResponse(response);
    } catch (error: unknown) {
      throw mapProviderError(error);
    }
  }
}

function loadConfig(env: NodeJS.ProcessEnv): DeepSeekConfig {
  try {
    return readDeepSeekEnv(env);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "未知配置错误";

    throw new LLMProviderError({
      code: "CONFIGURATION",
      message: `DeepSeek Provider 配置无效：${detail}`,
      retryable: false,
    });
  }
}

function resolveModel(
  requestedModel: string | undefined,
  configuredModel: DeepSeekModel,
): DeepSeekModel {
  if (!requestedModel) {
    return configuredModel;
  }

  if (!DEEPSEEK_MODELS.some((model) => model === requestedModel)) {
    throw new LLMProviderError({
      code: "INVALID_REQUEST",
      message: "请求指定了不受支持的 DeepSeek 模型。",
      retryable: false,
    });
  }

  return requestedModel as DeepSeekModel;
}

function buildCompletionRequest(
  request: LLMGenerationRequest,
  model: DeepSeekModel,
): DeepSeekCompletionRequest {
  const messages = buildProviderMessages(request);

  const tools = request.tools?.length ? request.tools.map(mapToolDefinition) : undefined;

  return {
    model,
    messages,
    stream: false,

    thinking: {
      type: "disabled",
    },
    ...(tools
      ? {
          tools,
          tool_choice: "auto" as const,
        }
      : {}),

    ...(request.temperature !== undefined
      ? {
          temperature: request.temperature,
        }
      : {}),

    ...(request.maxOutputTokens !== undefined
      ? {
          max_tokens: request.maxOutputTokens,
        }
      : {}),
  };
}

function buildProviderMessages(
  request: LLMGenerationRequest,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const messages = request.messages.map(mapMessage);

  const locale = request.locale ?? DEFAULT_LLM_LOCALE;

  if (locale === "zh-CN") {
    return [
      {
        role: "system",
        content: DEFAULT_LLM_SYSTEM_POLICY_ZH_CN,
      },
      ...messages,
    ];
  }

  return messages;
}

function mapMessage(message: LLMMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  switch (message.role) {
    case "system":
      return {
        role: "system",
        content: message.content,
      };

    case "user":
      return {
        role: "user",
        content: message.content,
      };

    case "assistant":
      return {
        role: "assistant",
        content: message.content,

        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((toolCall) => ({
                id: toolCall.id,
                type: "function" as const,
                function: {
                  name: toolCall.name,
                  arguments: JSON.stringify(toolCall.arguments),
                },
              })),
            }
          : {}),
      };

    case "tool":
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      };
  }
}

function mapToolDefinition(tool: LLMToolDefinition): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: "function",

    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        ...tool.inputSchema,
      },
    },
  };
}

function mapCompletionResponse(response: DeepSeekCompletionResponse): LLMGenerationResult {
  const choice = response.choices[0];

  if (!choice) {
    throw new LLMProviderError({
      code: "INVALID_RESPONSE",
      message: "DeepSeek 返回了空响应。",
      retryable: false,
    });
  }

  const toolCalls = choice.message.tool_calls?.map(mapToolCall);

  const usage = response.usage
    ? {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      }
    : undefined;

  return {
    message: {
      role: "assistant",
      content: choice.message.content,

      ...(toolCalls?.length
        ? {
            toolCalls,
          }
        : {}),
    },

    finishReason: mapFinishReason(choice.finish_reason),

    ...(usage
      ? {
          usage,
        }
      : {}),

    requestId: response._request_id ?? response.id,
  };
}

function mapToolCall(toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall) {
  if (toolCall.type !== "function") {
    throw new LLMProviderError({
      code: "INVALID_RESPONSE",
      message: "DeepSeek 返回了不支持的工具调用类型。",
      retryable: false,
    });
  }

  return {
    id: toolCall.id,
    name: toolCall.function.name,
    arguments: parseToolArguments(toolCall.function.arguments),
  };
}

function parseToolArguments(rawArguments: string): JsonObject {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawArguments) as unknown;
  } catch {
    throw new LLMProviderError({
      code: "INVALID_RESPONSE",
      message: "DeepSeek 返回了无效的工具参数 JSON。",
      retryable: false,
    });
  }

  if (!isJsonObject(parsed)) {
    throw new LLMProviderError({
      code: "INVALID_RESPONSE",
      message: "DeepSeek 工具参数必须是 JSON 对象。",
      retryable: false,
    });
  }

  return parsed;
}

function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return isJsonObject(value);
}

function mapFinishReason(reason: string | null): LLMFinishReason {
  switch (reason) {
    case "stop":
      return "stop";

    case "tool_calls":
    case "function_call":
      return "tool_calls";

    case "length":
      return "length";

    case "content_filter":
      return "content_filter";

    default:
      return "error";
  }
}

function mapProviderError(error: unknown): LLMProviderError {
  if (error instanceof LLMProviderError) {
    return error;
  }

  const errorName = readStringProperty(error, "name");

  const status = readNumberProperty(error, "status");

  if (errorName === "APIConnectionTimeoutError") {
    return new LLMProviderError({
      code: "TIMEOUT",
      message: "DeepSeek 请求超时。",
      retryable: true,
    });
  }

  if (status === 401 || status === 403) {
    return new LLMProviderError({
      code: "AUTHENTICATION",
      message: "DeepSeek 认证失败，请检查 API Key。",
      retryable: false,
    });
  }

  if (status === 429) {
    return new LLMProviderError({
      code: "RATE_LIMIT",
      message: "DeepSeek 请求频率受限，请稍后重试。",
      retryable: true,
    });
  }

  if (status === 408) {
    return new LLMProviderError({
      code: "TIMEOUT",
      message: "DeepSeek 请求超时。",
      retryable: true,
    });
  }

  if (status === 400 || status === 404 || status === 422) {
    return new LLMProviderError({
      code: "INVALID_REQUEST",
      message: "DeepSeek 拒绝了无效请求。",
      retryable: false,
    });
  }

  if (errorName === "APIConnectionError" || (status !== undefined && status >= 500)) {
    return new LLMProviderError({
      code: "NETWORK",
      message: "DeepSeek 服务暂时不可用。",
      retryable: true,
    });
  }

  return new LLMProviderError({
    code: "UNKNOWN",
    message: "DeepSeek Provider 调用失败。",
    retryable: false,
  });
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  return typeof record[key] === "string" ? record[key] : undefined;
}

function readNumberProperty(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  return typeof record[key] === "number" ? record[key] : undefined;
}

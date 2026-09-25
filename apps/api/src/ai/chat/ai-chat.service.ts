import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
  HttpException,
} from "@nestjs/common";
import {
  AiChatRequestSchema,
  AiChatResponseSchema,
  ProductCopyOutputSchema,
  LLMProviderError,
  type AiChatResponse,
  type AiChatRequest,
  type LLMProvider,
  type ProductCopyOutput,
  type ProductCopyRequest,
} from "@shopmate/contracts";

import type { AuthContext } from "../../auth/contracts/index.js";
import { BusinessAgent, type BusinessAgentResult } from "../agent/business-agent.js";
import {
  createToolInvocationContext,
  ToolRegistry,
  ToolRegistryError,
} from "../tools/tool-registry.js";

export interface BusinessAgentRunner {
  run(input: {
    readonly question: string;
    readonly history?: AiChatRequest["history"];
    readonly insightQuery?: AiChatRequest["insightQuery"];
    readonly context: ReturnType<typeof createToolInvocationContext>;
  }): Promise<BusinessAgentResult>;
}

@Injectable()
export class AiChatService {
  private readonly agent: BusinessAgentRunner;

  constructor(
    agentOrProvider: BusinessAgentRunner | LLMProvider,
    private readonly registry?: ToolRegistry,
  ) {
    this.agent = isAgent(agentOrProvider)
      ? agentOrProvider
      : new BusinessAgent(agentOrProvider, registry ?? new ToolRegistry({ allowedToolNames: [] }));
  }

  async chat(context: AuthContext, rawRequest: unknown): Promise<AiChatResponse> {
    const request = AiChatRequestSchema.safeParse(rawRequest);
    if (!request.success) throwInvalidChatMessage();

    try {
      if (request.data.productCopy)
        return await this.generateCopy(context, request.data.productCopy);
      const result = await this.agent.run({
        question: request.data.message.content,
        ...(request.data.history ? { history: request.data.history } : {}),
        ...(request.data.insightQuery ? { insightQuery: request.data.insightQuery } : {}),
        context: createToolInvocationContext(context),
      });

      if (result.status !== "completed") {
        if (result.failureCode)
          throw new ServiceUnavailableException({
            statusCode: 503,
            code: result.failureCode,
            retryable: false,
          });
        throwChatUnavailable();
      }

      return formatReply(result);
    } catch (error: unknown) {
      throwKnownFailure(error);
      if (error instanceof BadRequestException || error instanceof ServiceUnavailableException) {
        throw error;
      }
      throwChatUnavailable();
    }
  }

  private async generateCopy(
    context: AuthContext,
    input: ProductCopyRequest,
  ): Promise<AiChatResponse> {
    if (!this.registry)
      throw new LLMProviderError({
        code: "CONFIGURATION",
        message: "文案工具未配置",
        retryable: false,
      });
    const productCopy = ProductCopyOutputSchema.parse(
      await this.registry.invoke(
        "generate_product_copy",
        input,
        createToolInvocationContext(context),
      ),
    );
    return {
      message: {
        role: "assistant",
        content: "商品文案已生成，请查看下方标题、正文和标签。",
        productCopy,
      },
    };
  }
}

function formatReply(result: BusinessAgentResult): AiChatResponse {
  const productCopy = findLatestProductCopy(result);
  return AiChatResponseSchema.parse({
    message: {
      role: "assistant",
      content: result.answer,
      ...(productCopy ? { productCopy } : {}),
    },
  });
}

function throwKnownFailure(error: unknown): void {
  if (error instanceof ToolRegistryError) {
    if (error.code === "FORBIDDEN") throw new HttpException({ code: "AI_FORBIDDEN" }, 403);
    if (error.code === "INVALID_OUTPUT")
      throw new HttpException({ code: "AI_INVALID_RESPONSE" }, 502);
    if (error.cause) throwKnownFailure(error.cause);
  }
  if (error instanceof HttpException && error.getStatus() === 404) {
    throw new HttpException({ code: "PRODUCT_NOT_FOUND" }, 404);
  }
  if (error instanceof LLMProviderError) {
    const codes: Record<string, string> = {
      TIMEOUT: "AI_TIMEOUT",
      AUTHENTICATION: "AI_CONFIGURATION",
      CONFIGURATION: "AI_CONFIGURATION",
      RATE_LIMIT: "AI_RATE_LIMIT",
      INVALID_RESPONSE: "AI_INVALID_RESPONSE",
    };
    throw new HttpException(
      { code: codes[error.code] ?? "AI_CHAT_UNAVAILABLE", retryable: false },
      error.code === "TIMEOUT" ? 504 : 503,
    );
  }
}

function isAgent(value: BusinessAgentRunner | LLMProvider): value is BusinessAgentRunner {
  return "run" in value;
}

function findLatestProductCopy(result: BusinessAgentResult): ProductCopyOutput | undefined {
  const outputs = result.toolOutputs ?? [];

  for (let index = outputs.length - 1; index >= 0; index -= 1) {
    const item = outputs[index];

    if (item?.name !== "generate_product_copy") {
      continue;
    }

    const parsed = ProductCopyOutputSchema.safeParse(item.output);

    if (parsed.success) {
      return parsed.data;
    }
  }

  return undefined;
}

function throwInvalidChatMessage(): never {
  throw new BadRequestException({
    statusCode: 400,
    code: "INVALID_CHAT_MESSAGE",
    message: "聊天消息格式无效",
    retryable: false,
  });
}

function throwChatUnavailable(): never {
  throw new ServiceUnavailableException({
    statusCode: 503,
    code: "AI_CHAT_UNAVAILABLE",
    message: "AI 服务暂时不可用，请稍后重试",
    retryable: true,
  });
}

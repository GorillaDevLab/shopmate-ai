import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import {
  AiChatRequestSchema,
  AiChatResponseSchema,
  type AiChatResponse,
  type LLMProvider,
} from "@shopmate/contracts";

import type { AuthContext } from "../../auth/contracts/index.js";
import { BusinessAgent, type BusinessAgentResult } from "../agent/business-agent.js";
import { createToolInvocationContext, ToolRegistry } from "../tools/tool-registry.js";

export interface BusinessAgentRunner {
  run(input: {
    readonly question: string;
    readonly context: ReturnType<typeof createToolInvocationContext>;
  }): Promise<BusinessAgentResult>;
}

@Injectable()
export class AiChatService {
  private readonly agent: BusinessAgentRunner;

  constructor(agentOrProvider: BusinessAgentRunner | LLMProvider, registry?: ToolRegistry) {
    this.agent = isAgent(agentOrProvider)
      ? agentOrProvider
      : new BusinessAgent(agentOrProvider, registry ?? new ToolRegistry({ allowedToolNames: [] }));
  }

  async chat(context: AuthContext, rawRequest: unknown): Promise<AiChatResponse> {
    const request = AiChatRequestSchema.safeParse(rawRequest);
    if (!request.success) throwInvalidChatMessage();

    try {
      const result = await this.agent.run({
        question: request.data.message.content,
        context: createToolInvocationContext(context),
      });

      if (result.status !== "completed") throwChatUnavailable();

      return AiChatResponseSchema.parse({
        message: { role: "assistant", content: result.answer },
      });
    } catch (error: unknown) {
      if (error instanceof BadRequestException || error instanceof ServiceUnavailableException) {
        throw error;
      }
      throwChatUnavailable();
    }
  }
}

function isAgent(value: BusinessAgentRunner | LLMProvider): value is BusinessAgentRunner {
  return "run" in value;
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

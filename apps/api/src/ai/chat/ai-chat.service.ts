import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
  HttpException,
} from "@nestjs/common";
import {
  AGENT_ACTION_MAX_PER_REPLY,
  AgentActionProposalSchema,
  type AgentActionProposal,
  AiChatRequestSchema,
  AiChatResponseSchema,
  ProductCopyOutputSchema,
  LLMProviderError,
  type AiChatResponse,
  type AiChatRequest,
  type LLMProvider,
  type ProductCopyOutput,
  type ProductCopyRequest,
  DashboardInsightPreviewResponseSchema,
  DashboardInsightQuerySchema,
} from "@shopmate/contracts";

import type { AuthContext } from "../../auth/contracts/index.js";
import {
  BusinessAgent,
  type BusinessAgentResult,
  type BusinessAgentRunInput,
} from "../agent/business-agent.js";
import {
  createToolInvocationContext,
  ToolRegistry,
  ToolRegistryError,
} from "../tools/tool-registry.js";

export interface BusinessAgentRunner {
  run(input: {
    readonly signal?: AbortSignal;
    readonly onProgress?: BusinessAgentRunInput["onProgress"];
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

  async chat(
    context: AuthContext,
    rawRequest: unknown,
    control: Pick<BusinessAgentRunInput, "signal" | "onProgress"> = {},
  ): Promise<AiChatResponse> {
    const request = AiChatRequestSchema.safeParse(rawRequest);
    if (!request.success) throwInvalidChatMessage();

    try {
      if (request.data.productCopy) {
        control.signal?.throwIfAborted();
        control.onProgress?.("tool-started", "正在读取商品并生成文案");
        const reply = await this.generateCopy(context, request.data.productCopy, control.signal);
        control.signal?.throwIfAborted();
        control.onProgress?.("tool-completed", "商品文案已生成");
        return reply;
      }
      const result = await this.agent.run({
        ...control,
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
      control.signal?.throwIfAborted();
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
    signal?: AbortSignal,
  ): Promise<AiChatResponse> {
    if (!this.registry)
      throw new LLMProviderError({
        code: "CONFIGURATION",
        message: "文案工具未配置",
        retryable: false,
      });
    const productCopy = ProductCopyOutputSchema.parse(
      await this.registry.invoke("generate_product_copy", input, {
        ...createToolInvocationContext(context),
        ...(signal ? { signal } : {}),
      }),
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
  const artifact = result.toolOutputs?.findLast((item) => item.name === "create_business_chart");
  const output = artifact?.output as { query?: unknown; data?: unknown } | undefined;
  const preview = DashboardInsightPreviewResponseSchema.safeParse({
    query: output?.query,
    result: output?.data,
  });
  const query = latestQuery(result);
  const actionProposals = collectProposals(result);
  return AiChatResponseSchema.parse({
    message: {
      role: "assistant",
      content: result.answer,
      ...(productCopy ? { productCopy } : {}),
      ...(preview.success ? { insightPreview: preview.data } : {}),
      ...(query.success ? { insightQuery: query.data } : {}),
      ...(actionProposals.length ? { actionProposals } : {}),
    },
  });
}

/** 只收集服务端刚创建、格式有效的确认卡片；模型文本里的任何“令牌”都不会被采信。 */
function collectProposals(result: BusinessAgentResult): AgentActionProposal[] {
  const proposals = (result.toolOutputs ?? [])
    .filter((item) => item.name.startsWith("propose_"))
    .map((item) => {
      const output = item.output as { data?: { proposal?: unknown } } | undefined;
      return AgentActionProposalSchema.safeParse(output?.data?.proposal);
    })
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data);
  return proposals.slice(-AGENT_ACTION_MAX_PER_REPLY);
}

function latestQuery(result: BusinessAgentResult) {
  const item = result.toolOutputs?.findLast((item) =>
    ["query_business_data", "create_business_chart", "get_sales_summary"].includes(item.name),
  );
  const output = item?.output as
    | { query?: unknown; data?: { period?: { startDate?: unknown; endDate?: unknown } } }
    | undefined;
  const period = output?.data?.period;
  // Store only a validated query context, never treat prior response numbers as new evidence.
  return DashboardInsightQuerySchema.safeParse(
    item?.name === "get_sales_summary"
      ? {
          dataset: "sales",
          metric: "revenue",
          aggregation: "sum",
          groupBy: null,
          dateRange: { start: period?.startDate, end: period?.endDate },
          filters: [],
          order: "desc",
          limit: 8,
          visualization: "report",
        }
      : output?.query,
  );
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

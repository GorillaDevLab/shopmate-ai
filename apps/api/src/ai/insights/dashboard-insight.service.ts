import {
  BadRequestException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  DashboardInsightGenerateRequestSchema,
  DashboardInsightExecuteRequestSchema,
  DashboardInsightExecuteResponseSchema,
  DashboardInsightPreviewResponseSchema,
  DashboardInsightQuerySchema,
  type DashboardInsightPreviewResponse,
  type DashboardInsightResult,
  type JsonObject,
  type LLMProvider,
  type LLMToolDefinition,
} from "@shopmate/contracts";

import type { AuthContext } from "../../auth/contracts/index.js";
import { validateDashboardInsightQuery } from "./dashboard-insight-validator.js";

const TOOL_NAME = "propose_dashboard_insight";
const SYSTEM_POLICY = [
  "你是经营看板查询规划器，只能调用 propose_dashboard_insight。",
  "不得生成 SQL、代码、数据库字段或 userId、merchantId。",
  "只使用工具 Schema 中的业务枚举；日期格式为 YYYY-MM-DD。",
  "平台和店铺维度已预留但 Demo 尚未接入，不要选择它们。",
].join("\n");

export interface InsightQueryExecutor {
  execute(context: AuthContext, query: unknown): Promise<DashboardInsightResult>;
}

@Injectable()
export class DashboardInsightService {
  constructor(
    private readonly provider: LLMProvider,
    private readonly executor: InsightQueryExecutor,
  ) {}

  async preview(
    context: AuthContext,
    rawRequest: unknown,
  ): Promise<DashboardInsightPreviewResponse> {
    const request = DashboardInsightGenerateRequestSchema.safeParse(rawRequest);
    if (!request.success) throwInvalidRequest();
    try {
      const generation = await this.provider.generate({
        messages: [
          { role: "system", content: SYSTEM_POLICY },
          { role: "user", content: prompt(request.data.question, request.data.kind) },
        ],
        tools: [DASHBOARD_INSIGHT_TOOL],
        temperature: 0,
        maxOutputTokens: 1000,
      });
      const query = readQuery(generation.message.toolCalls, request.data.kind);
      const result = await this.executor.execute(context, query);
      return DashboardInsightPreviewResponseSchema.parse({ query, result });
    } catch (error: unknown) {
      if (error instanceof HttpException) throw error;
      throwUnavailable();
    }
  }

  async execute(context: AuthContext, rawRequest: unknown) {
    const request = DashboardInsightExecuteRequestSchema.safeParse(rawRequest);
    if (!request.success) throwInvalidRequest();
    try {
      const result = await this.executor.execute(context, request.data.query);
      return DashboardInsightExecuteResponseSchema.parse({ result });
    } catch (error: unknown) {
      if (error instanceof HttpException) throw error;
      throwUnavailable();
    }
  }
}

const DASHBOARD_INSIGHT_TOOL: LLMToolDefinition = {
  name: TOOL_NAME,
  description: "把经营问题转换为受限看板查询，不执行 SQL。",
  inputSchema: queryJsonSchema(),
};

function prompt(question: string, kind: "pie" | "report"): string {
  return `当前上海日期：${shanghaiToday()}\n目标组件：${kind}\n经营问题：${question}`;
}

function shanghaiToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

function readQuery(
  calls: readonly { readonly name: string; readonly arguments: JsonObject }[] | undefined,
  kind: "pie" | "report",
) {
  const candidate = calls?.find((call) => call.name === TOOL_NAME)?.arguments;
  const query = validateDashboardInsightQuery(DashboardInsightQuerySchema.parse(candidate));
  if (query.visualization !== kind) throw new Error("组件类型与查询不一致");
  return query;
}

function queryJsonSchema(): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "dataset",
      "metric",
      "aggregation",
      "groupBy",
      "dateRange",
      "filters",
      "order",
      "limit",
      "visualization",
    ],
    properties: {
      dataset: { type: "string", enum: ["sales", "products", "inventory"] },
      metric: {
        type: "string",
        enum: [
          "revenue",
          "orderCount",
          "unitsSold",
          "averageOrderValue",
          "inventory",
          "productCount",
        ],
      },
      aggregation: { type: "string", enum: ["sum", "count", "average"] },
      groupBy: {
        type: ["string", "null"],
        enum: ["date", "product", "sku", "orderStatus", "inventoryRisk", null],
      },
      dateRange: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end"],
        properties: { start: { type: "string" }, end: { type: "string" } },
      },
      filters: { type: "array", maxItems: 8, items: { type: "object" } },
      order: { type: "string", enum: ["asc", "desc"] },
      limit: { type: "integer", minimum: 1, maximum: 12 },
      visualization: { type: "string", enum: ["pie", "report"] },
    },
  };
}

function throwInvalidRequest(): never {
  throw new BadRequestException({
    statusCode: 400,
    code: "INVALID_DASHBOARD_INSIGHT_REQUEST",
    message: "AI 看板请求格式无效",
    retryable: false,
  });
}

function throwUnavailable(): never {
  throw new ServiceUnavailableException({
    statusCode: 503,
    code: "DASHBOARD_INSIGHT_UNAVAILABLE",
    message: "暂时无法生成看板组件，请调整问题后重试",
    retryable: true,
  });
}

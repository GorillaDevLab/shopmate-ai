import { BadRequestException, HttpException, ServiceUnavailableException } from "@nestjs/common";
import {
  MonitoringRuleDefinitionSchema,
  MonitoringRulePreviewRequestSchema,
  MonitoringRulePreviewResponseSchema,
  type JsonObject,
  type LLMProvider,
  type LLMToolDefinition,
  type MonitoringEvaluation,
  type MonitoringRuleDefinition,
} from "@shopmate/contracts";

import type { AuthContext } from "../auth/contracts/index.js";

const TOOL_NAME = "propose_monitoring_rule";
const POLICY = [
  "你是经营监听规则规划器，只能调用 propose_monitoring_rule。",
  "不得输出 SQL、代码、数据库字段、userId 或 merchantId。",
  "频率只能是 daily 或 weekly，不得创建小时级规则。",
  "销售范围只能是 7d、30d、90d，库存只能使用全部商品快照。",
].join("\n");

interface PreviewEvaluator {
  evaluate(
    context: AuthContext,
    definition: MonitoringRuleDefinition,
    now: Date,
  ): Promise<MonitoringEvaluation>;
}

export class MonitoringRuleGenerator {
  constructor(
    private readonly provider: LLMProvider,
    private readonly evaluator: PreviewEvaluator,
  ) {}

  async generate(context: AuthContext, rawRequest: unknown) {
    const request = MonitoringRulePreviewRequestSchema.safeParse(rawRequest);
    if (!request.success) throwInvalidRequest();
    try {
      const now = new Date();
      console.log("=== Monitoring DeepSeek Request Start ===");
      const generation = await this.provider.generate({
        messages: [
          { role: "system", content: POLICY },
          {
            role: "user",
            content: `当前上海日期：${shanghaiToday(now)}\n监听需求：${request.data.question}`,
          },
        ],
        tools: [MONITORING_RULE_TOOL],
        temperature: 0,
        maxOutputTokens: 800,
      });
      console.log(
  "=== Monitoring Generation Result ===",
  JSON.stringify(generation, null, 2),
);
      const definition = readDefinition(generation.message.toolCalls);
      const evaluation = await this.evaluator.evaluate(context, definition, now);
      return MonitoringRulePreviewResponseSchema.parse({
        suggestedName: suggestedName(definition),
        definition,
        evaluation,
      });
}
     catch (error: unknown) {
  console.error(
    "=== Monitoring DeepSeek Error ===",
    error,
  );

  if (error instanceof HttpException) throw error;

  throwUnavailable();
}
  }
}

const MONITORING_RULE_TOOL: LLMToolDefinition = {
  name: TOOL_NAME,
  description: "将经营需求转换为严格受限的销售或库存监听规则。",
  inputSchema: ruleJsonSchema(),
};

function readDefinition(
  calls:
    | readonly {
        readonly name: string;
        readonly arguments: JsonObject;
      }[]
    | undefined,
) {
  if (calls?.length !== 1 || calls[0]?.name !== TOOL_NAME) {
    return MonitoringRuleDefinitionSchema.parse(undefined);
  }

  const argumentsJson = { ...calls[0].arguments };

  if (
    argumentsJson.kind === "inventoryThreshold" &&
    !("productIds" in argumentsJson)
  ) {
    argumentsJson.productIds = [];
  }

  return MonitoringRuleDefinitionSchema.parse(argumentsJson);
}

function suggestedName(definition: MonitoringRuleDefinition): string {
  if (definition.kind === "inventoryThreshold") return `库存低于 ${definition.threshold} 件`;
  const label =
    definition.metric === "revenue"
      ? "销售额"
      : definition.metric === "orderCount"
        ? "订单量"
        : definition.metric === "unitsSold"
          ? "销量"
          : "客单价";
  return `${label}${definition.operator === "above" ? "高于" : "低于"}阈值`;
}

function ruleJsonSchema(): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "kind",
      "metric",
      "operator",
      "threshold",
      "frequency",
    ],
    properties: {
      kind: {
        type: "string",
        enum: [
          "salesThreshold",
          "inventoryThreshold",
        ],
      },

      metric: {
        type: "string",
        enum: [
          "revenue",
          "orderCount",
          "unitsSold",
          "averageOrderValue",
          "inventory",
        ],
      },

      operator: {
        type: "string",
        enum: [
          "above",
          "below",
        ],
      },

      threshold: {
        type: "number",
        minimum: 0,
      },

      window: {
        type: "string",
        enum: [
          "7d",
          "30d",
          "90d",
        ],
      },

      scope: {
        type: "string",
        enum: [
          "allProducts",
        ],
      },

      productIds: {
        type: "array",
        items: {
          type: "string",
        },
        maxItems: 20,
      },

      frequency: {
        type: "string",
        enum: [
          "daily",
          "weekly",
        ],
      },
    },
  };
}

function shanghaiToday(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function throwInvalidRequest(): never {
  throw new BadRequestException({
    statusCode: 400,
    code: "INVALID_MONITORING_REQUEST",
    message: "监听请求格式无效",
    retryable: false,
  });
}

function throwUnavailable(): never {
  throw new ServiceUnavailableException({
    statusCode: 503,
    code: "MONITORING_PREVIEW_UNAVAILABLE",
    message: "暂时无法生成监听规则，请调整描述后重试",
    retryable: true,
  });
}

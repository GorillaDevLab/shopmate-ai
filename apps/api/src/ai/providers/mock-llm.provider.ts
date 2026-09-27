import { Injectable } from "@nestjs/common";

import {
  LLMProviderError,
  ProductCopyOutputSchema,
  ProductCopyTypeSchema,
  type LLMGenerationRequest,
  type LLMGenerationResult,
  type LLMProvider,
  type LLMProviderErrorCode,
} from "@shopmate/contracts";

export type MockLLMErrorFixture = "AUTHENTICATION" | "RATE_LIMIT" | "TIMEOUT";

export interface MockLLMProviderOptions {
  readonly errorFixture?: MockLLMErrorFixture;
}

interface MockErrorDefinition {
  readonly code: LLMProviderErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export const MOCK_LLM_ERROR_FIXTURES: Readonly<Record<MockLLMErrorFixture, MockErrorDefinition>> = {
  AUTHENTICATION: {
    code: "AUTHENTICATION",
    message: "Mock LLM Provider：认证失败。",
    retryable: false,
  },
  RATE_LIMIT: {
    code: "RATE_LIMIT",
    message: "Mock LLM Provider：请求过于频繁。",
    retryable: true,
  },
  TIMEOUT: {
    code: "TIMEOUT",
    message: "Mock LLM Provider：请求超时。",
    retryable: true,
  },
};

@Injectable()
export class MockLLMProvider implements LLMProvider {
  readonly name = "mock";

  constructor(private readonly options: MockLLMProviderOptions = {}) {}

  async generate(request: LLMGenerationRequest): Promise<LLMGenerationResult> {
    this.throwConfiguredError();

    if (isMonitoringRuleRequest(request)) {
      return monitoringRuleResult(request);
    }

    if (isDashboardInsightRequest(request)) {
      return dashboardInsightResult(request);
    }

    if (isStructuredProductCopyGenerationRequest(request)) {
      return structuredProductCopyResult(request);
    }

    if (hasProductCopyToolResult(request)) {
      return productCopyCompletedResult();
    }

    const toolContent = getLatestVerifiedToolContent(request);

    if (toolContent) {
      return toolExplanationResult(toolContent);
    }

    const userText = getLatestUserText(request);

    const productCopyIntent = parseProductCopyIntent(userText);

    if (productCopyIntent) {
      return productCopyToolResult(productCopyIntent);
    }

    if (matchesInventoryIntent(userText)) {
      return inventoryToolResult();
    }

    if (matchesBestSellersIntent(userText)) {
      return bestSellersToolResult();
    }

    if (matchesSalesTrendIntent(userText)) {
      return salesTrendToolResult();
    }

    if (matchesSalesIntent(userText)) {
      return salesToolResult();
    }

    if (matchesCopywritingIntent(userText)) {
      return copywritingResult();
    }

    return fallbackResult();
  }

  private throwConfiguredError(): void {
    const fixtureName = this.options.errorFixture;

    if (!fixtureName) {
      return;
    }

    const fixture = MOCK_LLM_ERROR_FIXTURES[fixtureName];

    throw new LLMProviderError({
      code: fixture.code,
      message: fixture.message,
      retryable: fixture.retryable,
    });
  }
}

function isMonitoringRuleRequest(request: LLMGenerationRequest): boolean {
  return request.messages.some(
    (message) => message.role === "system" && message.content.includes("propose_monitoring_rule"),
  );
}

function monitoringRuleResult(request: LLMGenerationRequest): LLMGenerationResult {
  const userText = getLatestUserText(request);
  if (matchesInventoryIntent(userText)) {
    return toolCallGeneration({
      id: "mock-call-monitoring-inventory-001",
      name: "propose_monitoring_rule",
      arguments: {
        kind: "inventoryThreshold",
        metric: "inventory",
        operator: "below",
        threshold: inventoryThreshold(userText),
        scope: "allProducts",
        productIds: [],
        frequency: "daily",
      },
    });
  }
  return toolCallGeneration({
    id: "mock-call-monitoring-sales-001",
    name: "propose_monitoring_rule",
    arguments: {
      kind: "salesThreshold",
      metric: "revenue",
      operator: "below",
      threshold: 100_000,
      window: "30d",
      frequency: "daily",
    },
  });
}

function inventoryThreshold(userText: string): number {
  const match = userText.match(/(?:低于|少于|不足)\s*(\d{1,7})/u);
  if (!match?.[1]) return 10;
  return Math.min(Number.parseInt(match[1], 10), 1_000_000);
}

function isDashboardInsightRequest(request: LLMGenerationRequest): boolean {
  return request.messages.some(
    (message) => message.role === "system" && message.content.includes("propose_dashboard_insight"),
  );
}

function dashboardInsightResult(request: LLMGenerationRequest): LLMGenerationResult {
  const userText = getLatestUserText(request);
  const requested = userText.match(/目标组件：(auto|pie|bar|line|area|report)/u)?.[1] ?? "auto";
  const dateGrouped = /每天|每日|按日|日期|趋势/u.test(userText);
  const composition = /占比|构成|份额/u.test(userText);
  const visualization =
    requested === "auto" ? (dateGrouped ? "line" : composition ? "pie" : "bar") : requested;
  const metric = userText.includes("销量") ? "unitsSold" : "revenue";
  return toolCallGeneration({
    id: "mock-call-dashboard-insight-001",
    name: "propose_dashboard_insight",
    arguments: {
      dataset: "sales",
      metric,
      aggregation: "sum",
      groupBy: visualization === "report" ? null : dateGrouped ? "date" : "product",
      dateRange: { start: "2026-08-25", end: "2026-08-31" },
      filters: [],
      order: "desc",
      limit: 8,
      visualization,
    },
  });
}

function getLatestVerifiedToolContent(request: LLMGenerationRequest): string | null {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];

    if (message?.role === "tool") {
      return normalizeToolContent(message.content);
    }
  }

  return null;
}

function normalizeToolContent(content: string): string | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isToolResult(parsed)) {
      return null;
    }
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

function isToolResult(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const status = (value as Readonly<Record<string, unknown>>).status;
  return status === "ok" || status === "empty" || status === "error";
}

function getLatestUserText(request: LLMGenerationRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];

    if (message?.role === "user") {
      return normalizeIntentText(message.content);
    }
  }

  return "";
}

function normalizeIntentText(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
}

type MockProductCopyIntent = {
  readonly productId: string;
  readonly copyType: "TITLE" | "DESCRIPTION" | "XIAOHONGSHU" | "DOUYIN" | "GENERAL";
};

function parseProductCopyIntent(value: string): MockProductCopyIntent | null {
  const productIdMatch = value.match(/商品\s*id\s*[:：]\s*([a-z0-9_-]+)/iu);

  const copyTypeMatch = value.match(
    /文案类型\s*[:：]\s*(title|description|xiaohongshu|douyin|general)/iu,
  );

  const productId = productIdMatch?.[1];
  const rawCopyType = copyTypeMatch?.[1]?.toUpperCase();

  if (!productId || !rawCopyType) {
    return null;
  }

  const copyType = ProductCopyTypeSchema.safeParse(rawCopyType);

  if (!copyType.success) {
    return null;
  }

  return {
    productId,
    copyType: copyType.data,
  };
}

function isStructuredProductCopyGenerationRequest(request: LLMGenerationRequest): boolean {
  return request.messages.some(
    (message) => message.role === "system" && message.content.includes("中国电商商品营销文案助手"),
  );
}

function structuredProductCopyResult(request: LLMGenerationRequest): LLMGenerationResult {
  const productName = readStructuredProductName(request) ?? "当前商品";

  return {
    message: {
      role: "assistant",
      content: JSON.stringify({
        title: `${productName}｜日常实用之选`,
        body: `${productName}围绕当前已提供的真实商品信息进行介绍，突出已验证的商品特点与卖点。`,
        tags: ["商品推荐", "日常实用"],
      }),
    },
    finishReason: "stop",
    usage: fixedUsage(),
    requestId: "mock-request-product-copy-content",
  };
}

function readStructuredProductName(request: LLMGenerationRequest): string | null {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];

    if (message?.role !== "user") {
      continue;
    }

    try {
      const payload: unknown = JSON.parse(message.content);

      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const product = (payload as Record<string, unknown>).product;

        if (product && typeof product === "object" && !Array.isArray(product)) {
          const name = (product as Record<string, unknown>).name;

          if (typeof name === "string" && name.trim()) {
            return name.trim();
          }
        }
      }
    } catch {
      return null;
    }
  }

  return null;
}

function hasProductCopyToolResult(request: LLMGenerationRequest): boolean {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];

    if (message?.role !== "tool" || message.name !== "generate_product_copy") {
      continue;
    }

    try {
      const parsed = ProductCopyOutputSchema.safeParse(JSON.parse(message.content));

      return parsed.success;
    } catch {
      return false;
    }
  }

  return false;
}

function matchesInventoryIntent(value: string): boolean {
  return includesAny(value, [
    "库存",
    "缺货",
    "补货",
    "售罄",
    "快没货",
    "没库存",
    "inventory",
    "stock",
  ]);
}

function matchesSalesIntent(value: string): boolean {
  return includesAny(value, [
    "销售",
    "销量",
    "销售额",
    "订单",
    "营收",
    "成交",
    "sales",
    "revenue",
    "order",
  ]);
}

function matchesBestSellersIntent(value: string): boolean {
  return includesAny(value, ["热销", "畅销", "卖得最好", "销量排行", "销售排行", "best seller"]);
}

function matchesSalesTrendIntent(value: string): boolean {
  return includesAny(value, ["销售趋势", "销售走势", "营收趋势", "每日趋势", "trend"]);
}

function matchesCopywritingIntent(value: string): boolean {
  return includesAny(value, [
    "文案",
    "标题",
    "卖点",
    "描述",
    "推广语",
    "广告语",
    "copywriting",
    "copy",
  ]);
}

function includesAny(value: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => value.includes(keyword));
}

function productCopyToolResult(intent: MockProductCopyIntent): LLMGenerationResult {
  return toolCallGeneration({
    id: `mock-call-product-copy-${intent.copyType.toLowerCase()}`,
    name: "generate_product_copy",
    arguments: {
      productId: intent.productId,
      copyType: intent.copyType,
    },
  });
}

function productCopyCompletedResult(): LLMGenerationResult {
  return {
    message: {
      role: "assistant",
      content: "商品文案已生成，请查看下方标题、正文和标签。",
    },
    finishReason: "stop",
    usage: fixedUsage(),
    requestId: "mock-request-product-copy-completed",
  };
}

function inventoryToolResult(): LLMGenerationResult {
  return {
    message: {
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "mock-call-inventory-001",
          name: "get_inventory_risks",
          arguments: defaultPeriod(),
        },
      ],
    },
    finishReason: "tool_calls",
    usage: fixedUsage(),
    requestId: "mock-request-inventory",
  };
}

function salesToolResult(): LLMGenerationResult {
  return {
    message: {
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "mock-call-sales-001",
          name: "get_sales_summary",
          arguments: defaultPeriod(),
        },
      ],
    },
    finishReason: "tool_calls",
    usage: fixedUsage(),
    requestId: "mock-request-sales",
  };
}

function bestSellersToolResult(): LLMGenerationResult {
  return toolCallGeneration({
    id: "mock-call-best-sellers-001",
    name: "get_best_sellers",
    arguments: { ...defaultPeriod(), limit: 20 },
  });
}

function salesTrendToolResult(): LLMGenerationResult {
  return toolCallGeneration({
    id: "mock-call-sales-trend-001",
    name: "get_sales_trend",
    arguments: { ...defaultPeriod(), granularity: "day" },
  });
}

function toolCallGeneration(
  toolCall: NonNullable<LLMGenerationResult["message"]["toolCalls"]>[number],
): LLMGenerationResult {
  return {
    message: { role: "assistant", content: null, toolCalls: [toolCall] },
    finishReason: "tool_calls",
    usage: fixedUsage(),
    requestId: `mock-request-${toolCall.name}`,
  };
}

function toolExplanationResult(content: string): LLMGenerationResult {
  return {
    message: {
      role: "assistant",
      content: `已根据经过验证的工具结果完成查询：${content}`,
    },
    finishReason: "stop",
    usage: fixedUsage(),
    requestId: "mock-request-tool-explanation",
  };
}

function defaultPeriod() {
  return {
    startDate: "2026-08-25",
    endDate: "2026-08-31",
  } as const;
}

function copywritingResult(): LLMGenerationResult {
  return {
    message: {
      role: "assistant",
      content:
        "这款商品主打实用、易用与高性价比，适合日常使用。建议结合真实商品参数、目标人群和已验证卖点进一步完善文案。",
    },
    finishReason: "stop",
    usage: fixedUsage(),
    requestId: "mock-request-copywriting",
  };
}

function fallbackResult(): LLMGenerationResult {
  return {
    message: {
      role: "assistant",
      content:
        "目前没有足够信息完成判断。请补充具体问题，或提供可验证的商品、库存、订单或销售数据。",
    },
    finishReason: "stop",
    usage: fixedUsage(),
    requestId: "mock-request-fallback",
  };
}

function fixedUsage() {
  return {
    inputTokens: 10,
    outputTokens: 10,
    totalTokens: 20,
  } as const;
}

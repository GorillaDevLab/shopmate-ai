import { Injectable } from "@nestjs/common";

import {
  LLMProviderError,
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

    const userText = getLatestUserText(request);

    if (matchesInventoryIntent(userText)) {
      return inventoryToolResult();
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

function inventoryToolResult(): LLMGenerationResult {
  return {
    message: {
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "mock-call-inventory-001",
          name: "get_inventory_risks",
          arguments: {},
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
          arguments: {},
        },
      ],
    },
    finishReason: "tool_calls",
    usage: fixedUsage(),
    requestId: "mock-request-sales",
  };
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

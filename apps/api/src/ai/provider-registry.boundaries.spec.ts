import { describe, expect, it, vi } from "vitest";

import { LLMProviderError } from "@shopmate/contracts";

import { DeepSeekLLMProvider } from "./providers/deepseek-llm.provider.js";
import { MockLLMProvider } from "./providers/mock-llm.provider.js";
import {
  ToolRegistry,
  ToolRegistryError,
  type ToolRegistration,
  type ToolSchema,
} from "./tools/tool-registry.js";

interface FixtureOutput {
  readonly source: string;
}

const EXPECTED_TOOL_NAMES = ["get_inventory_risks", "get_sales_summary"] as const;

const emptyInputSchema: ToolSchema<Record<string, never>> = {
  jsonSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },

  parse(value: unknown): Record<string, never> {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 0
    ) {
      throw new Error("fixture input invalid");
    }

    return {};
  },
};

const fixtureOutputSchema: ToolSchema<FixtureOutput> = {
  jsonSchema: {
    type: "object",
    properties: {
      source: {
        type: "string",
      },
    },
    required: ["source"],
    additionalProperties: false,
  },

  parse(value: unknown): FixtureOutput {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof (value as Record<string, unknown>).source !== "string"
    ) {
      throw new Error("fixture output invalid");
    }

    return {
      source: (value as Record<string, string>).source,
    };
  },
};

describe("G5 Provider 与 Registry 边界", () => {
  it("Registry 注册清单与预期完全一致", () => {
    const registry = createRegistry();

    expect(registry.listDefinitions().map((definition) => definition.name)).toEqual(
      EXPECTED_TOOL_NAMES,
    );
  });

  it("Mock Provider 返回的工具调用全部存在于 Registry", async () => {
    const provider = new MockLLMProvider();

    const registry = createRegistry();

    const registeredNames = registry.listDefinitions().map((definition) => definition.name);

    const inventoryResult = await provider.generate({
      messages: [
        {
          role: "user",
          content: "哪些商品快没库存了？",
        },
      ],
    });

    const salesResult = await provider.generate({
      messages: [
        {
          role: "user",
          content: "最近销售额和订单怎么样？",
        },
      ],
    });

    expect(inventoryResult.message.toolCalls?.[0]?.name).toBe("get_inventory_risks");

    expect(salesResult.message.toolCalls?.[0]?.name).toBe("get_sales_summary");

    expect(registeredNames).toContain(inventoryResult.message.toolCalls?.[0]?.name);

    expect(registeredNames).toContain(salesResult.message.toolCalls?.[0]?.name);
  });

  it("真实 Provider 配置错误不会访问网络或泄露配置值", () => {
    const fetchSpy = vi.fn();

    vi.stubGlobal("fetch", fetchSpy);

    try {
      let caught: unknown;

      try {
        new DeepSeekLLMProvider({
          env: {
            DEEPSEEK_API_KEY: "demo-key",
            DEEPSEEK_MODEL: "unsupported-model",
          },
        });
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(LLMProviderError);

      if (!(caught instanceof LLMProviderError)) {
        throw new Error("Expected LLMProviderError");
      }

      expect(caught.code).toBe("CONFIGURATION");

      expect(caught.message).not.toContain("demo-key");

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("重复工具注册被拒绝", () => {
    const registry = createRegistry();

    expect(() => registry.register(createTool("get_sales_summary"))).toThrowError(
      expect.objectContaining({
        code: "DUPLICATE_NAME",
      }),
    );
  });

  it("未知工具不能执行", async () => {
    const registry = createRegistry();

    await expect(registry.invoke("unknown_tool", {}, invocationContext())).rejects.toMatchObject({
      code: "NOT_REGISTERED",
    });
  });

  it("输入错误时不会调用 Handler", async () => {
    const handler = vi.fn(async () => ({
      source: "should-not-run",
    }));

    const registry = new ToolRegistry({
      allowedToolNames: ["get_sales_summary"],
    });

    registry.register(createTool("get_sales_summary", handler));

    await expect(
      registry.invoke(
        "get_sales_summary",
        {
          unexpected: true,
        },
        invocationContext(),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("Handler 异常被映射为安全错误且不泄露内部信息", async () => {
    const internalMarker = ["handler", "fixture"].join("-");

    const handler = vi.fn(async () => {
      throw new Error(`${internalMarker}\n    at internalHandler`);
    });

    const registry = new ToolRegistry({
      allowedToolNames: ["get_sales_summary"],
    });

    registry.register(createTool("get_sales_summary", handler));

    const error = await registry
      .invoke("get_sales_summary", {}, invocationContext())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ToolRegistryError);

    if (!(error instanceof ToolRegistryError)) {
      throw new Error("Expected ToolRegistryError");
    }

    expect(error).toMatchObject({
      code: "HANDLER_FAILED",
      toolName: "get_sales_summary",
    });

    const serialized = JSON.stringify(error);

    expect(serialized).not.toContain(internalMarker);

    expect(serialized).not.toContain("internalHandler");

    expect(serialized).not.toContain("stack");
  });
});

function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry({
    allowedToolNames: EXPECTED_TOOL_NAMES,
  });

  registry.register(createTool("get_inventory_risks"));

  registry.register(createTool("get_sales_summary"));

  return registry;
}

function createTool(
  name: "get_inventory_risks" | "get_sales_summary",
  handler: ToolRegistration<Record<string, never>, FixtureOutput>["handler"] = async () => ({
    source: name,
  }),
): ToolRegistration<Record<string, never>, FixtureOutput> {
  return {
    name,
    description: `Fixture tool: ${name}`,
    input: emptyInputSchema,
    output: fixtureOutputSchema,
    handler,
  };
}

function invocationContext() {
  return Object.freeze({
    userId: "user-fixture",
    merchantId: "merchant-fixture",
    permissions: Object.freeze([]),
  });
}

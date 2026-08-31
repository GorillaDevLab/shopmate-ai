import { describe, expect, it, vi } from "vitest";

import { AuthPermission, createAuthContext } from "../../auth/contracts/auth-context.js";

import {
  createToolInvocationContext,
  ToolRegistry,
  type ToolInvocationContext,
  type ToolRegistration,
  type ToolSchema,
} from "./tool-registry.js";

interface SalesInput {
  readonly period: string;
}

interface SalesOutput {
  readonly summary: string;
}

const salesInputSchema: ToolSchema<SalesInput> = {
  jsonSchema: {
    type: "object",
    properties: {
      period: {
        type: "string",
      },
    },
    required: ["period"],
    additionalProperties: false,
  },

  parse(value: unknown): SalesInput {
    if (!isRecord(value) || typeof value.period !== "string") {
      throw new Error("period must be a string");
    }

    return {
      period: value.period,
    };
  },
};

const salesOutputSchema: ToolSchema<SalesOutput> = {
  jsonSchema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
      },
    },
    required: ["summary"],
    additionalProperties: false,
  },

  parse(value: unknown): SalesOutput {
    if (!isRecord(value) || typeof value.summary !== "string") {
      throw new Error("summary must be a string");
    }

    return {
      summary: value.summary,
    };
  },
};

describe("ToolRegistry", () => {
  it("只向 LLM 暴露安全工具定义", () => {
    const registry = createRegistry();

    registry.register(createSalesTool());

    const definitions = registry.listDefinitions();

    expect(definitions).toHaveLength(1);

    expect(definitions[0]).toEqual({
      name: "get_sales_summary",
      description: "查询当前 Merchant 的销售汇总",
      inputSchema: salesInputSchema.jsonSchema,
    });

    expect(Object.keys(definitions[0] ?? {}).sort()).toEqual([
      "description",
      "inputSchema",
      "name",
    ]);
  });

  it("拒绝注册白名单之外的工具", () => {
    const registry = createRegistry();

    expect(() =>
      registry.register({
        ...createSalesTool(),
        name: "dangerous_database_query",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "NOT_ALLOWED",
      }),
    );
  });

  it("拒绝重复工具名称", () => {
    const registry = createRegistry();

    registry.register(createSalesTool());

    expect(() => registry.register(createSalesTool())).toThrowError(
      expect.objectContaining({
        code: "DUPLICATE_NAME",
      }),
    );
  });

  it("未注册工具不能执行", async () => {
    const registry = createRegistry();

    await expect(
      registry.invoke(
        "get_sales_summary",
        {
          period: "7d",
        },
        createContext(),
      ),
    ).rejects.toMatchObject({
      code: "NOT_REGISTERED",
    });
  });

  it("参数校验失败时不会调用 Handler", async () => {
    const handler = vi.fn(async () => ({
      summary: "不应执行",
    }));

    const registry = createRegistry();

    registry.register(createSalesTool(handler));

    await expect(
      registry.invoke(
        "get_sales_summary",
        {
          period: 7,
        },
        createContext(),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("权限不足时不会调用 Handler", async () => {
    const handler = vi.fn(async () => ({
      summary: "不应执行",
    }));

    const registry = createRegistry();

    registry.register(createSalesTool(handler));

    const context = createToolInvocationContext(
      createAuthContext({
        userId: "user-002",
        merchantId: "merchant-b",
        permissions: [],
      }),
    );

    await expect(
      registry.invoke(
        "get_sales_summary",
        {
          period: "7d",
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("把身份 Merchant 和权限上下文传给 Handler", async () => {
    const handler = vi.fn(async (_input: SalesInput, context: Readonly<ToolInvocationContext>) => ({
      summary: `${context.merchantId}:${context.userId}`,
    }));

    const registry = createRegistry();

    registry.register(createSalesTool(handler));

    const context = createContext();

    const result = await registry.invoke(
      "get_sales_summary",
      {
        period: "7d",
      },
      context,
    );

    expect(handler).toHaveBeenCalledWith(
      {
        period: "7d",
      },
      context,
    );

    expect(result).toEqual({
      summary: "merchant-a:user-001",
    });
  });

  it("Handler 返回结果必须通过输出 Schema 校验", async () => {
    const handler = vi.fn(
      async () =>
        ({
          summary: 123,
        }) as unknown as SalesOutput,
    );

    const registry = createRegistry();

    registry.register(createSalesTool(handler));

    await expect(
      registry.invoke(
        "get_sales_summary",
        {
          period: "7d",
        },
        createContext(),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_OUTPUT",
    });
  });

  it("合法调用返回经过 Schema 校验的结果", async () => {
    const registry = createRegistry();

    registry.register(createSalesTool());

    await expect(
      registry.invoke(
        "get_sales_summary",
        {
          period: "30d",
        },
        createContext(),
      ),
    ).resolves.toEqual({
      summary: "销售汇总 fixture",
    });
  });
});

function createRegistry() {
  return new ToolRegistry({
    allowedToolNames: ["get_sales_summary"],
  });
}

function createContext() {
  return createToolInvocationContext(
    createAuthContext({
      userId: "user-001",
      merchantId: "merchant-a",
      permissions: [AuthPermission.OrdersRead],
    }),
  );
}

function createSalesTool(
  handler: ToolRegistration<SalesInput, SalesOutput>["handler"] = async () => ({
    summary: "销售汇总 fixture",
  }),
): ToolRegistration<SalesInput, SalesOutput> {
  return {
    name: "get_sales_summary",

    description: "查询当前 Merchant 的销售汇总",

    input: salesInputSchema,
    output: salesOutputSchema,

    requiredPermissions: [AuthPermission.OrdersRead],

    handler,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

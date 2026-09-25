import type { JsonObject, LLMToolDefinition } from "@shopmate/contracts";

import type { AuthContext, AuthPermission } from "../../auth/contracts/auth-context.js";

export interface ToolSchema<T> {
  readonly jsonSchema: JsonObject;

  parse(value: unknown): T;
}

export interface ToolInvocationContext {
  readonly userId: string;
  readonly merchantId: string;
  readonly permissions: readonly AuthPermission[];
}

export type ToolHandler<TInput, TOutput> = (
  input: TInput,
  context: Readonly<ToolInvocationContext>,
) => Promise<TOutput> | TOutput;

export interface ToolRegistration<TInput, TOutput> {
  readonly name: string;
  readonly description: string;

  readonly input: ToolSchema<TInput>;
  readonly output: ToolSchema<TOutput>;

  readonly requiredPermissions?: readonly AuthPermission[];

  readonly handler: ToolHandler<TInput, TOutput>;
}

export interface ToolRegistryOptions {
  readonly allowedToolNames: readonly string[];
}

export type ToolRegistryErrorCode =
  | "NOT_ALLOWED"
  | "DUPLICATE_NAME"
  | "NOT_REGISTERED"
  | "INVALID_INPUT"
  | "INVALID_OUTPUT"
  | "HANDLER_FAILED"
  | "FORBIDDEN";

export interface ToolRegistryErrorOptions {
  readonly code: ToolRegistryErrorCode;
  readonly toolName: string;
  readonly message: string;
  readonly cause?: unknown;
}

export class ToolRegistryError extends Error {
  readonly code: ToolRegistryErrorCode;
  readonly toolName: string;

  constructor(options: ToolRegistryErrorOptions) {
    super(options.message, {
      cause: options.cause,
    });

    this.name = "ToolRegistryError";
    this.code = options.code;
    this.toolName = options.toolName;
  }

  toJSON(): Readonly<{
    code: ToolRegistryErrorCode;
    toolName: string;
    message: string;
  }> {
    return Object.freeze({
      code: this.code,
      toolName: this.toolName,
      message: this.message,
    });
  }
}

interface StoredTool {
  readonly name: string;
  readonly description: string;

  readonly input: ToolSchema<unknown>;
  readonly output: ToolSchema<unknown>;

  readonly requiredPermissions: readonly AuthPermission[];

  readonly handler: (
    input: unknown,
    context: Readonly<ToolInvocationContext>,
  ) => Promise<unknown> | unknown;
}

export function createToolInvocationContext(
  authContext: AuthContext,
): Readonly<ToolInvocationContext> {
  return Object.freeze({
    userId: authContext.userId,
    merchantId: authContext.merchantId,
    permissions: Object.freeze([...authContext.permissions]),
  });
}

export class ToolRegistry {
  private readonly allowedToolNames: ReadonlySet<string>;

  private readonly tools = new Map<string, StoredTool>();

  constructor(options: ToolRegistryOptions) {
    this.allowedToolNames = new Set(options.allowedToolNames);
  }

  register<TInput, TOutput>(tool: ToolRegistration<TInput, TOutput>): void {
    if (!this.allowedToolNames.has(tool.name)) {
      throw new ToolRegistryError({
        code: "NOT_ALLOWED",
        toolName: tool.name,
        message: `工具 "${tool.name}" 不在允许注册的白名单中。`,
      });
    }

    if (this.tools.has(tool.name)) {
      throw new ToolRegistryError({
        code: "DUPLICATE_NAME",
        toolName: tool.name,
        message: `工具 "${tool.name}" 已经注册，不能重复注册。`,
      });
    }

    const storedTool: StoredTool = {
      name: tool.name,
      description: tool.description,

      input: tool.input,
      output: tool.output,

      requiredPermissions: Object.freeze([...(tool.requiredPermissions ?? [])]),

      handler: (input, context) => tool.handler(input as TInput, context),
    };

    this.tools.set(tool.name, storedTool);
  }

  listDefinitions(context?: Readonly<ToolInvocationContext>): readonly LLMToolDefinition[] {
    const definitions = [...this.tools.values()]
      .filter(
        (tool) =>
          !context ||
          tool.requiredPermissions.every((permission) => context.permissions.includes(permission)),
      )
      .map((tool) =>
        Object.freeze({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.input.jsonSchema,
        }),
      );

    return Object.freeze(definitions);
  }

  async invoke(
    toolName: string,
    rawInput: unknown,
    context: Readonly<ToolInvocationContext>,
  ): Promise<unknown> {
    const tool = this.tools.get(toolName);

    if (!tool) {
      throw new ToolRegistryError({
        code: "NOT_REGISTERED",
        toolName,
        message: `工具 "${toolName}" 未注册，禁止执行。`,
      });
    }

    this.assertPermissions(tool, context);

    let parsedInput: unknown;

    try {
      parsedInput = tool.input.parse(rawInput);
    } catch (cause: unknown) {
      throw new ToolRegistryError({
        code: "INVALID_INPUT",
        toolName,
        message: `工具 "${toolName}" 的输入参数无效。`,
        cause,
      });
    }

    let rawOutput: unknown;

    try {
      rawOutput = await tool.handler(parsedInput, context);
    } catch (cause: unknown) {
      throw new ToolRegistryError({
        code: "HANDLER_FAILED",
        cause,
        toolName,
        message: `工具 "${toolName}" 执行失败。`,
      });
    }

    try {
      return tool.output.parse(rawOutput);
    } catch (cause: unknown) {
      throw new ToolRegistryError({
        code: "INVALID_OUTPUT",
        toolName,
        message: `工具 "${toolName}" 返回了无效结果。`,
        cause,
      });
    }
  }

  private assertPermissions(tool: StoredTool, context: Readonly<ToolInvocationContext>): void {
    const permissions = new Set(context.permissions);

    const missingPermission = tool.requiredPermissions.find(
      (permission) => !permissions.has(permission),
    );

    if (missingPermission) {
      throw new ToolRegistryError({
        code: "FORBIDDEN",
        toolName: tool.name,
        message: `当前身份无权执行工具 "${tool.name}"。`,
      });
    }
  }
}

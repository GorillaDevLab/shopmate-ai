import { randomUUID } from "node:crypto";

import {
  INVENTORY_ALERT_CONFIRMATION_TTL_MS,
  InventoryAlertUpdateCancelCommandSchema,
  InventoryAlertUpdateConfirmCommandSchema,
  InventoryAlertUpdateOutcomeSchema,
  InventoryAlertUpdatePreviewSchema,
  isInventoryAlertConfirmationExpired,
  matchesInventoryAlertConfirmationActor,
  type InventoryAlertUpdateOutcome,
  type InventoryAlertUpdatePreview,
} from "@shopmate/contracts";

import { AuthPermission } from "../../auth/contracts/auth-context.js";

import {
  PrismaInventoryAlertUpdateRepository,
  type InventoryAlertUpdateRepository,
} from "./inventory-alert-update.repository.js";

import type { ToolInvocationContext, ToolRegistration, ToolSchema } from "./tool-registry.js";

export const INVENTORY_ALERT_UPDATE_TOOL_NAME = "update_inventory_alert_threshold";

export type InventoryAlertUpdateToolInput =
  | {
      readonly action: "PREVIEW";
      readonly skuId: string;
      readonly targetAlertThreshold: number;
    }
  | {
      readonly action: "CONFIRM";
      readonly confirmationToken: string;
    }
  | {
      readonly action: "CANCEL";
      readonly confirmationToken: string;
    };

export type InventoryAlertUpdateToolOutput =
  | InventoryAlertUpdatePreview
  | InventoryAlertUpdateOutcome;

export type InventoryAlertUpdateErrorCode =
  | "SKU_NOT_FOUND"
  | "CONFIRMATION_NOT_FOUND"
  | "ACTOR_MISMATCH"
  | "PERMISSION_DENIED";

export class InventoryAlertUpdateError extends Error {
  readonly code: InventoryAlertUpdateErrorCode;

  constructor(code: InventoryAlertUpdateErrorCode, message: string) {
    super(message);

    this.name = "InventoryAlertUpdateError";

    this.code = code;
  }

  toJSON(): Readonly<{
    code: InventoryAlertUpdateErrorCode;
    message: string;
  }> {
    return Object.freeze({
      code: this.code,
      message: this.message,
    });
  }
}

interface StoredConfirmation {
  readonly preview: InventoryAlertUpdatePreview;
  outcome?: InventoryAlertUpdateOutcome;
}

export class InMemoryInventoryAlertConfirmationStore {
  private readonly confirmations = new Map<string, StoredConfirmation>();

  save(preview: InventoryAlertUpdatePreview): void {
    this.confirmations.set(preview.confirmationToken, {
      preview,
    });
  }

  get(confirmationToken: string): StoredConfirmation | undefined {
    return this.confirmations.get(confirmationToken);
  }

  setOutcome(confirmationToken: string, outcome: InventoryAlertUpdateOutcome): void {
    const existing = this.confirmations.get(confirmationToken);

    if (!existing) {
      return;
    }

    existing.outcome = outcome;
  }
}

export interface InventoryAlertUpdateServiceOptions {
  readonly now?: () => Date;
  readonly createConfirmationId?: () => string;
  readonly createConfirmationToken?: () => string;
}

export class InventoryAlertUpdateService {
  private readonly now: () => Date;

  private readonly createConfirmationId: () => string;

  private readonly createConfirmationToken: () => string;

  constructor(
    private readonly repository: InventoryAlertUpdateRepository = new PrismaInventoryAlertUpdateRepository(),

    private readonly store = new InMemoryInventoryAlertConfirmationStore(),

    options: InventoryAlertUpdateServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());

    this.createConfirmationId =
      options.createConfirmationId ?? (() => `inventory-alert-${randomUUID()}`);

    this.createConfirmationToken = options.createConfirmationToken ?? (() => randomUUID());
  }

  async handle(
    input: InventoryAlertUpdateToolInput,
    context: Readonly<ToolInvocationContext>,
  ): Promise<InventoryAlertUpdateToolOutput> {
    switch (input.action) {
      case "PREVIEW":
        return this.preview(input, context);

      case "CONFIRM":
        return this.confirm(input.confirmationToken, context);

      case "CANCEL":
        return this.cancel(input.confirmationToken, context);
    }
  }

  async preview(
    input: Extract<InventoryAlertUpdateToolInput, { action: "PREVIEW" }>,
    context: Readonly<ToolInvocationContext>,
  ): Promise<InventoryAlertUpdatePreview> {
    const snapshot = await this.repository.findSkuSnapshot(context.merchantId, input.skuId);

    if (!snapshot) {
      throw new InventoryAlertUpdateError("SKU_NOT_FOUND", "未找到当前 Merchant 下的 SKU。");
    }

    const issuedAt = this.now();

    const preview = InventoryAlertUpdatePreviewSchema.parse({
      status: "PENDING",

      confirmationId: this.createConfirmationId(),

      confirmationToken: this.createConfirmationToken(),

      binding: {
        userId: context.userId,
        merchantId: context.merchantId,
        skuId: snapshot.skuId,
        targetAlertThreshold: input.targetAlertThreshold,
      },

      currentAlertThreshold: snapshot.alertThreshold,

      expectedSkuUpdatedAt: snapshot.updatedAt,

      issuedAt: issuedAt.toISOString(),

      expiresAt: new Date(issuedAt.getTime() + INVENTORY_ALERT_CONFIRMATION_TTL_MS).toISOString(),
    });

    this.store.save(preview);

    return preview;
  }

  async confirm(
    confirmationToken: string,
    context: Readonly<ToolInvocationContext>,
  ): Promise<InventoryAlertUpdateOutcome> {
    this.assertInventoryWritePermission(context);

    const command = InventoryAlertUpdateConfirmCommandSchema.parse({
      confirmationToken,
    });

    const state = this.getConfirmation(command.confirmationToken);

    this.assertActor(state.preview, context);

    if (state.outcome) {
      return state.outcome;
    }

    const now = this.now();

    if (isInventoryAlertConfirmationExpired(state.preview, now)) {
      const outcome = InventoryAlertUpdateOutcomeSchema.parse({
        status: "EXPIRED",

        confirmationId: state.preview.confirmationId,

        skuId: state.preview.binding.skuId,

        expiredAt: now.toISOString(),
      });

      this.store.setOutcome(command.confirmationToken, outcome);

      return outcome;
    }

    const result = await this.repository.confirmAlertThreshold({
      merchantId: state.preview.binding.merchantId,

      skuId: state.preview.binding.skuId,

      expectedAlertThreshold: state.preview.currentAlertThreshold,

      expectedSkuUpdatedAt: state.preview.expectedSkuUpdatedAt,

      targetAlertThreshold: state.preview.binding.targetAlertThreshold,
    });

    if (result.kind === "NOT_FOUND") {
      throw new InventoryAlertUpdateError("SKU_NOT_FOUND", "未找到当前 Merchant 下的 SKU。");
    }

    if (result.kind === "CONFLICT") {
      const outcome = InventoryAlertUpdateOutcomeSchema.parse({
        status: "CONFLICT",

        confirmationId: state.preview.confirmationId,

        skuId: result.skuId,

        expectedAlertThreshold: state.preview.currentAlertThreshold,

        actualAlertThreshold: result.actualAlertThreshold,

        expectedSkuUpdatedAt: state.preview.expectedSkuUpdatedAt,

        actualSkuUpdatedAt: result.actualSkuUpdatedAt,

        detectedAt: now.toISOString(),
      });

      this.store.setOutcome(command.confirmationToken, outcome);

      return outcome;
    }

    const outcome = InventoryAlertUpdateOutcomeSchema.parse({
      status: "CONFIRMED",

      confirmationId: state.preview.confirmationId,

      skuId: result.skuId,

      previousAlertThreshold: result.previousAlertThreshold,

      newAlertThreshold: result.newAlertThreshold,

      confirmedAt: now.toISOString(),
    });

    this.store.setOutcome(command.confirmationToken, outcome);

    return outcome;
  }

  cancel(
    confirmationToken: string,
    context: Readonly<ToolInvocationContext>,
  ): InventoryAlertUpdateOutcome {
    const command = InventoryAlertUpdateCancelCommandSchema.parse({
      confirmationToken,
    });

    const state = this.getConfirmation(command.confirmationToken);

    this.assertActor(state.preview, context);

    if (state.outcome) {
      return state.outcome;
    }

    const outcome = InventoryAlertUpdateOutcomeSchema.parse({
      status: "CANCELLED",

      confirmationId: state.preview.confirmationId,

      skuId: state.preview.binding.skuId,

      cancelledAt: this.now().toISOString(),
    });

    this.store.setOutcome(command.confirmationToken, outcome);

    return outcome;
  }

  private getConfirmation(confirmationToken: string): StoredConfirmation {
    const state = this.store.get(confirmationToken);

    if (!state) {
      throw new InventoryAlertUpdateError("CONFIRMATION_NOT_FOUND", "确认令牌不存在或已经失效。");
    }

    return state;
  }

  private assertActor(
    preview: InventoryAlertUpdatePreview,
    context: Readonly<ToolInvocationContext>,
  ): void {
    if (
      !matchesInventoryAlertConfirmationActor(preview, {
        userId: context.userId,
        merchantId: context.merchantId,
      })
    ) {
      throw new InventoryAlertUpdateError("ACTOR_MISMATCH", "当前身份不能使用该确认令牌。");
    }
  }

  private assertInventoryWritePermission(context: Readonly<ToolInvocationContext>): void {
    if (!context.permissions.includes(AuthPermission.InventoryWrite)) {
      throw new InventoryAlertUpdateError("PERMISSION_DENIED", "当前身份没有库存写入权限。");
    }
  }
}

export function createInventoryAlertUpdateToolRegistration(
  service = new InventoryAlertUpdateService(),
): ToolRegistration<InventoryAlertUpdateToolInput, InventoryAlertUpdateToolOutput> {
  return {
    name: INVENTORY_ALERT_UPDATE_TOOL_NAME,

    description: "预览、确认或取消当前 Merchant 的 SKU 库存预警值更新。",

    input: inventoryAlertUpdateInputSchema,

    output: inventoryAlertUpdateOutputSchema,

    requiredPermissions: [AuthPermission.InventoryWrite],

    handler: async (input, context) => service.handle(input, context),
  };
}

const inventoryAlertUpdateInputSchema: ToolSchema<InventoryAlertUpdateToolInput> = {
  jsonSchema: {
    oneOf: [
      {
        type: "object",
        properties: {
          action: {
            const: "PREVIEW",
          },
          skuId: {
            type: "string",
            minLength: 1,
          },
          targetAlertThreshold: {
            type: "integer",
            minimum: 0,
          },
        },
        required: ["action", "skuId", "targetAlertThreshold"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          action: {
            const: "CONFIRM",
          },
          confirmationToken: {
            type: "string",
          },
        },
        required: ["action", "confirmationToken"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          action: {
            const: "CANCEL",
          },
          confirmationToken: {
            type: "string",
          },
        },
        required: ["action", "confirmationToken"],
        additionalProperties: false,
      },
    ],
  },

  parse: parseInventoryAlertUpdateToolInput,
};

const inventoryAlertUpdateOutputSchema: ToolSchema<InventoryAlertUpdateToolOutput> = {
  jsonSchema: {
    type: "object",
  },

  parse(value: unknown): InventoryAlertUpdateToolOutput {
    if (isRecord(value) && value.status === "PENDING") {
      return InventoryAlertUpdatePreviewSchema.parse(value);
    }

    return InventoryAlertUpdateOutcomeSchema.parse(value);
  },
};

function parseInventoryAlertUpdateToolInput(value: unknown): InventoryAlertUpdateToolInput {
  if (!isRecord(value)) {
    throw new Error("工具输入必须是对象");
  }

  switch (value.action) {
    case "PREVIEW": {
      assertExactKeys(value, ["action", "skuId", "targetAlertThreshold"]);

      if (typeof value.skuId !== "string" || value.skuId.trim().length === 0) {
        throw new Error("skuId 无效");
      }

      if (
        typeof value.targetAlertThreshold !== "number" ||
        !Number.isInteger(value.targetAlertThreshold) ||
        value.targetAlertThreshold < 0
      ) {
        throw new Error("targetAlertThreshold 无效");
      }

      return {
        action: "PREVIEW",
        skuId: value.skuId.trim(),
        targetAlertThreshold: value.targetAlertThreshold,
      };
    }

    case "CONFIRM": {
      assertExactKeys(value, ["action", "confirmationToken"]);

      const command = InventoryAlertUpdateConfirmCommandSchema.parse({
        confirmationToken: value.confirmationToken,
      });

      return {
        action: "CONFIRM",
        confirmationToken: command.confirmationToken,
      };
    }

    case "CANCEL": {
      assertExactKeys(value, ["action", "confirmationToken"]);

      const command = InventoryAlertUpdateCancelCommandSchema.parse({
        confirmationToken: value.confirmationToken,
      });

      return {
        action: "CANCEL",
        confirmationToken: command.confirmationToken,
      };
    }

    default:
      throw new Error("不支持的库存预警操作");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys);

  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("工具输入包含未允许字段");
  }
}

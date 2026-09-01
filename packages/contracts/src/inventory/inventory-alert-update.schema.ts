import { z } from "zod";

export const INVENTORY_ALERT_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

export const INVENTORY_ALERT_CONFIRMATION_PROTOCOL = Object.freeze({
  previewWritesDatabase: false,
  repeatedConfirmation: "RETURN_SAME_CONFIRMED_RESULT",
  expiration: "REJECT_AT_OR_AFTER_EXPIRES_AT",
  concurrency: "REJECT_IF_THRESHOLD_OR_UPDATED_AT_CHANGED",
  actorBinding: "USER_AND_MERCHANT",
} as const);

const identifier = z
  .string({ error: "标识必须是字符串" })
  .trim()
  .min(1, { error: "标识不能为空" })
  .max(128, { error: "标识过长" });

const threshold = z
  .number({ error: "库存预警值必须是数字" })
  .int({ error: "库存预警值必须是整数" })
  .min(0, { error: "库存预警值不能为负数" })
  .max(2_147_483_647, {
    error: "库存预警值超出允许范围",
  });

const confirmationToken = z
  .string({ error: "确认令牌必须是字符串" })
  .min(24, { error: "确认令牌长度不足" })
  .max(256, { error: "确认令牌长度过长" })
  .regex(/^[A-Za-z0-9._~-]+$/u, {
    error: "确认令牌格式无效",
  });

const isoDateTime = z.string({ error: "时间必须是字符串" }).refine(
  (value) => {
    const timestamp = Date.parse(value);

    return Number.isFinite(timestamp) && value.includes("T");
  },
  {
    error: "时间必须使用有效 ISO 日期时间格式",
  },
);

export const InventoryAlertUpdateBindingSchema = z.strictObject({
  userId: identifier,
  merchantId: identifier,
  skuId: identifier,
  targetAlertThreshold: threshold,
});

export const InventoryAlertUpdatePreviewSchema = z
  .strictObject({
    status: z.literal("PENDING"),

    confirmationId: identifier,
    confirmationToken,

    binding: InventoryAlertUpdateBindingSchema,

    currentAlertThreshold: threshold,

    expectedSkuUpdatedAt: isoDateTime,

    issuedAt: isoDateTime,
    expiresAt: isoDateTime,
  })
  .superRefine((preview, context) => {
    if (Date.parse(preview.expiresAt) <= Date.parse(preview.issuedAt)) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "确认令牌过期时间必须晚于签发时间",
      });
    }
  });

export const InventoryAlertUpdateConfirmCommandSchema = z.strictObject({
  confirmationToken,
});

export const InventoryAlertUpdateCancelCommandSchema = z.strictObject({
  confirmationToken,
});

export const InventoryAlertUpdateConfirmedSchema = z.strictObject({
  status: z.literal("CONFIRMED"),

  confirmationId: identifier,
  skuId: identifier,

  previousAlertThreshold: threshold,
  newAlertThreshold: threshold,

  confirmedAt: isoDateTime,
});

export const InventoryAlertUpdateCancelledSchema = z.strictObject({
  status: z.literal("CANCELLED"),

  confirmationId: identifier,
  skuId: identifier,

  cancelledAt: isoDateTime,
});

export const InventoryAlertUpdateExpiredSchema = z.strictObject({
  status: z.literal("EXPIRED"),

  confirmationId: identifier,
  skuId: identifier,

  expiredAt: isoDateTime,
});

export const InventoryAlertUpdateConflictSchema = z.strictObject({
  status: z.literal("CONFLICT"),

  confirmationId: identifier,
  skuId: identifier,

  expectedAlertThreshold: threshold,
  actualAlertThreshold: threshold,

  expectedSkuUpdatedAt: isoDateTime,

  actualSkuUpdatedAt: isoDateTime,

  detectedAt: isoDateTime,
});

export const InventoryAlertUpdateOutcomeSchema = z.discriminatedUnion("status", [
  InventoryAlertUpdateConfirmedSchema,
  InventoryAlertUpdateCancelledSchema,
  InventoryAlertUpdateExpiredSchema,
  InventoryAlertUpdateConflictSchema,
]);

export type InventoryAlertUpdateBinding = z.infer<typeof InventoryAlertUpdateBindingSchema>;

export type InventoryAlertUpdatePreview = z.infer<typeof InventoryAlertUpdatePreviewSchema>;

export type InventoryAlertUpdateConfirmCommand = z.infer<
  typeof InventoryAlertUpdateConfirmCommandSchema
>;

export type InventoryAlertUpdateCancelCommand = z.infer<
  typeof InventoryAlertUpdateCancelCommandSchema
>;

export type InventoryAlertUpdateOutcome = z.infer<typeof InventoryAlertUpdateOutcomeSchema>;

export interface InventoryAlertActor {
  readonly userId: string;
  readonly merchantId: string;
}

export interface InventoryAlertSkuSnapshot {
  readonly skuId: string;
  readonly alertThreshold: number;
  readonly updatedAt: string;
}

export function isInventoryAlertConfirmationExpired(
  preview: InventoryAlertUpdatePreview,
  now: Date,
): boolean {
  return now.getTime() >= Date.parse(preview.expiresAt);
}

export function matchesInventoryAlertConfirmationActor(
  preview: InventoryAlertUpdatePreview,
  actor: Readonly<InventoryAlertActor>,
): boolean {
  return preview.binding.userId === actor.userId && preview.binding.merchantId === actor.merchantId;
}

export function hasInventoryAlertUpdateConflict(
  preview: InventoryAlertUpdatePreview,
  current: Readonly<InventoryAlertSkuSnapshot>,
): boolean {
  return (
    current.skuId !== preview.binding.skuId ||
    current.alertThreshold !== preview.currentAlertThreshold ||
    current.updatedAt !== preview.expectedSkuUpdatedAt
  );
}

import { describe, expect, it } from "vitest";

import {
  INVENTORY_ALERT_CONFIRMATION_PROTOCOL,
  INVENTORY_ALERT_CONFIRMATION_TTL_MS,
  InventoryAlertUpdateCancelCommandSchema,
  InventoryAlertUpdateConfirmCommandSchema,
  InventoryAlertUpdateOutcomeSchema,
  InventoryAlertUpdatePreviewSchema,
  hasInventoryAlertUpdateConflict,
  isInventoryAlertConfirmationExpired,
  matchesInventoryAlertConfirmationActor,
} from "../index.js";

const confirmationToken = ["fixture", "confirmation", "token", "001"].join("-");

const preview = {
  status: "PENDING" as const,

  confirmationId: "inventory-alert-confirmation-001",

  confirmationToken,

  binding: {
    userId: "user-001",
    merchantId: "merchant-001",
    skuId: "sku-001",
    targetAlertThreshold: 20,
  },

  currentAlertThreshold: 10,

  expectedSkuUpdatedAt: "2026-09-01T08:00:00.000Z",

  issuedAt: "2026-09-01T09:00:00.000Z",

  expiresAt: "2026-09-01T09:05:00.000Z",
};

describe("库存预警更新确认协议", () => {
  it("冻结 Preview 且首次请求不代表数据库写入", () => {
    expect(InventoryAlertUpdatePreviewSchema.parse(preview)).toEqual(preview);

    expect(INVENTORY_ALERT_CONFIRMATION_PROTOCOL.previewWritesDatabase).toBe(false);
  });

  it("确认令牌具有固定五分钟默认有效期", () => {
    expect(INVENTORY_ALERT_CONFIRMATION_TTL_MS).toBe(300_000);

    expect(Date.parse(preview.expiresAt) - Date.parse(preview.issuedAt)).toBe(
      INVENTORY_ALERT_CONFIRMATION_TTL_MS,
    );
  });

  it("拒绝已经过期或零有效期的 Preview", () => {
    const result = InventoryAlertUpdatePreviewSchema.safeParse({
      ...preview,
      expiresAt: preview.issuedAt,
    });

    expect(result.success).toBe(false);
  });

  it("确认和取消请求只能提交令牌", () => {
    expect(
      InventoryAlertUpdateConfirmCommandSchema.parse({
        confirmationToken,
      }),
    ).toEqual({
      confirmationToken,
    });

    expect(
      InventoryAlertUpdateCancelCommandSchema.parse({
        confirmationToken,
      }),
    ).toEqual({
      confirmationToken,
    });

    expect(
      InventoryAlertUpdateConfirmCommandSchema.safeParse({
        confirmationToken,
        merchantId: "merchant-other",
        skuId: "sku-other",
        targetAlertThreshold: 999,
      }).success,
    ).toBe(false);
  });

  it("确认绑定当前用户和 Merchant", () => {
    expect(
      matchesInventoryAlertConfirmationActor(preview, {
        userId: "user-001",
        merchantId: "merchant-001",
      }),
    ).toBe(true);

    expect(
      matchesInventoryAlertConfirmationActor(preview, {
        userId: "user-002",
        merchantId: "merchant-001",
      }),
    ).toBe(false);

    expect(
      matchesInventoryAlertConfirmationActor(preview, {
        userId: "user-001",
        merchantId: "merchant-002",
      }),
    ).toBe(false);
  });

  it("在 expiresAt 时刻及之后视为过期", () => {
    expect(isInventoryAlertConfirmationExpired(preview, new Date("2026-09-01T09:04:59.999Z"))).toBe(
      false,
    );

    expect(isInventoryAlertConfirmationExpired(preview, new Date("2026-09-01T09:05:00.000Z"))).toBe(
      true,
    );
  });

  it("原阈值变化时识别并发冲突", () => {
    expect(
      hasInventoryAlertUpdateConflict(preview, {
        skuId: "sku-001",
        alertThreshold: 11,
        updatedAt: preview.expectedSkuUpdatedAt,
      }),
    ).toBe(true);
  });

  it("SKU updatedAt 变化时识别并发冲突", () => {
    expect(
      hasInventoryAlertUpdateConflict(preview, {
        skuId: "sku-001",
        alertThreshold: 10,
        updatedAt: "2026-09-01T08:30:00.000Z",
      }),
    ).toBe(true);
  });

  it("快照没有变化时允许后续确认", () => {
    expect(
      hasInventoryAlertUpdateConflict(preview, {
        skuId: "sku-001",
        alertThreshold: 10,
        updatedAt: preview.expectedSkuUpdatedAt,
      }),
    ).toBe(false);
  });

  it("冻结确认取消过期和冲突结果", () => {
    const outcomes = [
      {
        status: "CONFIRMED",
        confirmationId: preview.confirmationId,
        skuId: "sku-001",
        previousAlertThreshold: 10,
        newAlertThreshold: 20,
        confirmedAt: "2026-09-01T09:01:00.000Z",
      },
      {
        status: "CANCELLED",
        confirmationId: preview.confirmationId,
        skuId: "sku-001",
        cancelledAt: "2026-09-01T09:01:00.000Z",
      },
      {
        status: "EXPIRED",
        confirmationId: preview.confirmationId,
        skuId: "sku-001",
        expiredAt: preview.expiresAt,
      },
      {
        status: "CONFLICT",
        confirmationId: preview.confirmationId,
        skuId: "sku-001",
        expectedAlertThreshold: 10,
        actualAlertThreshold: 11,
        expectedSkuUpdatedAt: preview.expectedSkuUpdatedAt,
        actualSkuUpdatedAt: "2026-09-01T08:30:00.000Z",
        detectedAt: "2026-09-01T09:01:00.000Z",
      },
    ];

    for (const outcome of outcomes) {
      expect(InventoryAlertUpdateOutcomeSchema.safeParse(outcome).success).toBe(true);
    }
  });

  it("协议明确重复确认返回同一确认结果", () => {
    expect(INVENTORY_ALERT_CONFIRMATION_PROTOCOL.repeatedConfirmation).toBe(
      "RETURN_SAME_CONFIRMED_RESULT",
    );
  });
});

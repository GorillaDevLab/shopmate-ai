import { describe, expect, it, vi } from "vitest";

import { AuthPermission } from "../../auth/contracts/auth-context.js";

import {
  InventoryAlertUpdateError,
  InventoryAlertUpdateService,
} from "./inventory-alert-update.tool.js";

import type { InventoryAlertUpdateRepository } from "./inventory-alert-update.repository.js";

const FIXED_TOKEN = ["inventory", "confirmation", "fixture", "0001"].join("-");

describe("InventoryAlertUpdateService", () => {
  it("Preview 只读取 SKU 且不会写数据库", async () => {
    const repository = createRepository();

    const service = createService(repository);

    const result = await service.preview(
      {
        action: "PREVIEW",
        skuId: "sku-001",
        targetAlertThreshold: 20,
      },
      writeContext(),
    );

    expect(result.status).toBe("PENDING");

    expect(result.currentAlertThreshold).toBe(10);

    expect(result.binding.targetAlertThreshold).toBe(20);

    expect(repository.findSkuSnapshot).toHaveBeenCalledWith("merchant-001", "sku-001");

    expect(repository.confirmAlertThreshold).not.toHaveBeenCalled();
  });

  it("跨 Merchant SKU 在 Preview 阶段被拒绝", async () => {
    const repository = createRepository(null);

    const service = createService(repository);

    await expect(
      service.preview(
        {
          action: "PREVIEW",
          skuId: "sku-other",
          targetAlertThreshold: 20,
        },
        writeContext(),
      ),
    ).rejects.toMatchObject({
      code: "SKU_NOT_FOUND",
    });

    expect(repository.confirmAlertThreshold).not.toHaveBeenCalled();
  });

  it("确认时重新检查库存写权限", async () => {
    const repository = createRepository();

    const service = createService(repository);

    const preview = await service.preview(
      {
        action: "PREVIEW",
        skuId: "sku-001",
        targetAlertThreshold: 20,
      },
      writeContext(),
    );

    await expect(
      service.confirm(preview.confirmationToken, {
        userId: "user-001",
        merchantId: "merchant-001",
        permissions: [],
      }),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });

    expect(repository.confirmAlertThreshold).not.toHaveBeenCalled();
  });

  it("不同 Merchant 不能使用确认令牌", async () => {
    const repository = createRepository();

    const service = createService(repository);

    const preview = await service.preview(
      {
        action: "PREVIEW",
        skuId: "sku-001",
        targetAlertThreshold: 20,
      },
      writeContext(),
    );

    await expect(
      service.confirm(preview.confirmationToken, {
        userId: "user-001",
        merchantId: "merchant-002",
        permissions: [AuthPermission.InventoryWrite],
      }),
    ).rejects.toMatchObject({
      code: "CONFIRMATION_NOT_FOUND",
    });

    expect(repository.confirmAlertThreshold).not.toHaveBeenCalled();
  });

  it("有效确认返回 SKU 旧值和新值", async () => {
    const repository = createRepository();

    const service = createService(repository);

    const preview = await service.preview(
      {
        action: "PREVIEW",
        skuId: "sku-001",
        targetAlertThreshold: 20,
      },
      writeContext(),
    );

    const result = await service.confirm(preview.confirmationToken, writeContext());

    expect(result).toEqual({
      status: "CONFIRMED",
      confirmationId: "confirmation-001",
      skuId: "sku-001",
      previousAlertThreshold: 10,
      newAlertThreshold: 20,
      confirmedAt: "2026-09-01T09:01:00.000Z",
    });

    expect(repository.confirmAlertThreshold).toHaveBeenCalledWith({
      merchantId: "merchant-001",
      skuId: "sku-001",
      expectedAlertThreshold: 10,
      expectedSkuUpdatedAt: "2026-09-01T08:00:00.000Z",
      targetAlertThreshold: 20,
    });
  });

  it("重复确认返回相同结果且不会重复写入", async () => {
    const repository = createRepository();

    const service = createService(repository);

    const preview = await service.preview(
      {
        action: "PREVIEW",
        skuId: "sku-001",
        targetAlertThreshold: 20,
      },
      writeContext(),
    );

    const first = await service.confirm(preview.confirmationToken, writeContext());

    const second = await service.confirm(preview.confirmationToken, writeContext());

    expect(second).toEqual(first);

    expect(repository.confirmAlertThreshold).toHaveBeenCalledTimes(1);
  });

  it("过期确认不会写数据库", async () => {
    const repository = createRepository();

    let now = new Date("2026-09-01T09:00:00.000Z");

    const service = new InventoryAlertUpdateService(repository, undefined, {
      now: () => now,

      createConfirmationId: () => "confirmation-001",

      createConfirmationToken: () => FIXED_TOKEN,
    });

    const preview = await service.preview(
      {
        action: "PREVIEW",
        skuId: "sku-001",
        targetAlertThreshold: 20,
      },
      writeContext(),
    );

    now = new Date("2026-09-01T09:05:00.000Z");

    const result = await service.confirm(preview.confirmationToken, writeContext());

    expect(result.status).toBe("EXPIRED");

    expect(repository.confirmAlertThreshold).not.toHaveBeenCalled();
  });

  it("未知确认令牌被拒绝", async () => {
    const repository = createRepository();

    const service = createService(repository);

    await expect(service.confirm(FIXED_TOKEN, writeContext())).rejects.toBeInstanceOf(
      InventoryAlertUpdateError,
    );
  });
});

function createRepository(
  snapshot: {
    readonly skuId: string;
    readonly alertThreshold: number;
    readonly updatedAt: string;
  } | null = {
    skuId: "sku-001",
    alertThreshold: 10,
    updatedAt: "2026-09-01T08:00:00.000Z",
  },
): InventoryAlertUpdateRepository {
  return {
    findSkuSnapshot: vi.fn(async () => snapshot),

    confirmAlertThreshold: vi.fn(async () => ({
      kind: "CONFIRMED" as const,
      skuId: "sku-001",
      previousAlertThreshold: 10,
      newAlertThreshold: 20,
    })),
  };
}

function createService(repository: InventoryAlertUpdateRepository) {
  return new InventoryAlertUpdateService(repository, undefined, {
    now: () => new Date("2026-09-01T09:01:00.000Z"),

    createConfirmationId: () => "confirmation-001",

    createConfirmationToken: () => FIXED_TOKEN,
  });
}

function writeContext() {
  return {
    userId: "user-001",
    merchantId: "merchant-001",
    permissions: [AuthPermission.InventoryWrite],
  } as const;
}

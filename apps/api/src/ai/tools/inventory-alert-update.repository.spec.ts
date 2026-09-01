import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({
  sku: {
    findFirst: vi.fn(),
  },

  $transaction: vi.fn(),
}));

vi.mock("@shopmate/database", () => ({
  getPrismaClient: () => databaseMocks,
}));

import { PrismaInventoryAlertUpdateRepository } from "./inventory-alert-update.repository.js";

describe("PrismaInventoryAlertUpdateRepository", () => {
  const transactionMocks = {
    sku: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    databaseMocks.$transaction.mockImplementation(
      async (callback: (transaction: typeof transactionMocks) => Promise<unknown>) =>
        callback(transactionMocks),
    );
  });

  it("读取 SKU 时始终限制 Merchant", async () => {
    databaseMocks.sku.findFirst.mockResolvedValue({
      id: "sku-001",
      alertThreshold: 10,
      updatedAt: new Date("2026-09-01T08:00:00.000Z"),
    });

    const repository = new PrismaInventoryAlertUpdateRepository();

    await expect(repository.findSkuSnapshot("merchant-001", "sku-001")).resolves.toEqual({
      skuId: "sku-001",
      alertThreshold: 10,
      updatedAt: "2026-09-01T08:00:00.000Z",
    });

    expect(databaseMocks.sku.findFirst).toHaveBeenCalledWith({
      where: {
        id: "sku-001",
        merchantId: "merchant-001",
      },
      select: {
        id: true,
        alertThreshold: true,
        updatedAt: true,
      },
    });
  });

  it("确认更新在事务内完成并返回前后值", async () => {
    transactionMocks.sku.findFirst.mockResolvedValue({
      id: "sku-001",
      alertThreshold: 10,
      updatedAt: new Date("2026-09-01T08:00:00.000Z"),
    });

    transactionMocks.sku.updateMany.mockResolvedValue({
      count: 1,
    });

    const repository = new PrismaInventoryAlertUpdateRepository();

    const result = await repository.confirmAlertThreshold({
      merchantId: "merchant-001",
      skuId: "sku-001",
      expectedAlertThreshold: 10,
      expectedSkuUpdatedAt: "2026-09-01T08:00:00.000Z",
      targetAlertThreshold: 20,
    });

    expect(databaseMocks.$transaction).toHaveBeenCalledTimes(1);

    expect(transactionMocks.sku.updateMany).toHaveBeenCalledWith({
      where: {
        id: "sku-001",
        merchantId: "merchant-001",
        alertThreshold: 10,
        updatedAt: new Date("2026-09-01T08:00:00.000Z"),
      },
      data: {
        alertThreshold: 20,
      },
    });

    expect(result).toEqual({
      kind: "CONFIRMED",
      skuId: "sku-001",
      previousAlertThreshold: 10,
      newAlertThreshold: 20,
    });
  });

  it("跨 Merchant SKU 不会被更新", async () => {
    transactionMocks.sku.findFirst.mockResolvedValue(null);

    const repository = new PrismaInventoryAlertUpdateRepository();

    await expect(
      repository.confirmAlertThreshold({
        merchantId: "merchant-001",
        skuId: "sku-other-merchant",
        expectedAlertThreshold: 10,
        expectedSkuUpdatedAt: "2026-09-01T08:00:00.000Z",
        targetAlertThreshold: 20,
      }),
    ).resolves.toEqual({
      kind: "NOT_FOUND",
    });

    expect(transactionMocks.sku.updateMany).not.toHaveBeenCalled();
  });

  it("Preview 后数据变化时返回冲突且不覆盖", async () => {
    transactionMocks.sku.findFirst.mockResolvedValue({
      id: "sku-001",
      alertThreshold: 15,
      updatedAt: new Date("2026-09-01T08:30:00.000Z"),
    });

    const repository = new PrismaInventoryAlertUpdateRepository();

    await expect(
      repository.confirmAlertThreshold({
        merchantId: "merchant-001",
        skuId: "sku-001",
        expectedAlertThreshold: 10,
        expectedSkuUpdatedAt: "2026-09-01T08:00:00.000Z",
        targetAlertThreshold: 20,
      }),
    ).resolves.toEqual({
      kind: "CONFLICT",
      skuId: "sku-001",
      actualAlertThreshold: 15,
      actualSkuUpdatedAt: "2026-09-01T08:30:00.000Z",
    });

    expect(transactionMocks.sku.updateMany).not.toHaveBeenCalled();
  });
  it("读取后写入前发生并发变化时不会覆盖新值", async () => {
    transactionMocks.sku.findFirst
      .mockResolvedValueOnce({
        id: "sku-001",
        alertThreshold: 10,
        updatedAt: new Date("2026-09-01T08:00:00.000Z"),
      })
      .mockResolvedValueOnce({
        id: "sku-001",
        alertThreshold: 15,
        updatedAt: new Date("2026-09-01T08:30:00.000Z"),
      });

    transactionMocks.sku.updateMany.mockResolvedValue({
      count: 0,
    });

    const repository = new PrismaInventoryAlertUpdateRepository();

    const result = await repository.confirmAlertThreshold({
      merchantId: "merchant-001",
      skuId: "sku-001",
      expectedAlertThreshold: 10,
      expectedSkuUpdatedAt: "2026-09-01T08:00:00.000Z",
      targetAlertThreshold: 20,
    });

    expect(transactionMocks.sku.updateMany).toHaveBeenCalledTimes(1);

    expect(result).toEqual({
      kind: "CONFLICT",
      skuId: "sku-001",
      actualAlertThreshold: 15,
      actualSkuUpdatedAt: "2026-09-01T08:30:00.000Z",
    });
  });
});

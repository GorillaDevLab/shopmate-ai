import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => {
  const client = {
    userMonitoringRule: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    monitoringNotification: {
      createMany: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  client.$transaction.mockImplementation(async (work: (transaction: typeof client) => unknown) =>
    work(client),
  );
  return client;
});

vi.mock("@shopmate/database", () => ({ getPrismaClient: () => databaseMocks }));

import { createAuthContext } from "../auth/contracts/index.js";
import { PrismaMonitoringRepository } from "./monitoring.repository.js";

const context = createAuthContext({
  userId: "user-1",
  merchantId: "merchant-1",
  permissions: [],
});

describe("PrismaMonitoringRepository", () => {
  const repository = new PrismaMonitoringRepository();

  beforeEach(() => vi.clearAllMocks());

  it("按用户与 Merchant Scope 读取规则", async () => {
    databaseMocks.userMonitoringRule.findFirst.mockResolvedValue(null);

    await expect(repository.findRule(context, "rule-2")).resolves.toBeNull();
    expect(databaseMocks.userMonitoringRule.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "rule-2", userId: "user-1", merchantId: "merchant-1" },
      }),
    );
  });

  it("在事务内去重写入提醒并更新运行状态", async () => {
    databaseMocks.monitoringNotification.createMany.mockResolvedValue({ count: 1 });
    databaseMocks.userMonitoringRule.updateMany.mockResolvedValue({ count: 1 });
    const completedAt = new Date("2026-09-03T00:00:00.000Z");
    const nextRunAt = new Date("2026-09-04T00:00:00.000Z");

    await expect(
      repository.completeRun(context, "rule-1", completedAt, nextRunAt, [
        {
          fingerprint: "fingerprint-1",
          title: "库存不足",
          message: "SKU-1 当前库存 2 件",
          severity: "WARNING",
          resourceType: "SKU",
          resourceId: "sku-1",
          periodStart: completedAt,
          periodEnd: completedAt,
        },
      ]),
    ).resolves.toBe(1);

    expect(databaseMocks.monitoringNotification.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ userId: "user-1", merchantId: "merchant-1" })],
      skipDuplicates: true,
    });
    expect(databaseMocks.userMonitoringRule.updateMany).toHaveBeenCalledWith({
      where: { id: "rule-1", userId: "user-1", merchantId: "merchant-1" },
      data: {
        lastRunAt: completedAt,
        nextRunAt,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
  });
});

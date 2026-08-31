import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAuthContext } from "../auth/contracts/index.js";
import { PrismaSalesQueryRepository } from "./sales-query.repository.js";

const databaseMocks = vi.hoisted(() => ({
  order: {
    findMany: vi.fn(),
  },
}));

vi.mock("@shopmate/database", () => ({
  getPrismaClient: () => databaseMocks,
}));

describe("PrismaSalesQueryRepository", () => {
  const repository = new PrismaSalesQueryRepository();

  const context = createAuthContext({
    userId: "user-1",
    merchantId: "merchant-1",
    permissions: [],
  });

  const startInclusive = new Date("2026-07-31T16:00:00.000Z");

  const endExclusive = new Date("2026-08-31T16:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();

    databaseMocks.order.findMany.mockResolvedValue([]);
  });

  it("始终使用当前 Merchant 查询订单", async () => {
    await repository.listEffectiveOrders(context, {
      startInclusive,
      endExclusive,
    });

    expect(databaseMocks.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          merchantId: "merchant-1",
        }),
      }),
    );
  });

  it("统一排除已取消订单", async () => {
    await repository.listEffectiveOrders(context, {
      startInclusive,
      endExclusive,
    });

    expect(databaseMocks.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            not: "CANCELLED",
          },
        }),
      }),
    );
  });

  it("使用左闭右开的日期范围查询", async () => {
    await repository.listEffectiveOrders(context, {
      startInclusive,
      endExclusive,
    });

    expect(databaseMocks.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orderedAt: {
            gte: startInclusive,
            lt: endExclusive,
          },
        }),
      }),
    );
  });

  it("无订单时返回空集合", async () => {
    const result = await repository.listEffectiveOrders(context, {
      startInclusive,
      endExclusive,
    });

    expect(result).toEqual([]);
  });
});

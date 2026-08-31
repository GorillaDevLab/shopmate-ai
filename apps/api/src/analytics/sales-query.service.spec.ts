import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAuthContext } from "../auth/contracts/index.js";
import type { SalesQueryRepository } from "./sales-query.repository.js";
import { SalesQueryService } from "./sales-query.service.js";

describe("SalesQueryService Asia/Shanghai 日期边界", () => {
  const repository = {
    listEffectiveOrders: vi.fn(),
  } satisfies SalesQueryRepository;

  const service = new SalesQueryService(repository);

  const context = createAuthContext({
    userId: "user-1",
    merchantId: "merchant-1",
    permissions: [],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    repository.listEffectiveOrders.mockResolvedValue([]);
  });

  it("正确转换上海时区月初边界", async () => {
    await service.listEffectiveOrders(context, {
      startDate: "2026-08-01",
      endDate: "2026-08-31",
    });

    expect(repository.listEffectiveOrders).toHaveBeenCalledWith(context, {
      startInclusive: new Date("2026-07-31T16:00:00.000Z"),
      endExclusive: new Date("2026-08-31T16:00:00.000Z"),
    });
  });

  it("单日查询覆盖完整的上海自然日", async () => {
    await service.listEffectiveOrders(context, {
      startDate: "2026-08-31",
      endDate: "2026-08-31",
    });

    expect(repository.listEffectiveOrders).toHaveBeenCalledWith(context, {
      startInclusive: new Date("2026-08-30T16:00:00.000Z"),
      endExclusive: new Date("2026-08-31T16:00:00.000Z"),
    });
  });

  it("无销售订单时返回空集合", async () => {
    repository.listEffectiveOrders.mockResolvedValue([]);

    const result = await service.listEffectiveOrders(context, {
      startDate: "2026-08-01",
      endDate: "2026-08-31",
    });

    expect(result).toEqual([]);
  });

  it("始终把当前 Merchant 上下文传给 Repository", async () => {
    await service.listEffectiveOrders(context, {
      startDate: "2026-08-01",
      endDate: "2026-08-31",
    });

    expect(repository.listEffectiveOrders).toHaveBeenCalledWith(context, expect.any(Object));
  });

  it("拒绝开始日期晚于结束日期", async () => {
    await expect(
      service.listEffectiveOrders(context, {
        startDate: "2026-09-01",
        endDate: "2026-08-31",
      }),
    ).rejects.toThrow("startDate must be earlier than or equal to endDate");
  });

  it("拒绝不存在的日期", async () => {
    await expect(
      service.listEffectiveOrders(context, {
        startDate: "2026-02-30",
        endDate: "2026-03-01",
      }),
    ).rejects.toThrow("date is not a valid calendar date");
  });
});

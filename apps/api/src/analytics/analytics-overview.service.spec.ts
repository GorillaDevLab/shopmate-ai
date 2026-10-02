import {
  BadRequestException,
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.hoisted(() => vi.fn());
vi.mock("@shopmate/database", () => ({ getPrismaClient: () => ({ order: { findMany } }) }));

import { AuthPermission, createAuthContext } from "../auth/contracts/index.js";
import { AnalyticsOverviewService } from "./analytics-overview.service.js";

const context = createAuthContext({
  userId: "user-1",
  merchantId: "merchant-1",
  permissions: Object.values(AuthPermission),
});

describe("AnalyticsOverviewService", () => {
  const service = new AnalyticsOverviewService();
  // 用块体：箭头直接返回 mock 会被 vitest 当作清理函数，在测试结束后再调用一次。
  beforeEach(() => {
    findMany.mockReset();
  });

  it("只查询当前商家本期与上一周期的非取消订单", async () => {
    findMany.mockResolvedValue([
      {
        orderedAt: new Date("2026-08-31T04:00:00.000Z"),
        totalAmount: { toString: () => "12.50" },
        store: { id: "s1", name: "北京朝阳店", platform: "OFFLINE" },
        items: [
          {
            quantity: 1,
            lineAmount: { toString: () => "12.50" },
            sku: { product: { id: "p1", name: "保温杯" } },
          },
        ],
      },
    ]);

    const result = await service.get(context, { asOfDate: "2026-08-31", startDate: "2026-08-02" });

    const where = findMany.mock.calls[0][0].where;
    expect(where.merchantId).toBe("merchant-1");
    expect(where.status).toEqual({ not: "CANCELLED" });
    expect(where.orderedAt.gte.toISOString()).toBe("2026-07-02T16:00:00.000Z");
    expect(where.orderedAt.lt.toISOString()).toBe("2026-08-31T16:00:00.000Z");
    expect(result.period).toEqual({ startDate: "2026-08-02", endDate: "2026-08-31", days: 30 });
    expect(result.comparisonPeriod.startDate).toBe("2026-07-03");
    expect(result.totals.current.revenueMinor).toBe(1250);
    expect(result.channels[0].name).toBe("北京朝阳店");
  });

  it("拒绝无效日期参数", async () => {
    await expect(service.get(context, { asOfDate: "2026-02-30" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(findMany).not.toHaveBeenCalled();
  });

  it("拒绝超过 366 天的统计周期", async () => {
    await expect(
      service.get(context, { asOfDate: "2026-08-31", startDate: "2025-01-01" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("没有订单读取权限时返回 403", async () => {
    const limited = createAuthContext({ userId: "u", merchantId: "m", permissions: [] });
    await expect(service.get(limited, { asOfDate: "2026-08-31" })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("订单数超过单次上限时提示缩短周期", async () => {
    findMany.mockResolvedValue(new Array(20_001).fill(null));
    await expect(service.get(context, { asOfDate: "2026-08-31" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("数据库故障时返回 503，不暴露内部错误", async () => {
    findMany.mockRejectedValue(new Error("connection refused"));
    const logged = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const error = await service.get(context, { asOfDate: "2026-08-31" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify((error as ServiceUnavailableException).getResponse())).not.toContain(
      "connection refused",
    );
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({
  userDashboardLayout: {
    findUnique: vi.fn(),
    create: vi.fn(),
    updateManyAndReturn: vi.fn(),
  },
}));

vi.mock("@shopmate/database", () => ({ getPrismaClient: () => databaseMocks }));

import { DEFAULT_DASHBOARD_LAYOUT } from "@shopmate/contracts";

import { createAuthContext } from "../auth/contracts/index.js";
import { PrismaDashboardLayoutRepository } from "./dashboard-layout.repository.js";

describe("PrismaDashboardLayoutRepository", () => {
  const repository = new PrismaDashboardLayoutRepository();
  const context = createAuthContext({
    userId: "user-1",
    merchantId: "merchant-1",
    permissions: [],
  });

  beforeEach(() => vi.clearAllMocks());

  it("读取时同时使用 userId 和 merchantId", async () => {
    databaseMocks.userDashboardLayout.findUnique.mockResolvedValue(null);

    await expect(repository.find(context)).resolves.toBeNull();
    expect(databaseMocks.userDashboardLayout.findUnique).toHaveBeenCalledWith({
      where: { userId_merchantId: { userId: "user-1", merchantId: "merchant-1" } },
      select: { layout: true, revision: true, updatedAt: true },
    });
  });

  it("revision 0 使用当前用户和 Merchant 创建首个布局", async () => {
    databaseMocks.userDashboardLayout.create.mockResolvedValue({
      layout: DEFAULT_DASHBOARD_LAYOUT,
      revision: 1,
      updatedAt: new Date("2026-09-02T00:00:00.000Z"),
    });

    await expect(repository.save(context, DEFAULT_DASHBOARD_LAYOUT, 0)).resolves.toMatchObject({
      kind: "saved",
      record: { revision: 1 },
    });
    expect(databaseMocks.userDashboardLayout.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        merchantId: "merchant-1",
        schemaVersion: 2,
        revision: 1,
        layout: DEFAULT_DASHBOARD_LAYOUT,
      },
      select: { layout: true, revision: true, updatedAt: true },
    });
  });

  it("已有布局只在预期版本匹配时原子更新", async () => {
    databaseMocks.userDashboardLayout.updateManyAndReturn.mockResolvedValue([
      {
        layout: DEFAULT_DASHBOARD_LAYOUT,
        revision: 3,
        updatedAt: new Date("2026-09-02T00:01:00.000Z"),
      },
    ]);

    await expect(repository.save(context, DEFAULT_DASHBOARD_LAYOUT, 2)).resolves.toMatchObject({
      kind: "saved",
      record: { revision: 3 },
    });
    expect(databaseMocks.userDashboardLayout.updateManyAndReturn).toHaveBeenCalledWith({
      where: { userId: "user-1", merchantId: "merchant-1", revision: 2 },
      data: { layout: DEFAULT_DASHBOARD_LAYOUT, schemaVersion: 2, revision: { increment: 1 } },
      select: { layout: true, revision: true, updatedAt: true },
    });
    expect(databaseMocks.userDashboardLayout.findUnique).not.toHaveBeenCalled();
  });

  it("两个设备同时首次创建时把唯一键竞争映射为版本冲突", async () => {
    databaseMocks.userDashboardLayout.create.mockRejectedValue({ code: "P2002" });

    await expect(repository.save(context, DEFAULT_DASHBOARD_LAYOUT, 0)).resolves.toEqual({
      kind: "conflict",
    });
  });

  it("版本已变化时返回冲突且不读取其他用户布局", async () => {
    databaseMocks.userDashboardLayout.updateManyAndReturn.mockResolvedValue([]);

    await expect(repository.save(context, DEFAULT_DASHBOARD_LAYOUT, 2)).resolves.toEqual({
      kind: "conflict",
    });
    expect(databaseMocks.userDashboardLayout.findUnique).not.toHaveBeenCalled();
  });
});

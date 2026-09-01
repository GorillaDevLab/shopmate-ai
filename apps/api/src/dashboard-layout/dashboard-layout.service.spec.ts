import { ConflictException } from "@nestjs/common";
import { DEFAULT_DASHBOARD_LAYOUT } from "@shopmate/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAuthContext } from "../auth/contracts/index.js";
import type { DashboardLayoutRepository } from "./dashboard-layout.repository.js";
import { DashboardLayoutService } from "./dashboard-layout.service.js";

describe("DashboardLayoutService", () => {
  const context = createAuthContext({
    userId: "user-layout",
    merchantId: "merchant-layout",
    permissions: [],
  });
  const repository = {
    find: vi.fn(),
    save: vi.fn(),
  } satisfies DashboardLayoutRepository;
  const service = new DashboardLayoutService(repository);

  beforeEach(() => vi.clearAllMocks());

  it("没有保存记录时返回可复现默认布局", async () => {
    repository.find.mockResolvedValue(null);
    await expect(service.get(context)).resolves.toEqual({
      layout: DEFAULT_DASHBOARD_LAYOUT,
      revision: 0,
      updatedAt: null,
    });
  });

  it("保存严格校验的布局并返回新版本", async () => {
    repository.save.mockResolvedValue({
      kind: "saved",
      record: {
        layout: DEFAULT_DASHBOARD_LAYOUT,
        revision: 1,
        updatedAt: new Date("2026-09-02T00:00:00.000Z"),
      },
    });

    await expect(
      service.save(context, { layout: DEFAULT_DASHBOARD_LAYOUT, expectedRevision: 0 }),
    ).resolves.toEqual({
      layout: DEFAULT_DASHBOARD_LAYOUT,
      revision: 1,
      updatedAt: "2026-09-02T00:00:00.000Z",
    });
    expect(repository.save).toHaveBeenCalledWith(context, DEFAULT_DASHBOARD_LAYOUT, 0);
  });

  it("拒绝 userId、merchantId 和未知布局配置", async () => {
    for (const body of [
      { layout: DEFAULT_DASHBOARD_LAYOUT, expectedRevision: 0, userId: "other" },
      { layout: DEFAULT_DASHBOARD_LAYOUT, expectedRevision: 0, merchantId: "other" },
      {
        layout: {
          ...DEFAULT_DASHBOARD_LAYOUT,
          cards: [{ ...DEFAULT_DASHBOARD_LAYOUT.cards[0], config: { metric: "sales", sql: "*" } }],
        },
        expectedRevision: 0,
      },
    ]) {
      await expect(service.save(context, body)).rejects.toMatchObject({ status: 400 });
    }
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("过期版本返回明确中文 409 冲突", async () => {
    repository.save.mockResolvedValue({ kind: "conflict" });

    const error = await service
      .save(context, { layout: DEFAULT_DASHBOARD_LAYOUT, expectedRevision: 1 })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ConflictException);
    if (!(error instanceof ConflictException)) throw new Error("预期看板布局版本冲突");
    expect(error.getResponse()).toEqual({
      statusCode: 409,
      code: "DASHBOARD_LAYOUT_VERSION_CONFLICT",
      message: "看板布局已在其他设备更新，请刷新后重试",
      retryable: true,
    });
  });
});

import { describe, expect, it } from "vitest";

import {
  DashboardLayoutReadResponseSchema,
  DashboardLayoutSaveRequestSchema,
} from "./dashboard-layout-api.schema.js";
import { DEFAULT_DASHBOARD_LAYOUT } from "./dashboard-layout.schema.js";

describe("用户看板布局 API 契约", () => {
  it("接受默认布局读取结果和首次保存请求", () => {
    expect(
      DashboardLayoutReadResponseSchema.parse({
        layout: DEFAULT_DASHBOARD_LAYOUT,
        revision: 0,
        updatedAt: null,
      }),
    ).toEqual({ layout: DEFAULT_DASHBOARD_LAYOUT, revision: 0, updatedAt: null });

    expect(
      DashboardLayoutSaveRequestSchema.parse({
        layout: DEFAULT_DASHBOARD_LAYOUT,
        expectedRevision: 0,
      }),
    ).toEqual({ layout: DEFAULT_DASHBOARD_LAYOUT, expectedRevision: 0 });
  });

  it.each([
    { layout: DEFAULT_DASHBOARD_LAYOUT, expectedRevision: -1 },
    { layout: DEFAULT_DASHBOARD_LAYOUT, expectedRevision: 1, userId: "other" },
    { layout: DEFAULT_DASHBOARD_LAYOUT, expectedRevision: 1, merchantId: "other" },
  ])("拒绝非法版本或身份覆盖字段 %#", (input) => {
    expect(DashboardLayoutSaveRequestSchema.safeParse(input).success).toBe(false);
  });

  it("要求持久化结果具有正整数版本和更新时间", () => {
    expect(
      DashboardLayoutReadResponseSchema.safeParse({
        layout: DEFAULT_DASHBOARD_LAYOUT,
        revision: 1,
        updatedAt: "2026-09-02T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      DashboardLayoutReadResponseSchema.safeParse({
        layout: DEFAULT_DASHBOARD_LAYOUT,
        revision: 1,
        updatedAt: null,
      }).success,
    ).toBe(false);
  });

  it("拒绝会在 PostgreSQL INTEGER 递增时溢出的版本", () => {
    expect(
      DashboardLayoutSaveRequestSchema.safeParse({
        layout: DEFAULT_DASHBOARD_LAYOUT,
        expectedRevision: 2_147_483_647,
      }).success,
    ).toBe(false);
  });
});

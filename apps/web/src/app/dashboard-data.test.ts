import { DashboardPreviewSchema } from "@shopmate/contracts";
import { describe, expect, it } from "vitest";

import { dashboardPreview, inventoryAlerts, metrics, products, trend } from "./dashboard-data";

describe("Dashboard 使用共享 Schema 校验演示数据", () => {
  it("所有预览区域均来自合法的共享展示模型", () => {
    expect(DashboardPreviewSchema.parse(dashboardPreview)).toEqual(dashboardPreview);
    expect(dashboardPreview.source).toBe("demo");
    expect(metrics).toHaveLength(4);
    expect(products).toHaveLength(3);
    expect(inventoryAlerts).toHaveLength(3);
    expect(trend).toHaveLength(7);
    expect(metrics).toBe(dashboardPreview.metrics);
    expect(products).toBe(dashboardPreview.products);
    expect(inventoryAlerts).toBe(dashboardPreview.inventoryAlerts);
    expect(trend).toBe(dashboardPreview.trend);
  });
});

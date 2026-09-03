import { expect, test, type Page } from "@playwright/test";

test("K7 桌面端保存布局并完成监听提醒流程", async ({ page }) => {
  await login(page);

  await page.getByRole("button", { name: /编辑看板/ }).click();
  await page.getByRole("button", { name: "销售额下移" }).click();
  await page.getByRole("button", { name: "销售额更多操作" }).click();
  await page.getByRole("menuitemradio", { name: "中" }).click();
  await page.getByRole("button", { name: "完成并保存" }).click();
  await expect(page.getByRole("status", { name: "布局保存状态" })).toContainText("已保存");

  await page.reload();
  await expect(page.locator('[data-dashboard-card-id="metric-sales"]')).toHaveAttribute(
    "data-size",
    "1/2",
  );

  await page.getByRole("button", { name: "经营监听" }).click();
  await page.getByLabel("监听内容").fill("库存低于 5 件时提醒我");
  await page.getByRole("button", { name: "生成预览" }).click();
  await expect(page.getByText("AI 理解为")).toBeVisible();
  await page.getByRole("button", { name: "确认创建" }).click();
  await page.getByRole("button", { name: "检查" }).first().click();
  await page.getByRole("button", { name: "关闭经营监听" }).click();

  await page.getByRole("button", { name: /通知/ }).click();
  await expect(page.getByRole("dialog", { name: "通知" })).toContainText("库存");
});

test("K7 375px 面板占满视口且页面不横向滚动", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);
  await page.getByRole("button", { name: "经营监听" }).click();

  const panel = page.getByRole("dialog", { name: "经营监听" });
  await expect(panel).toBeVisible();
  expect((await panel.boundingBox())?.width).toBe(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

async function login(page: Page): Promise<void> {
  await page.clock.setFixedTime(new Date("2026-08-31T04:00:00.000Z"));
  await page.goto("/login");
  await page.getByLabel("邮箱").fill("owner@shopmate.co.nz");
  await page.getByLabel("密码").fill("demo-pass-2026");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByText("数据来自 Analytics API")).toBeVisible();
}

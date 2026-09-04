import { expect, test, type Page } from "@playwright/test";

test("K7 桌面端保存布局并完成监听提醒流程", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page);
  const originalLayout = await readLayout(page);
  let createdRuleId: string | undefined;
  try {
    await resetLayoutToDefault(page);
    await expectDefaultDesktopFootprints(page);
    await page.getByRole("button", { name: /编辑看板/ }).click();
    await page.getByRole("button", { name: "销售额更多操作" }).click();
    await page.getByRole("menuitem", { name: "下移" }).click();
    await page.getByRole("menuitemradio", { name: "2 × 1" }).click();
    await page.getByRole("button", { name: "完成并保存" }).click();
    await expect(page.getByRole("status", { name: "布局保存状态" })).toContainText("已保存");

    await page.reload();
    await expect(page.locator('[data-dashboard-card-id="metric-sales"]')).toHaveAttribute(
      "data-size",
      "2x1",
    );

    await removeRulesNamed(page, "库存低于 4 件");
    await page.getByRole("button", { name: "经营监听" }).click();
    await page.getByLabel("监听内容").fill("库存低于 4 件时提醒我");
    await page.getByRole("button", { name: "生成预览" }).click();
    await expect(page.getByText("AI 理解为")).toBeVisible();
    const createResponse = page.waitForResponse(isRuleCreation);
    await page.getByRole("button", { name: "确认创建" }).click();
    createdRuleId = await ruleIdFrom(await createResponse);

    const ruleItem = page.getByRole("listitem").filter({ hasText: "库存低于 4 件" });
    const runResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/rules/${createdRuleId}/run`),
    );
    await ruleItem.getByRole("button", { name: "检查" }).click();
    await expect((await runResponse).ok()).toBe(true);
    await page.getByRole("button", { name: "关闭经营监听" }).click();

    await page.getByRole("button", { name: /通知/ }).click();
    await expect(page.getByRole("dialog", { name: "通知" })).toContainText("库存");
  } finally {
    if (createdRuleId) await page.request.delete(`/api/v1/monitoring/rules/${createdRuleId}`);
    await restoreLayout(page, originalLayout);
  }
});

test("K7 375px 面板占满视口且页面不横向滚动", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);
  const originalLayout = await readLayout(page);
  try {
    await resetLayoutToDefault(page);
    await page.getByRole("button", { name: /编辑看板/ }).click();
    await expect(page.locator('[data-dashboard-card-id="metric-sales"]')).toHaveAttribute(
      "data-size",
      "1x1",
    );
    await expect(page.getByRole("button", { name: "销售额更多操作" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      375,
    );

    await page.getByRole("button", { name: "经营监听" }).click();

    const panel = page.getByRole("dialog", { name: "经营监听" });
    await expect(panel).toBeVisible();
    expect((await panel.boundingBox())?.width).toBe(375);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      375,
    );
  } finally {
    await restoreLayout(page, originalLayout);
  }
});

async function expectDefaultDesktopFootprints(page: Page): Promise<void> {
  const metricIds = ["metric-sales", "metric-orders", "metric-units", "metric-average-order-value"];
  const metricBoxes = await Promise.all(
    metricIds.map((id) => page.locator(`[data-dashboard-card-id="${id}"]`).boundingBox()),
  );
  const tops = metricBoxes.map((box) => box?.y);
  expect(new Set(tops).size).toBe(1);
  const lefts = metricBoxes.map((box) => box?.x ?? 0);
  expect(lefts).toEqual([...lefts].sort((left, right) => left - right));
  await expect(page.locator('[data-dashboard-card-id="sales-trend"]')).toHaveAttribute(
    "data-size",
    "2x1",
  );
  await expect(page.locator('[data-dashboard-card-id="inventory-alerts"]')).toHaveAttribute(
    "data-size",
    "2x1",
  );
}

async function login(page: Page): Promise<void> {
  await page.clock.setFixedTime(new Date("2026-08-31T04:00:00.000Z"));
  await page.goto("/login");
  await page.getByLabel("邮箱").fill("owner@shopmate.co.nz");
  await page.getByLabel("密码").fill("demo-pass-2026");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByText("数据来自 Analytics API")).toBeVisible();
}

interface LayoutResponse {
  readonly layout: unknown;
  readonly revision: number;
}

async function readLayout(page: Page): Promise<LayoutResponse> {
  const response = await page.request.get("/api/v1/dashboard/layout");
  expect(response.ok()).toBe(true);
  return (await response.json()) as LayoutResponse;
}

async function resetLayoutToDefault(page: Page): Promise<void> {
  await page.getByRole("button", { name: /编辑看板/ }).click();
  await page.getByRole("button", { name: "更多布局操作" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("menuitem", { name: "恢复默认" }).click();
  await page.getByRole("button", { name: "完成并保存" }).click();
  await expect(page.getByRole("status", { name: "布局保存状态" })).toContainText(
    /已保存|布局已同步/,
  );
}

async function restoreLayout(page: Page, original: LayoutResponse): Promise<void> {
  const current = await readLayout(page);
  const response = await page.request.put("/api/v1/dashboard/layout", {
    data: { layout: original.layout, expectedRevision: current.revision },
  });
  expect(response.ok()).toBe(true);
}

async function removeRulesNamed(page: Page, name: string): Promise<void> {
  const response = await page.request.get("/api/v1/monitoring/rules");
  expect(response.ok()).toBe(true);
  const payload = (await response.json()) as {
    readonly items?: readonly { id: string; name: string }[];
  };
  for (const rule of payload.items ?? []) {
    if (rule.name === name) await page.request.delete(`/api/v1/monitoring/rules/${rule.id}`);
  }
}

function isRuleCreation(response: { request(): { method(): string }; url(): string }): boolean {
  return response.request().method() === "POST" && response.url().endsWith("/monitoring/rules");
}

async function ruleIdFrom(response: { ok(): boolean; json(): Promise<unknown> }): Promise<string> {
  expect(response.ok()).toBe(true);
  const payload = (await response.json()) as { readonly rule?: { readonly id?: unknown } };
  if (typeof payload.rule?.id !== "string") throw new Error("创建监听规则未返回规则 ID");
  return payload.rule.id;
}

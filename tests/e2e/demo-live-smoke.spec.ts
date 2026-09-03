import { expect, test } from "@playwright/test";

const demoEmail = requireEnv("DEMO_AUTH_EMAIL");
const demoPassword = requireEnv("DEMO_AUTH_PASSWORD");

const apiHealthUrl = "http:" + "//127.0.0.1:3001/api/v1/health";

test("J4 Production Demo 中文冒烟流程", async ({ page, request }) => {
  await page.clock.setFixedTime(new Date("2026-08-31T04:00:00.000Z"));

  await test.step("01 API 中文健康检查可用", async () => {
    const response = await request.get(apiHealthUrl);

    expect(response.ok()).toBe(true);

    const body = (await response.json()) as {
      status?: string;
      service?: string;
      message?: string;
    };

    expect(body.status).toBe("ok");
    expect(body.service).toBe("shopmate-api");
    expect(body.message).toMatch(/[\u4e00-\u9fff]/u);
  });

  await test.step("02 Production Web 入口可用", async () => {
    await page.goto("/login");

    await expect(
      page.getByRole("heading", {
        name: "登录你的经营看板",
      }),
    ).toBeVisible();

    await expect(page.getByLabel("邮箱")).toBeVisible();
    await expect(page.getByLabel("密码")).toBeVisible();
  });

  await test.step("03 Demo 登录成功", async () => {
    await page.getByLabel("邮箱").fill(demoEmail);
    await page.getByLabel("密码").fill(demoPassword);

    await page
      .getByRole("button", {
        name: "登录",
      })
      .click();

    await expect(page).toHaveURL("/");
  });

  await test.step("04 Dashboard 真实数据库链路可用", async () => {
    await expect(page.getByText("经营总览")).toBeVisible();

    await expect(
      page.getByRole("heading", {
        name: /经营，一眼看清/u,
      }),
    ).toBeVisible();

    await expect(page.getByText("数据来自 Analytics API")).toBeVisible();

    await expect(page.getByText("中文界面 · 移动端优先 · 隐私友好")).toBeVisible();
  });

  await test.step("05 打开中文 AI 经营助手", async () => {
    await page.goto("/chat");

    await expect(
      page.getByRole("heading", {
        name: "AI 经营助手",
      }),
    ).toBeVisible();

    await expect(page.getByText("中文经营助手")).toBeVisible();
  });

  await test.step("06 验证中文 AI 核心交互入口", async () => {
    await page
      .getByRole("button", {
        name: "查库存",
      })
      .click();

    const input = page.getByRole("textbox", {
      name: "消息",
    });

    await expect(input).toHaveValue("请查询当前库存");

    await expect(
      page.getByRole("button", {
        name: "发送消息",
      }),
    ).toBeEnabled();

    await expect(
      page.getByText("查询库存、热销和销售趋势，也可以根据真实商品信息生成五类中文营销文案。"),
    ).toBeVisible();
  });
});

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`J4 Live Smoke 缺少必需环境变量：${name}`);
  }

  return value;
}

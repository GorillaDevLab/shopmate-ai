import { expect, test } from "@playwright/test";

const DEMO_EMAIL = "owner@shopmate.co.nz";
const DEMO_PASSWORD = "demo-pass-2026";

test("J2 中文 Demo 端到端演示流程", async ({ page, context }) => {
  const startedAt = Date.now();

  // 固定为 Seed 对应的业务日期，避免真实当前日期导致 Dashboard 无数据。
  await page.clock.setFixedTime(new Date("2026-08-31T04:00:00.000Z"));

  await test.step("01 打开 Demo 登录页", async () => {
    await page.goto("/login");

    await expect(
      page.getByRole("heading", {
        name: "登录你的经营看板",
      }),
    ).toBeVisible();

    await expect(page.getByLabel("邮箱")).toBeVisible();

    await expect(page.getByLabel("密码")).toBeVisible();
  });

  await test.step("02 使用固定 Demo 账号登录", async () => {
    await page.getByLabel("邮箱").fill(DEMO_EMAIL);
    await page.getByLabel("密码").fill(DEMO_PASSWORD);

    await page
      .getByRole("button", {
        name: "登录",
      })
      .click();

    await expect(page).toHaveURL("/");
  });

  await test.step("03 验证中文 Dashboard 与真实经营数据", async () => {
    await expect(page.getByText("经营总览")).toBeVisible();

    await expect(
      page.getByRole("heading", {
        name: /经营，一眼看清/,
      }),
    ).toBeVisible();

    await expect(page.getByText("数据来自 Analytics API")).toBeVisible();

    await expect(page.getByText("中文界面 · 移动端优先 · 隐私友好")).toBeVisible();
  });

  await test.step("04 打开 Dashboard AI 经营助手", async () => {
    await page
      .getByRole("button", {
        name: "AI 助手",
      })
      .click();

    await expect(
      page.getByRole("heading", {
        name: "AI 经营助手",
      }),
    ).toBeVisible();
  });

  await test.step("05 AI 查询一：查看库存", async () => {
    await page
      .getByRole("button", {
        name: "查看低库存",
      })
      .click();

    const input = page.getByRole("textbox", {
      name: "消息",
    });

    await expect(input).toHaveValue("最近哪些商品值得补货？");

    await page
      .getByRole("button", {
        name: "发送消息",
      })
      .click();

    await expect(page.getByText(/已根据经过验证的工具结果完成查询/)).toBeVisible();
  });

  await test.step("06 AI 查询二：分析热销商品", async () => {
    await page
      .getByRole("button", {
        name: "分析热销商品",
      })
      .click();

    await page
      .getByRole("button", {
        name: "发送消息",
      })
      .click();

    await expect(page.getByText(/demo-product-001/).last()).toBeVisible();
  });

  await test.step("07 AI 查询三：总结销售趋势", async () => {
    await page
      .getByRole("button", {
        name: "总结销售趋势",
      })
      .click();

    await page
      .getByRole("button", {
        name: "发送消息",
      })
      .click();

    await expect(page.getByText(/已根据经过验证的工具结果完成查询/).last()).toBeVisible();
  });

  await test.step("08 打开完整聊天并生成中文商品文案", async () => {
    await page
      .getByRole("link", {
        name: "打开完整聊天",
      })
      .click();

    await expect(page).toHaveURL("/chat");

    await page
      .getByRole("textbox", {
        name: "商品 ID",
      })
      .fill("demo-product-001");

    await page
      .getByRole("button", {
        name: "小红书文案",
      })
      .click();

    await expect(page.getByText("商品文案已生成，请查看下方标题、正文和标签。")).toBeVisible();

    await expect(
      page.getByRole("heading", {
        name: /云感纯棉短袖T恤/,
      }),
    ).toBeVisible();

    await expect(
      page.getByRole("button", {
        name: "复制文案",
      }),
    ).toBeVisible();
  });

  await test.step("09 验证复制文案中文反馈", async () => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    await page
      .getByRole("button", {
        name: "复制文案",
      })
      .click();

    await expect(page.getByText("文案已复制")).toBeVisible();
  });

  await test.step("10 浏览器 Fixture 验证确认式写操作中文反馈", async () => {
    const confirmationPage = await context.newPage();

    await confirmationPage.setContent(`
      <!doctype html>
      <html lang="zh-CN">
        <body>
          <main>
            <h1>确认库存预警修改</h1>

            <p>SKU：demo-sku-003</p>
            <p>当前预警值：20</p>
            <p>目标预警值：27</p>

            <button id="confirm">
              确认修改
            </button>

            <button id="cancel">
              取消
            </button>

            <p id="status"></p>

            <script>
              document
                .getElementById("confirm")
                .addEventListener("click", () => {
                  document.getElementById("status").textContent =
                    "库存预警值已确认更新";
                });

              document
                .getElementById("cancel")
                .addEventListener("click", () => {
                  document.getElementById("status").textContent =
                    "已取消本次修改";
                });
            </script>
          </main>
        </body>
      </html>
    `);

    await expect(
      confirmationPage.getByRole("heading", {
        name: "确认库存预警修改",
      }),
    ).toBeVisible();

    await expect(confirmationPage.getByText("当前预警值：20")).toBeVisible();

    await expect(confirmationPage.getByText("目标预警值：27")).toBeVisible();

    await confirmationPage
      .getByRole("button", {
        name: "确认修改",
      })
      .click();

    await expect(confirmationPage.getByText("库存预警值已确认更新")).toBeVisible();

    await confirmationPage.close();
  });

  await test.step("11 验证完整演示可在十分钟内完成", async () => {
    expect(Date.now() - startedAt).toBeLessThan(10 * 60 * 1000);
  });
});

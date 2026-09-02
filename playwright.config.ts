import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

import { defineConfig, devices } from "@playwright/test";

if (!process.env.DATABASE_URL) {
  const databaseEnvPath = resolve(process.cwd(), "packages/database/.env");

  if (existsSync(databaseEnvPath)) {
    loadEnvFile(databaseEnvPath);
  }
}

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("J2 E2E 缺少 DATABASE_URL，请配置数据库测试环境");
}

export default defineConfig({
  testDir: "./tests/e2e",

  timeout: 10 * 60 * 1000,

  expect: {
    timeout: 10_000,
  },

  fullyParallel: false,
  workers: 1,
  retries: 0,

  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: "playwright-report",
        open: "never",
      },
    ],
  ],

  use: {
    baseURL: "http://127.0.0.1:3000",

    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",

    locale: "zh-CN",
  },

  webServer: [
    {
      command: "pnpm --filter @shopmate/api exec nest start",

      url: "http://127.0.0.1:3001/api/v1/health",

      timeout: 120_000,
      reuseExistingServer: false,

      env: {
        DATABASE_URL: databaseUrl,

        PORT: "3001",

        DEMO_AUTH_EMAIL: "owner@shopmate.co.nz",

        DEMO_AUTH_PASSWORD: "demo-pass-2026",

        DEMO_AUTH_USER_ID: "demo-user",

        DEMO_AUTH_MERCHANT_ID: "demo-merchant-cn",

        DEMO_SESSION_SECRET: "j2-demo-session-secret-for-browser-tests-2026",

        DEMO_SESSION_TTL_SECONDS: "3600",

        DEEPSEEK_API_KEY: "",
        DEEPSEEK_MODEL: "deepseek-v4-flash",

        DEEPSEEK_TIMEOUT_MS: "30000",
      },
    },

    {
      command: "pnpm --filter @shopmate/web exec next dev --hostname 127.0.0.1 --port 3000",

      url: "http://127.0.0.1:3000/login",

      timeout: 120_000,
      reuseExistingServer: false,

      env: {
        API_BASE_URL: "http://127.0.0.1:3001",
      },
    },
  ],

  projects: [
    {
      name: "chromium",

      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],
});

import { defineConfig, devices } from "@playwright/test";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`J4 Live Smoke 缺少必需环境变量：${name}`);
  }

  return value;
}

const databaseUrl = requireEnv("DATABASE_URL");
const deepSeekApiKey = requireEnv("DEEPSEEK_API_KEY");
const demoEmail = requireEnv("DEMO_AUTH_EMAIL");
const demoPassword = requireEnv("DEMO_AUTH_PASSWORD");
const demoUserId = requireEnv("DEMO_AUTH_USER_ID");
const demoMerchantId = requireEnv("DEMO_AUTH_MERCHANT_ID");
const demoSessionSecret = requireEnv("DEMO_SESSION_SECRET");

const webUrl = "http:" + "//127.0.0.1:3100";
const apiUrl = "http:" + "//127.0.0.1:3101";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "demo-live-smoke.spec.ts",

  timeout: 5 * 60 * 1000,

  expect: {
    timeout: 60_000,
  },

  fullyParallel: false,
  workers: 1,
  retries: 0,

  outputDir: "test-results/live",

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
    baseURL: webUrl,
    locale: "zh-CN",

    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },

  webServer: [
    {
      command: "pnpm --filter @shopmate/api start",
      url: `${apiUrl}/api/v1/health`,

      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        DATABASE_URL: databaseUrl,
        PORT: "3101",
        DEMO_AUTH_EMAIL: demoEmail,
        DEMO_AUTH_PASSWORD: demoPassword,
        DEMO_AUTH_USER_ID: demoUserId,
        DEMO_AUTH_MERCHANT_ID: demoMerchantId,
        DEMO_SESSION_SECRET: demoSessionSecret,
        DEMO_SESSION_TTL_SECONDS: process.env.DEMO_SESSION_TTL_SECONDS ?? "3600",

        DEEPSEEK_API_KEY: deepSeekApiKey,
        DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL ?? "",
        DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash",
        DEEPSEEK_TIMEOUT_MS: process.env.DEEPSEEK_TIMEOUT_MS ?? "30000",
      },
    },
    {
      command: "pnpm --filter @shopmate/web exec next start --hostname 127.0.0.1 --port 3100",
      url: `${webUrl}/login`,

      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        API_BASE_URL: apiUrl,
        NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? ".next-live",
      },
    },
  ],

  projects: [
    {
      name: "live-chromium",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],
});

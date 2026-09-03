import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const LIVE_DEMO_AUTH = {
  DEMO_AUTH_EMAIL: "owner@shopmate.co.nz",
  DEMO_AUTH_PASSWORD: "demo-live-smoke-2026",
  DEMO_AUTH_USER_ID: "demo-live-user",
  DEMO_AUTH_MERCHANT_ID: "demo-merchant-cn",
  DEMO_SESSION_SECRET: "j4-live-smoke-session-secret-not-production-2026",
  DEMO_SESSION_TTL_SECONDS: "3600",
};

export function readEnvFile(path) {
  if (!existsSync(path)) {
    return {};
  }

  const result = {};

  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }

    const separator = line.indexOf("=");

    const key = line.slice(0, separator).trim();

    let value = line.slice(separator + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

export function resolveLiveDemoEnv({ cwd = process.cwd(), baseEnv = process.env } = {}) {
  const rootEnv = readEnvFile(resolve(cwd, ".env"));

  const databaseEnv = readEnvFile(resolve(cwd, "packages/database/.env"));

  const env = {
    ...baseEnv,
    ...rootEnv,
    DATABASE_URL: baseEnv.DATABASE_URL ?? rootEnv.DATABASE_URL ?? databaseEnv.DATABASE_URL,
    API_BASE_URL: baseEnv.API_BASE_URL ?? rootEnv.API_BASE_URL ?? "http://127.0.0.1:3001",
    PORT: baseEnv.PORT ?? rootEnv.PORT ?? "3001",
    ...LIVE_DEMO_AUTH,
  };

  requireLiveValue(env, "DATABASE_URL");
  requireLiveValue(env, "DEEPSEEK_API_KEY");

  return env;
}

export function requireLiveValue(env, name) {
  const value = env[name]?.trim();

  if (!value) {
    throw new Error(`J4 Live Smoke 缺少必需环境变量：${name}`);
  }

  return value;
}

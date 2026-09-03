import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

export const DEMO_INIT_COMMANDS = [
  ["--filter", "@shopmate/database", "prisma:migrate:deploy"],
  ["--filter", "@shopmate/database", "seed:orders"],
];

export function loadRootEnvironment(cwd = process.cwd()) {
  const envPath = resolve(cwd, ".env");

  if (!process.env.DATABASE_URL && existsSync(envPath)) {
    loadEnvFile(envPath);
  }

  return process.env;
}

export function requireDatabaseUrl(env) {
  const databaseUrl = env.DATABASE_URL?.trim();

  if (!databaseUrl) {
    throw new Error("缺少必需环境变量：DATABASE_URL");
  }

  return databaseUrl;
}

export function initializeDemo({ env = process.env, execute = executePnpm } = {}) {
  requireDatabaseUrl(env);

  for (const args of DEMO_INIT_COMMANDS) {
    execute(args, env);
  }
}

export function executePnpm(args, env) {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`命令执行失败：pnpm ${args.join(" ")}`);
  }
}

if (import.meta.main) {
  try {
    const env = loadRootEnvironment();

    initializeDemo({ env });

    console.log("Demo 数据库 Migration 与 Seed 初始化完成。");
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";

    console.error(`Demo 初始化失败：${message}`);

    process.exitCode = 1;
  }
}

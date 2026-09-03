import { spawnSync } from "node:child_process";

import { resolveLiveDemoEnv } from "./demo-live-env.mjs";

const env = {
  ...resolveLiveDemoEnv(),
  RUN_J4_LIVE_AGENT: "1",
};

const steps = [
  {
    label: "构建 Production Web / API",
    args: ["build"],
  },
  {
    label: "执行 Migration 与 Demo Seed",
    args: ["demo:init"],
  },
  {
    label: "验证真实 Agent + Tool + Database 链路",
    args: [
      "--filter",
      "@shopmate/api",
      "exec",
      "vitest",
      "run",
      "test/j4-live-agent.e2e-spec.ts",
      "--reporter=verbose",
    ],
  },
  {
    label: "执行 Production 中文浏览器冒烟测试",
    args: ["exec", "playwright", "test", "--config=playwright.live.config.ts"],
  },
];

for (const step of steps) {
  process.stdout.write(`\n[J4] ${step.label}\n`);

  runPnpm(step.args, env);
}

process.stdout.write("\n[J4] Production 中文 Live Smoke 全部通过。\n");

function runPnpm(args, childEnv) {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: childEnv,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.stderr.write(`[J4] 步骤失败：pnpm ${args.join(" ")}\n`);

    process.exit(result.status ?? 1);
  }
}

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const requiredDirectories = ["apps", "packages", "docs", ".github"];
const requiredScripts = ["dev", "build", "test", "lint", "typecheck"];

test("包含约定的 Monorepo 根目录", () => {
  for (const directory of requiredDirectories) {
    assert.equal(existsSync(directory), true, `缺少目录：${directory}`);
  }
});

test("pnpm workspace 注册 apps 和 packages", () => {
  const workspace = readFileSync("pnpm-workspace.yaml", "utf8");

  assert.match(workspace, /apps\/\*/);
  assert.match(workspace, /packages\/\*/);
});

test("根 package.json 提供统一命令", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

  assert.equal(packageJson.private, true);
  assert.equal(packageJson.packageManager, "pnpm@11.24.0");

  for (const script of requiredScripts) {
    assert.equal(
      typeof packageJson.scripts[script],
      "string",
      `缺少命令：${script}`,
    );
  }
});

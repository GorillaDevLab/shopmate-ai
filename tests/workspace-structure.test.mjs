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
    assert.equal(typeof packageJson.scripts[script], "string", `缺少命令：${script}`);
  }
});

test("应用 TypeScript 配置继承共享严格基线", () => {
  const baseConfig = JSON.parse(readFileSync("tsconfig.base.json", "utf8"));
  const apiConfig = JSON.parse(readFileSync("apps/api/tsconfig.json", "utf8"));
  const webConfig = JSON.parse(readFileSync("apps/web/tsconfig.json", "utf8"));

  assert.equal(baseConfig.compilerOptions.strict, true);
  assert.equal(apiConfig.extends, "../../tsconfig.base.json");
  assert.equal(webConfig.extends, "../../tsconfig.base.json");
});

test("根目录提供分层测试与覆盖率命令", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

  for (const script of ["test:unit", "test:integration", "coverage"]) {
    assert.equal(typeof packageJson.scripts[script], "string", `缺少命令：${script}`);
  }
});

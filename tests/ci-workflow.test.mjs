import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflowPath = ".github/workflows/ci.yml";

test("required tenant gate includes product page validation and atomic commit", () => {
  const gate = readFileSync("scripts/test-tenant-database.mjs", "utf8");
  for (const suite of ["product-commit-input", "product-page-commit"]) {
    assert.ok(gate.includes(`test/integration/${suite}.test.mjs`));
  }
});

test("CI 工作流覆盖 PR、main 推送和手动触发", () => {
  const workflow = readFileSync(workflowPath, "utf8");

  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /push:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /branches:\s*\n\s*- main/);
});

test("CI 工作流使用锁文件缓存并执行质量门禁", () => {
  const workflow = readFileSync(workflowPath, "utf8");

  assert.match(workflow, /cache: pnpm/);
  assert.match(workflow, /pnpm-lock\.yaml/);
  for (const command of [
    "pnpm install --frozen-lockfile",
    "pnpm format:check",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm test",
    "pnpm build",
  ]) {
    assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

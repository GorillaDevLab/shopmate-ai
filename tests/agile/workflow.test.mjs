import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("metadata workflow has trusted default branch checkout and serialized event triggers", async () => {
  const yaml = await read(".github/workflows/agile-state-sync.yml");
  assert.match(yaml, /pull_request:\s*\n\s*types:\s*\[closed\]/);
  assert.match(yaml, /workflow_run:/);
  assert.match(yaml, /issues:/);
  assert.match(yaml, /workflow_dispatch:/);
  assert.match(yaml, /push:\s*\n\s*branches:\s*\[main\]/);
  assert.match(yaml, /cancel-in-progress: false/);
  assert.match(yaml, /ref: main/);
  assert.match(yaml, /persist-credentials: false/);
  assert.doesNotMatch(yaml, /schedule:|pnpm install|pnpm build|deploy/);
  assert.match(yaml, /agile-p3-p13/);
  assert.match(yaml, /agile-external-gate/);
});

test("workflow grants narrow repository permissions and creates a selected-repo App token", async () => {
  const yaml = await read(".github/workflows/agile-state-sync.yml");
  for (const permission of [
    "contents: read",
    "checks: read",
    "pull-requests: read",
    "actions: read",
    "issues: write",
  ])
    assert.match(yaml, new RegExp(permission));
  assert.match(yaml, /permission-organization-projects: write/);
  assert.match(yaml, /permission-issues: read/);
  assert.match(yaml, /repositories: shopmate-ai/);
  assert.match(yaml, /APP_PRIVATE_KEY/);
  assert.match(yaml, /--apply/);
  assert.match(yaml, /actions\/upload-artifact@[a-f0-9]{40}/);
  assert.match(yaml, /retention-days: 7/);
});

test("root test command registers focused Agile suite without removing existing tests", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  assert.match(packageJson.scripts.test, /tests\/agile\/\*\.test\.mjs/);
  assert.match(packageJson.scripts.test, /tests\/ci-workflow\.test\.mjs/);
});

test("rerun evidence artifacts use a unique run attempt name", async () => {
  const yaml = await read(".github/workflows/agile-state-sync.yml");
  assert.ok(yaml.includes("name: agile-state-plan-${{ github.run_id }}-${{ github.run_attempt }}"));
});

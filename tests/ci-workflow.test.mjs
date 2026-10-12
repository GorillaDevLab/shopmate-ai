import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
test("bounded publication and high-load source history are mandatory in tenant CI", () => {
  const gate = readFileSync("scripts/test-tenant-database.mjs", "utf8");
  assert.match(
    gate,
    /await run\("packages\/database", "test\/integration\/mock-source-slices\.test\.mjs"/u,
  );
  assert.match(gate, /await run\("apps\/source-worker", "test\/source-history\.test\.mjs"/u);
});

const workflowPath = ".github/workflows/ci.yml";

function jobBlock(workflow, name) {
  const normalized = workflow.replaceAll("\r\n", "\n");
  const start = normalized.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `Missing required CI job ${name}`);
  return normalized.slice(start + 1).split(/\n {2}[A-Za-z_][\w-]*:/u)[0];
}

test("four persistent history profiles run as independent required CI jobs", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const profiles = jobBlock(workflow, "sync-profiles");
  for (const profile of ["growing", "problematic", "mature", "new"])
    assert.match(profiles, new RegExp(`profile: ${profile}\\b`, "u"));
  assert.match(profiles, /profile: new\s+full: "true"/u);
  assert.match(profiles, /P2_ACCEPTANCE_PROFILE: \$\{\{ matrix\.profile \}\}/u);
  assert.match(profiles, /P2_ACCEPTANCE_FULL: \$\{\{ matrix\.full \}\}/u);
  assert.match(profiles, /run: pnpm test:profiles/u);
  assert.doesNotMatch(workflow, /continue-on-error:/u);
  const command = JSON.parse(readFileSync("package.json", "utf8")).scripts["test:profiles"];
  assert.equal(typeof command, "string");
  for (const dependency of ["contracts", "database", "api", "source-worker", "sync-worker"])
    assert.ok(command.includes(`--filter @shopmate/${dependency} build`));
  assert.ok(command.endsWith("node apps/sync-worker/test/profiles.test.mjs"));
});

test("all fifteen persistent scenarios and delivery boundaries are mandatory CI gates", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  assert.match(jobBlock(workflow, "sync-scenarios"), /run: pnpm test:scenarios/u);
  const command = JSON.parse(readFileSync("package.json", "utf8")).scripts["test:scenarios"];
  assert.equal(typeof command, "string");
  assert.ok(command.endsWith("node apps/sync-worker/test/scenarios.test.mjs"));
  const gate = readFileSync("scripts/test-tenant-database.mjs", "utf8");
  for (const suite of ["scenario-delivery", "scenario-interruption"])
    assert.ok(gate.includes(`test/${suite}.test.mjs`));
  assert.ok(gate.includes("test/integration/sync-scenario-delivery.test.mjs"));
});

test("durable sync restart, expired cursor, lost acknowledgment and revoked authority are mandatory", () => {
  const gate = readFileSync("scripts/test-tenant-database.mjs", "utf8");
  assert.match(gate, /await run\("apps\/sync-worker", "test\/runtime\.test\.mjs"/u);
});

test("real five-stream sync commerce composition is mandatory in tenant CI", () => {
  const gate = readFileSync("scripts/test-tenant-database.mjs", "utf8");
  assert.match(gate, /await run\("apps\/sync-worker", "test\/commerce\.test\.mjs"/u);
});

test("real sync checkpoint recovery builds its runtime and is mandatory in tenant CI", () => {
  const gate = readFileSync("scripts/test-tenant-database.mjs", "utf8");
  assert.match(gate, /await run\("apps\/sync-worker", "test\/checkpoint-read\.test\.mjs"/u);
  assert.match(
    JSON.parse(readFileSync("package.json", "utf8")).scripts["test:tenant"],
    /--filter @shopmate\/sync-worker build/u,
  );
});

test("grant-scoped failure metadata PostgreSQL coverage is mandatory", () => {
  assert.ok(
    readFileSync("scripts/test-tenant-database.mjs", "utf8").includes(
      "test/integration/sync-runtime-failure-rules.test.mjs",
    ),
  );
});

test("real source host recovery is mandatory in tenant CI", () => {
  const gate = readFileSync("scripts/test-tenant-database.mjs", "utf8");
  assert.match(gate, /await run\("apps\/source-worker", "test\/source-build\.test\.mjs"/u);
  assert.match(
    JSON.parse(readFileSync("package.json", "utf8")).scripts["test:tenant"],
    /--filter @shopmate\/source-worker build/u,
  );
});

test("source bulk insertion and live authorization plan checks are mandatory", () => {
  const gate = readFileSync("scripts/test-tenant-database.mjs", "utf8");
  for (const suite of ["mock-source-bulk-append", "mock-source-auth-plans"])
    assert.ok(gate.includes(`test/integration/${suite}.test.mjs`));
});

test("generic canonical page validators and atomic ingestion are mandatory in tenant CI", () => {
  assert.match(readFileSync(workflowPath, "utf8"), /run: pnpm test:tenant/u);
  const gate = readFileSync("scripts/test-tenant-database.mjs", "utf8");
  for (const suite of ["canonical-commit-input", "canonical-page-commit"]) {
    assert.ok(gate.includes(`test/integration/${suite}.test.mjs`));
  }
});

test("typed refund inventory marketing PostgreSQL suite is mandatory in the CI tenant gate", () => {
  assert.match(readFileSync(workflowPath, "utf8"), /run: pnpm test:tenant/u);
  assert.match(
    readFileSync("scripts/test-tenant-database.mjs", "utf8"),
    /await run\("packages\/database", "test\/integration\/canonical-commerce-facts\.test\.mjs"/u,
  );
});

test("typed canonical order PostgreSQL suite is mandatory in the CI tenant gate", () => {
  assert.match(readFileSync(workflowPath, "utf8"), /run: pnpm test:tenant/u);
  assert.match(
    readFileSync("scripts/test-tenant-database.mjs", "utf8"),
    /await run\("packages\/database", "test\/integration\/canonical-order-storage\.test\.mjs"/u,
  );
});

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
test("scenario version PostgreSQL suite is mandatory in the tenant gate", () => {
  assert.ok(
    readFileSync("scripts/test-tenant-database.mjs", "utf8").includes(
      "test/integration/mock-source-scenario-configuration.test.mjs",
    ),
  );
});
test("scenario management PostgreSQL suite is mandatory in the tenant gate", () => {
  assert.ok(
    readFileSync("scripts/test-tenant-database.mjs", "utf8").includes(
      "test/integration/demo-scenarios.test.mjs",
    ),
  );
});

test("server-derived sync bootstrap and grant-only SDK PostgreSQL suites are mandatory", () => {
  const gate = readFileSync("scripts/test-tenant-database.mjs", "utf8");
  for (const suite of ["sync-runtime-bootstrap", "sync-runtime-sdk"])
    assert.ok(gate.includes(`test/integration/${suite}.test.mjs`));
});

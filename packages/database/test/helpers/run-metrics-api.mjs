import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import pg from "pg";
import { isolatedPostgres } from "./isolated-postgres.mjs";
import { migrateSource } from "./mock-platform-fixture.mjs";
import { prepareTenantApiRuntime, prepareMetricApiRuntime } from "./tenant-api-fixture.mjs";
import { assertApiReport, tenantEnvironment } from "../../../../scripts/test-tenant-database.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
async function migrate(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await migrateSource(client);
  } finally {
    await client.end();
  }
}
function runApi(environment, report) {
  const child = spawn(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "--config",
      "vitest.tenant.config.ts",
      "test/metrics-database.e2e-spec.ts",
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    { cwd: path.join(root, "apps/api"), env: environment, stdio: "inherit", windowsHide: true },
  );
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error("Focused metric API proof failed")),
    );
  });
}
async function removeReport(directory) {
  const absolute = path.resolve(directory);
  if (
    path.dirname(absolute) !== path.resolve(os.tmpdir()) ||
    !path.basename(absolute).startsWith("shopmate-metric-reports-")
  )
    throw new Error("Refusing to remove an unowned metric report directory");
  await rm(absolute, { recursive: true, force: true });
}
// This focused wrapper owns its cluster: inherited test URLs must never select it.
delete process.env.TEST_DATABASE_URL;
const server = await isolatedPostgres();
let directory;
try {
  directory = await mkdtemp(path.join(os.tmpdir(), "shopmate-metric-reports-"));
  await migrate(server.url);
  const runtime = await prepareTenantApiRuntime(server.url);
  const metrics = await prepareMetricApiRuntime(server.url);
  const report = path.join(directory, "metrics.json");
  await runApi(tenantEnvironment(process.env, server.url, runtime, metrics), report);
  const counts = assertApiReport(JSON.parse(await readFile(report, "utf8")), [
    "test/metrics-database.e2e-spec.ts",
  ]);
  process.stdout.write(
    `metric-api-evidence tests=${counts[0].tests} pass=${counts[0].tests} skipped=0 pending=0 todo=0\n`,
  );
} finally {
  try {
    await server.stop();
  } finally {
    if (directory) await removeReport(directory);
  }
}

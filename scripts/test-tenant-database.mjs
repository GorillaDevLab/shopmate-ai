import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import {
  isolatedPostgres,
  requireIsolatedDatabaseUrl,
} from "../packages/database/test/helpers/isolated-postgres.mjs";
import { prepareTenantApiRuntime } from "../packages/database/test/helpers/tenant-api-fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const apiTargets = ["test/tenant-database.e2e-spec.ts", "test/demo-commerce-database.e2e-spec.ts"];
const forbiddenEnvironment =
  /(?:DATABASE|OPERATOR|MIGRATION|SHADOW|DIRECT|POSTGRES).*URL|(?:^|_)DB(?:_|$).*URL|^PG[A-Z_]*$|^DOTENV_CONFIG_/iu;
export function tenantEnvironment(inherited, isolatedUrl, runtimeUrl) {
  requireIsolatedDatabaseUrl(isolatedUrl);
  if (runtimeUrl) {
    requireIsolatedDatabaseUrl(runtimeUrl);
    const runtime = new URL(runtimeUrl);
    const isolated = new URL(isolatedUrl);
    if (
      runtime.host !== isolated.host ||
      runtime.pathname !== isolated.pathname ||
      runtime.username !== "shopmate_tenant_api"
    )
      throw new Error("API URL must use the prepared login on the owned isolated database");
  }
  return {
    ...Object.fromEntries(
      Object.entries(inherited).filter(([key]) => !forbiddenEnvironment.test(key)),
    ),
    DATABASE_URL: runtimeUrl ?? isolatedUrl,
    TEST_DATABASE_URL: isolatedUrl,
    ...(runtimeUrl ? { TENANT_TEST_OPERATOR_URL: isolatedUrl } : {}),
    DOTENV_CONFIG_OVERRIDE: "false",
  };
}
export function assertTapReport(output) {
  const counts = {};
  for (const key of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) {
    const matches = [...output.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, "gm"))];
    const value = Number(matches.at(-1)?.[1]);
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`Required TAP ${key} summary missing`);
    counts[key] = value;
  }
  if (
    counts.tests === 0 ||
    counts.pass !== counts.tests ||
    ["fail", "cancelled", "skipped", "todo"].some((key) => counts[key] !== 0)
  )
    throw new Error(
      "Required tenant target must execute positive tests with no failures, cancellation, skips or todos",
    );
  return counts;
}
export function assertApiReport(report, expected = apiTargets) {
  for (const key of [
    "numTotalTestSuites",
    "numPassedTestSuites",
    "numFailedTestSuites",
    "numPendingTestSuites",
    "numTotalTests",
    "numPassedTests",
    "numFailedTests",
    "numPendingTests",
    "numTodoTests",
  ])
    if (!Number.isSafeInteger(report?.[key]) || report[key] < 0)
      throw new Error("Required API report count missing");
  if (
    report.success !== true ||
    report.numTotalTests === 0 ||
    report.numTotalTests !== report.numPassedTests ||
    report.numTotalTestSuites !== report.numPassedTestSuites ||
    [
      "numFailedTestSuites",
      "numPendingTestSuites",
      "numFailedTests",
      "numPendingTests",
      "numTodoTests",
    ].some((key) => report[key] !== 0)
  )
    throw new Error("Required API tests must pass without skips, pending tests or todos");
  if (!Array.isArray(report.testResults) || report.testResults.length !== expected.length)
    throw new Error("Required API files missing");
  const counts = expected.map((file) => apiFileCount(report.testResults, file));
  if (counts.reduce((total, entry) => total + entry.tests, 0) !== report.numTotalTests)
    throw new Error("API assertion count mismatch");
  return counts;
}
function apiFileCount(results, file) {
  const matches = results.filter(
    (result) =>
      typeof result.name === "string" && result.name.replaceAll("\\", "/").endsWith(`/${file}`),
  );
  const result = matches[0];
  if (
    matches.length !== 1 ||
    result.status !== "passed" ||
    !Array.isArray(result.assertionResults) ||
    result.assertionResults.length === 0 ||
    result.assertionResults.some(
      (assertion) =>
        assertion.status !== "passed" ||
        !Array.isArray(assertion.failureMessages) ||
        assertion.failureMessages.length > 0,
    )
  )
    throw new Error(`Required API file did not execute passing assertions: ${file}`);
  return { file, tests: result.assertionResults.length };
}
function waitForChild(child, capture) {
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    capture.output = (capture.output + chunk.toString()).slice(-262_144);
  });
  child.stderr.pipe(process.stderr);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error("Required tenant database/API suite failed")),
    );
  });
}
async function run(directory, script, args, environment, apiReportPath) {
  const isolatedUrl = environment.TEST_DATABASE_URL ?? environment.TENANT_TEST_OPERATOR_URL;
  const capture = { output: "" };
  const child = spawn(
    process.execPath,
    [...(apiReportPath ? [] : ["--test", "--test-reporter=tap"]), script, ...args],
    {
      cwd: path.join(root, directory),
      env: tenantEnvironment(
        process.env,
        isolatedUrl,
        apiReportPath ? environment.DATABASE_URL : undefined,
      ),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  await waitForChild(child, capture);
  if (apiReportPath) {
    const counts = assertApiReport(JSON.parse(await readFile(apiReportPath, "utf8")));
    for (const { file, tests } of counts)
      process.stdout.write(
        `tenant-evidence apps/api/${file}: tests=${tests} pass=${tests} skipped=0 todo=0\n`,
      );
  } else {
    const counts = assertTapReport(capture.output);
    process.stdout.write(
      `tenant-evidence ${directory}/${script}: tests=${counts.tests} pass=${counts.pass} skipped=0 cancelled=0 todo=0\n`,
    );
  }
}
async function removeReportDirectory(directory) {
  if (!directory) return;
  const absolute = path.resolve(directory);
  if (
    path.dirname(absolute) !== path.resolve(os.tmpdir()) ||
    !path.basename(absolute).startsWith("shopmate-tenant-reports-")
  )
    throw new Error("Refusing to remove an unowned API report directory");
  await rm(absolute, { recursive: true, force: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await isolatedPostgres();
  let reportDirectory;
  try {
    reportDirectory = await mkdtemp(path.join(os.tmpdir(), "shopmate-tenant-reports-"));
    await run("packages/database", "test/integration/mock-source-slices.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("apps/source-worker", "test/source-history.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/mock-source-bulk-append.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/mock-source-auth-plans.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("apps/source-worker", "test/source-build.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/tenant-migration-paths.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/tenant-database.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/demo-failure-rules.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/demo-scenarios.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/demo-commerce-database.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run(
      "packages/database",
      "test/integration/mock-source-scenario-configuration.test.mjs",
      [],
      {
        TEST_DATABASE_URL: server.url,
      },
    );
    await run("packages/database", "test/integration/mock-platform-generation.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/mock-source-control.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/mock-platform-publication.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/mock-source-lease.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/mock-source-lease-ports.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/mock-source-append.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/mock-source-append-ports.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/mock-source-publish.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/mock-source-publish-ports.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/mock-source-scan.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/mock-build-hydration.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/sync-host-database.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/mock-source-read-control.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/canonical-product-storage.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/canonical-order-storage.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/canonical-commerce-facts.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/mock-source-latest.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/mock-source-read-port.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("apps/sync-worker", "test/checkpoint-read.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("apps/sync-worker", "test/commerce.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("apps/sync-worker", "test/runtime.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("apps/sync-worker", "test/scenario-delivery.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("apps/sync-worker", "test/scenario-interruption.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/mock-source-transaction.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/mock-source-control-races.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/mock-source-auth-races.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/mock-source-isolation-races.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/sync-page-receipt.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/product-commit-input.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/product-page-commit.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/canonical-commit-input.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/canonical-page-commit.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/sync-worker-progress.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/sync-worker-sdk.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/sync-runtime-bootstrap.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/sync-runtime-sdk.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/sync-runtime-failure-rules.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/sync-scenario-delivery.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    await run("packages/database", "test/integration/metric-storage.test.mjs", [], {
      TEST_DATABASE_URL: server.url,
    });
    const runtimeUrl = await prepareTenantApiRuntime(server.url);
    const reportPath = path.join(reportDirectory, "api.json");
    await run(
      "apps/api",
      "node_modules/vitest/vitest.mjs",
      [
        "run",
        "--config",
        "vitest.tenant.config.ts",
        "--reporter=default",
        "--reporter=json",
        `--outputFile=${reportPath}`,
      ],
      { DATABASE_URL: runtimeUrl, TENANT_TEST_OPERATOR_URL: server.url },
      reportPath,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Tenant suite failed"}\n`);
    process.exitCode = 1;
  } finally {
    try {
      await server.stop();
    } finally {
      await removeReportDirectory(reportDirectory);
    }
  }
}

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { isolatedPostgres } from "../packages/database/test/helpers/isolated-postgres.mjs";
import { prepareTenantApiRuntime } from "../packages/database/test/helpers/tenant-api-fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
function run(directory, script, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: path.join(root, directory),
      env: { ...process.env, ...environment },
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Required tenant database/API suite failed")),
    );
  });
}

const server = await isolatedPostgres();
try {
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
  const runtimeUrl = await prepareTenantApiRuntime(server.url);
  await run(
    "apps/api",
    "node_modules/vitest/vitest.mjs",
    ["run", "--config", "vitest.tenant.config.ts"],
    { DATABASE_URL: runtimeUrl, TENANT_TEST_OPERATOR_URL: server.url },
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Tenant suite failed"}\n`);
  process.exitCode = 1;
} finally {
  await server.stop();
}

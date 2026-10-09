import { spawn } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import pg from "pg";
import { isolatedPostgres } from "./isolated-postgres.mjs";
import { migrateSource } from "./mock-platform-fixture.mjs";
import { prepareTenantApiRuntime } from "./tenant-api-fixture.mjs";

const server = await isolatedPostgres();
const client = new pg.Client({ connectionString: server.url });
try {
  await client.connect();
  await migrateSource(client);
  await client.end();
  const runtime = await prepareTenantApiRuntime(server.url);
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "node_modules/vitest/vitest.mjs",
        "run",
        "--config",
        "vitest.tenant.config.ts",
        "test/demo-commerce-database.e2e-spec.ts",
        ...process.argv.slice(2),
      ],
      {
        cwd: fileURLToPath(new URL("../../../../apps/api/", import.meta.url)),
        windowsHide: true,
        stdio: "inherit",
        env: { ...process.env, DATABASE_URL: runtime, TENANT_TEST_OPERATOR_URL: server.url },
      },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Persistent API suite failed")),
    );
  });
} finally {
  await client.end();
  await server.stop();
}

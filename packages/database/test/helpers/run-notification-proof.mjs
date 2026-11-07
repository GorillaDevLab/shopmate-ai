import { execFileSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { isolatedPostgres } from "./isolated-postgres.mjs";
import { tenantEnvironment } from "../../../../scripts/test-tenant-database.mjs";

delete process.env.TEST_DATABASE_URL;
const server = await isolatedPostgres();
try {
  execFileSync(
    process.execPath,
    ["--test-reporter=tap", "test/integration/notification-outbox-storage.test.mjs"],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: tenantEnvironment(process.env, server.url),
      stdio: "inherit",
      windowsHide: true,
      timeout: 300_000,
    },
  );
} finally {
  await server.stop();
  process.stdout.write("notification-evidence owned PostgreSQL cluster stopped and removed\n");
}

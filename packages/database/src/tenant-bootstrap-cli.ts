import { bootstrapTenantMembership, TenantBootstrapSafetyError } from "./tenant-bootstrap.js";
import { disconnectPrismaClient } from "./client.js";

try {
  const result = await bootstrapTenantMembership(process.env);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message =
    error instanceof TenantBootstrapSafetyError
      ? error.message
      : "Tenant bootstrap failed; check environment marker and operator privileges";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
} finally {
  await disconnectPrismaClient();
}

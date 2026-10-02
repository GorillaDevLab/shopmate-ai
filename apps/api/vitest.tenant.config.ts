import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/tenant-database.e2e-spec.ts"],
    hookTimeout: 60_000,
    testTimeout: 30_000,
    maxWorkers: 1,
  },
});

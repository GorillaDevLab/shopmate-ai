import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["test/**/*.e2e-spec.ts", "test/**/*.e2e-spec.tsx"],
    passWithNoTests: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("keeps a separate executable boundary and builds before child import tests", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    name: string;
    scripts: Record<string, string>;
  };
  expect(pkg.name).toBe("@shopmate/sync-worker");
  expect(Object.keys(pkg.scripts).sort()).toEqual(["build", "lint", "start", "test", "typecheck"]);
  expect(pkg.scripts.start).toBe("node dist/main.js");
  expect(pkg.scripts.test).toContain("pnpm run build && vitest run");
});

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("exposes a pure package without a runnable CLI", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    name: string;
    scripts: Record<string, string>;
  };
  expect(pkg.name).toBe("@shopmate/sync-worker");
  expect(Object.keys(pkg.scripts).sort()).toEqual(["build", "lint", "test", "typecheck"]);
});

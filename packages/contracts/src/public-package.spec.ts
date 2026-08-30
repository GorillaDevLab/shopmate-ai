import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("@shopmate/contracts 公共包", () => {
  it.each(["@shopmate/contracts", "@shopmate/contracts/mock"])(
    "可由 Node.js 在运行时导入 %s",
    (specifier) => {
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", `await import(${JSON.stringify(specifier)})`],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    },
  );
});

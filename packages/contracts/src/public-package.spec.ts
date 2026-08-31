import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("@shopmate/contracts 公共包", () => {
  it.each(["@shopmate/contracts", "@shopmate/contracts/mock"])(
    "可由 Node.js 在运行时导入 %s",
    (specifier) => {
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", `await import(${JSON.stringify(specifier)})`],
        {
          cwd: process.cwd(),
          encoding: "utf8",
        },
      );

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    },
  );

  it("从根入口公开 LLM Provider 运行时契约", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          const contracts = await import("@shopmate/contracts");

          if (contracts.DEFAULT_LLM_LOCALE !== "zh-CN") {
            throw new Error("DEFAULT_LLM_LOCALE export missing");
          }

          if (
            !contracts.DEFAULT_LLM_SYSTEM_POLICY_ZH_CN.includes(
              "不得编造"
            )
          ) {
            throw new Error("LLM system policy export missing");
          }

          if (
            typeof contracts.LLMProviderError !== "function"
          ) {
            throw new Error("LLMProviderError export missing");
          }
        `,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

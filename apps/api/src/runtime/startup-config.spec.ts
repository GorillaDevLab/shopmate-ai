import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type ApiPackage = {
  scripts?: Record<string, string>;
};

type BuildConfig = {
  compilerOptions?: {
    rootDir?: string;
  };
  include?: string[];
};

const appRoot = resolve(process.cwd());
const packageJson = JSON.parse(
  readFileSync(resolve(appRoot, "package.json"), "utf8"),
) as ApiPackage;
const buildConfig = JSON.parse(
  readFileSync(resolve(appRoot, "tsconfig.build.json"), "utf8"),
) as BuildConfig;

describe("启动构建配置", () => {
  it("提供 start:dev 验收脚本", () => {
    expect(packageJson.scripts?.["start:dev"]).toBe("nest start --watch");
  });

  it("让 Nest 构建把入口输出到 dist 根目录", () => {
    expect(buildConfig.compilerOptions?.rootDir).toBe("./src");
    expect(buildConfig.include).toEqual(["src/**/*.ts"]);
  });
});

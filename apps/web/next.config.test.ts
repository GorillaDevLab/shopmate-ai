import { describe, expect, it } from "vitest";

import nextConfig from "./next.config";

describe("Next.js 配置", () => {
  it("不生成 AI Agent 规则文件", () => {
    expect(nextConfig).toMatchObject({ agentRules: false });
  });
});

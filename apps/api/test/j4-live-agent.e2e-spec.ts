import { NestFactory } from "@nestjs/core";
import { describe, expect, it } from "vitest";

import type { LLMProvider } from "@shopmate/contracts";

import { AppModule } from "../src/app.module.js";
import { AI_BUSINESS_AGENT, AI_LLM_PROVIDER } from "../src/ai/ai.module.js";
import type { BusinessAgent } from "../src/ai/agent/business-agent.js";
import { AuthPermission } from "../src/auth/contracts/auth-context.js";

const liveEnabled = process.env.RUN_J4_LIVE_AGENT === "1";

describe.skipIf(!liveEnabled)("J4 real Demo integration", () => {
  it("真实 DeepSeek + Tool + Database 完成中文库存查询", async () => {
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });

    try {
      const provider = app.get<LLMProvider>(AI_LLM_PROVIDER);

      expect(provider.name).toBe("deepseek");

      const agent = app.get<BusinessAgent>(AI_BUSINESS_AGENT);

      const result = await agent.run({
        question:
          "必须先调用 get_inventory_risks 工具查询 2026-08-25 到 2026-08-31 的低库存风险，limit 为 20；只依据工具结果用简体中文回答。",
        context: {
          userId: "demo-live-user",
          merchantId: "demo-merchant-cn",
          permissions: [AuthPermission.ProductsRead, AuthPermission.OrdersRead],
        },
      });

      expect(result.status).toBe("completed");

      expect(result.usedTools).toContain("get_inventory_risks");

      expect(result.answer).toMatch(/[\u4e00-\u9fff]/u);
    } finally {
      await app.close();
    }
  }, 60_000);
});

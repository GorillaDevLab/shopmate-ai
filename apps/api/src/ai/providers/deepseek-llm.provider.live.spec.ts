import { describe, expect, it } from "vitest";

import { DEFAULT_LLM_SYSTEM_POLICY_ZH_CN } from "@shopmate/contracts";

import { DeepSeekLLMProvider } from "./deepseek-llm.provider.js";

const hasLiveCredentials = Boolean(process.env.DEEPSEEK_API_KEY?.trim());

describe.skipIf(!hasLiveCredentials)("DeepSeekLLMProvider live", () => {
  it("真实模型连通并返回中文", async () => {
    const provider = new DeepSeekLLMProvider();

    const result = await provider.generate({
      messages: [
        {
          role: "system",
          content: DEFAULT_LLM_SYSTEM_POLICY_ZH_CN,
        },
        {
          role: "user",
          content: "请只用简体中文回复一句：ShopMate AI 连通测试成功。",
        },
      ],
      temperature: 0,
      maxOutputTokens: 80,
    });

    expect(result.finishReason).toBe("stop");

    expect(result.message.content).toBeTruthy();

    expect(result.message.content).toMatch(/[\u4e00-\u9fff]/);
  }, 60_000);
});

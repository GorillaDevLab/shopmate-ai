import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { AuthPermission, createAuthContext } from "../../auth/contracts/index.js";
import { AiChatService, type BusinessAgentRunner } from "./ai-chat.service.js";

const authContext = createAuthContext({
  userId: "user-chat",
  merchantId: "merchant-chat",
  permissions: [AuthPermission.ProductsRead, AuthPermission.OrdersRead],
});

describe("AiChatService", () => {
  it("只把服务端 AuthContext 和已校验消息传给 Agent", async () => {
    const run = vi.fn(async () => ({
      status: "completed" as const,
      answer: "当前有 2 项库存风险。",
      usedTools: ["get_inventory_risks"],
      rounds: 2,
    }));
    const service = new AiChatService({ run });

    const response = await service.chat(authContext, {
      message: { role: "user", content: "  查看库存风险  " },
    });

    expect(response).toEqual({
      message: { role: "assistant", content: "当前有 2 项库存风险。" },
    });
    expect(run).toHaveBeenCalledWith({
      question: "查看库存风险",
      context: {
        userId: "user-chat",
        merchantId: "merchant-chat",
        permissions: [AuthPermission.ProductsRead, AuthPermission.OrdersRead],
      },
    });
  });

  it.each([
    { message: { role: "assistant", content: "伪造" } },
    { message: { role: "user", content: "" } },
    { message: { role: "user", content: "查询", merchantId: "other" } },
  ])("把非法消息映射为统一中文 400 %#", async (input) => {
    const run = vi.fn<BusinessAgentRunner["run"]>();
    const service = new AiChatService({ run });

    const error = await service.chat(authContext, input).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toEqual({
      statusCode: 400,
      code: "INVALID_CHAT_MESSAGE",
      message: "聊天消息格式无效",
      retryable: false,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("把 Agent 受限结果映射为中文可重试错误", async () => {
    const agent: BusinessAgentRunner = {
      run: vi.fn(async () => ({
        status: "limited" as const,
        answer: "internal limited detail",
        usedTools: [],
        rounds: 1,
      })),
    };
    const service = new AiChatService(agent);

    const error = await service
      .chat(authContext, { message: { role: "user", content: "分析经营情况" } })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      statusCode: 503,
      code: "AI_CHAT_UNAVAILABLE",
      message: "AI 服务暂时不可用，请稍后重试",
      retryable: true,
    });
    expect(JSON.stringify((error as ServiceUnavailableException).getResponse())).not.toContain(
      "internal",
    );
  });

  it("隐藏 Agent 异常并返回中文可重试错误", async () => {
    const agent: BusinessAgentRunner = {
      run: vi.fn(() => Promise.reject(new Error("provider secret stack"))),
    };
    const service = new AiChatService(agent);

    const error = await service
      .chat(authContext, { message: { role: "user", content: "查询销售额" } })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify((error as ServiceUnavailableException).getResponse())).toBe(
      JSON.stringify({
        statusCode: 503,
        code: "AI_CHAT_UNAVAILABLE",
        message: "AI 服务暂时不可用，请稍后重试",
        retryable: true,
      }),
    );
  });
});

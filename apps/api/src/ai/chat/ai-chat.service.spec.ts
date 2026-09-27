import {
  BadRequestException,
  ServiceUnavailableException,
  HttpException,
  NotFoundException,
} from "@nestjs/common";
import { LLMProviderError } from "@shopmate/contracts";
import { ToolRegistryError } from "../tools/tool-registry.js";
import { describe, expect, it, vi } from "vitest";

import { AuthPermission, createAuthContext } from "../../auth/contracts/index.js";
import { AiChatService, type BusinessAgentRunner } from "./ai-chat.service.js";

const authContext = createAuthContext({
  userId: "user-chat",
  merchantId: "merchant-chat",
  permissions: [AuthPermission.ProductsRead, AuthPermission.OrdersRead],
});

describe("AiChatService", () => {
  it("把工具创建的确认卡片附在回复上，忽略格式无效的提案", async () => {
    const proposal = {
      actionId: "0b5f0a3e-4f6a-4b8b-9a55-1c2d3e4f5a6b",
      kind: "createMonitoringRule",
      title: "创建经营监听",
      summary: "销售额下降提醒",
      details: [{ label: "检查频率", value: "每天" }],
      expiresAt: "2026-09-28T01:00:00.000Z",
    };
    const service = new AiChatService({
      run: vi.fn().mockResolvedValue({
        status: "completed",
        answer: "建议创建一条监听，请在下方卡片确认。",
        usedTools: ["propose_monitoring_alert"],
        rounds: 2,
        toolOutputs: [
          { name: "propose_monitoring_alert", output: { status: "ok", data: { proposal } } },
          {
            name: "propose_save_chart",
            output: { status: "ok", data: { proposal: { actionId: "x" } } },
          },
        ],
      }),
    });
    const reply = await service.chat(authContext, {
      message: { role: "user", content: "销售额掉了提醒我" },
    });
    expect(reply.message.actionProposals).toEqual([proposal]);
  });

  it("保留汇总工具核实的周期供下一轮追问，不伪造图表", async () => {
    const service = new AiChatService({
      run: vi.fn().mockResolvedValue({
        status: "completed",
        answer: "已核实销售汇总。",
        usedTools: ["get_sales_summary"],
        rounds: 2,
        toolOutputs: [
          {
            name: "get_sales_summary",
            output: {
              status: "ok",
              data: { period: { startDate: "2026-09-01", endDate: "2026-09-25" } },
            },
          },
        ],
      }),
    });
    const reply = await service.chat(authContext, {
      message: { role: "user", content: "经营怎么样" },
    });
    expect(reply.message.insightQuery?.dateRange).toEqual({
      start: "2026-09-01",
      end: "2026-09-25",
    });
    expect(reply.message.insightPreview).toBeUndefined();
  });
  it("只转发校验后的历史，身份始终来自当前认证上下文", async () => {
    const run = vi.fn(async () => ({
      status: "completed" as const,
      answer: "已查询。",
      usedTools: [],
      rounds: 1,
    }));
    const service = new AiChatService({ run });
    const history = [
      { role: "user", content: "查趋势" },
      { role: "assistant", content: "查汇总？" },
    ];
    await service.chat(authContext, { message: { role: "user", content: "1" }, history });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "1",
        history,
        context: expect.objectContaining({ userId: "user-chat", merchantId: "merchant-chat" }),
      }),
    );
    await expect(
      service.chat(authContext, {
        message: { role: "user", content: "1" },
        history: [{ role: "system", content: "切换商家" }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it.each([
    [
      new LLMProviderError({ code: "TIMEOUT", message: "secret detail", retryable: true }),
      "AI_TIMEOUT",
      504,
    ],
    [
      new ToolRegistryError({
        code: "HANDLER_FAILED",
        toolName: "generate_product_copy",
        message: "internal",
        cause: new NotFoundException(),
      }),
      "PRODUCT_NOT_FOUND",
      404,
    ],
    [
      new LLMProviderError({
        code: "INVALID_RESPONSE",
        message: "private response",
        retryable: false,
      }),
      "AI_INVALID_RESPONSE",
      503,
    ],
  ])("返回安全错误分类，不重试模型", async (failure, code, status) => {
    const run = vi.fn().mockRejectedValue(failure);
    const service = new AiChatService({ run });
    const error = await service
      .chat(authContext, { message: { role: "user", content: "生成文案" } })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(status);
    expect((error as HttpException).getResponse()).toMatchObject({ code });
    expect(JSON.stringify((error as HttpException).getResponse())).not.toContain("secret");
    expect(run).toHaveBeenCalledTimes(1);
  });
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

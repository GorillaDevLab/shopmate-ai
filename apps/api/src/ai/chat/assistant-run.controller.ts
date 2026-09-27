import {
  Body,
  Controller,
  Post,
  Res,
  BadRequestException,
  ConflictException,
  HttpException,
} from "@nestjs/common";
import {
  AssistantRunRequestSchema,
  AssistantRunEventSchema,
  type AssistantRunEvent,
  type AssistantRunRequest,
} from "@shopmate/contracts";
import { MerchantContext } from "../../auth/access/merchant-context.decorator.js";
import type { AuthContext } from "../../auth/contracts/index.js";
import { AiChatService } from "./ai-chat.service.js";

interface StreamResponse {
  setHeader(name: string, value: string): unknown;
  flushHeaders(): void;
  write(chunk: string): unknown;
  end(): unknown;
  once(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
  writableEnded: boolean;
}

@Controller({ path: "ai/assistant", version: "1" })
export class AssistantRunController {
  private readonly seen = new Map<string, number>();
  private readonly active = new Set<string>();
  constructor(private readonly chatService: AiChatService) {}

  @Post("run")
  async run(
    @MerchantContext() context: AuthContext,
    @Body() raw: unknown,
    @Res() response: StreamResponse,
  ) {
    const parsed = AssistantRunRequestSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException({ code: "INVALID_CHAT_MESSAGE" });
    const { requestId, ...body } = parsed.data;
    const identity = JSON.stringify([context.merchantId, context.userId]);
    this.reserve(identity, requestId);
    try {
      await this.stream(context, { requestId, ...body }, response);
    } finally {
      this.active.delete(identity);
    }
  }

  private async stream(
    context: AuthContext,
    { requestId, ...body }: AssistantRunRequest,
    response: StreamResponse,
  ) {
    const controller = new AbortController();
    const close = () => controller.abort();
    response.once("close", close);
    const emit = (event: AssistantRunEvent) => {
      if (!controller.signal.aborted && !response.writableEnded)
        response.write(JSON.stringify(AssistantRunEventSchema.parse(event)) + "\n");
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let started = false;
    try {
      response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Accel-Buffering", "no");
      response.flushHeaders();
      started = true;
      timer = setTimeout(() => {
        try {
          emit({
            type: "failed",
            requestId,
            code: "AI_TIMEOUT",
            message: "处理超时，未自动重试。",
          });
        } finally {
          controller.abort();
          if (!response.writableEnded) response.end();
        }
      }, 180000);
      emit({ type: "accepted", requestId, label: "请求已接收" });
      const reply = await this.chatService.chat(context, body, {
        signal: controller.signal,
        onProgress: (type, label) => emit({ type, requestId, label }),
      });
      emit({ type: "completed", requestId, reply: reply.message });
    } catch (error) {
      if (!started) throw error;
      emit({ type: "failed", requestId, ...safeFailure(error) });
    } finally {
      clearTimeout(timer);
      response.removeListener("close", close);
      if (!response.writableEnded) response.end();
    }
  }

  private reserve(identity: string, requestId: string) {
    const now = Date.now();
    for (const [key, expires] of this.seen) if (expires < now) this.seen.delete(key);
    const key = JSON.stringify([identity, requestId]);
    if (this.active.has(identity) || this.seen.has(key))
      throw new ConflictException({ code: "AI_ALREADY_RUNNING" });
    if (this.seen.size >= 10000) throw new HttpException({ code: "AI_RATE_LIMIT" }, 429);
    this.seen.set(key, now + 10 * 60 * 1000);
    this.active.add(identity);
  }
}

function safeFailure(error: unknown) {
  const payload = error instanceof HttpException ? error.getResponse() : null;
  const code =
    payload && typeof payload === "object" && "code" in payload && typeof payload.code === "string"
      ? payload.code
      : "AI_CHAT_UNAVAILABLE";
  const messages: Record<string, string> = {
    AI_RESPONSE_REJECTED:
      "这次回答里有数字没能和系统数据对上，为避免给出错误数字已停止。可以换个问法或缩小时间、门店范围再试。",
    AI_FORBIDDEN: "当前账号没有此项数据的访问权限。",
    AI_TIMEOUT: "处理超时，未自动重试。",
    AI_RATE_LIMIT: "AI 服务请求过多，请稍后再试。",
    AI_CONFIGURATION: "AI 服务配置异常，请联系管理员。",
    AI_TOOL_LIMIT: "这个问题需要的查询步骤太多，已先停止。可以拆成几个更具体的问题分别问。",
    AI_CHAT_UNAVAILABLE: "AI 服务暂时没有返回有效结果，请稍后重试。",
  };
  return { code, message: messages[code] ?? "本次查询未完成，未自动重试；请稍后检查服务状态。" };
}

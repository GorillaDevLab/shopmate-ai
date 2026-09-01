import { Body, Controller, HttpCode, Post } from "@nestjs/common";

import { MerchantContext } from "../../auth/access/merchant-context.decorator.js";
import type { AuthContext } from "../../auth/contracts/index.js";
import { AiChatService } from "./ai-chat.service.js";

@Controller({ path: "ai/chat", version: "1" })
export class AiChatController {
  constructor(private readonly aiChatService: AiChatService) {}

  @Post()
  @HttpCode(200)
  chat(@MerchantContext() context: AuthContext, @Body() body: unknown) {
    return this.aiChatService.chat(context, body);
  }
}

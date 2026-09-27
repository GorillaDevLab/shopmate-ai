import { Controller, HttpCode, Param, Post } from "@nestjs/common";

import { MerchantContext } from "../../auth/access/merchant-context.decorator.js";
import type { AuthContext } from "../../auth/contracts/index.js";
import { AgentActionService } from "./agent-action.service.js";

@Controller({ path: "ai/actions", version: "1" })
export class AgentActionController {
  constructor(private readonly service: AgentActionService) {}

  @Post(":token/confirm")
  @HttpCode(200)
  confirm(@MerchantContext() context: AuthContext, @Param("token") token: string) {
    return this.service.confirm(context, token);
  }

  @Post(":token/cancel")
  @HttpCode(200)
  cancel(@MerchantContext() context: AuthContext, @Param("token") token: string) {
    return this.service.cancel(context, token);
  }
}

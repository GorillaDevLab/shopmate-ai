import { Body, Controller, HttpCode, Post } from "@nestjs/common";

import { MerchantContext } from "../../auth/access/merchant-context.decorator.js";
import type { AuthContext } from "../../auth/contracts/index.js";
import { DashboardInsightService } from "./dashboard-insight.service.js";

@Controller({ path: "ai/dashboard-insights", version: "1" })
export class DashboardInsightController {
  constructor(private readonly service: DashboardInsightService) {}

  @Post("preview")
  @HttpCode(200)
  preview(@MerchantContext() context: AuthContext, @Body() body: unknown) {
    return this.service.preview(context, body);
  }

  @Post("query")
  @HttpCode(200)
  query(@MerchantContext() context: AuthContext, @Body() body: unknown) {
    return this.service.execute(context, body);
  }
}

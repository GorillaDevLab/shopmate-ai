import { Body, Controller, Get, Put } from "@nestjs/common";

import { MerchantContext } from "../auth/access/merchant-context.decorator.js";
import type { AuthContext } from "../auth/contracts/index.js";
import { AnalyticsLayoutService } from "./analytics-layout.service.js";

@Controller({ path: "analytics/layout", version: "1" })
export class AnalyticsLayoutController {
  constructor(private readonly service: AnalyticsLayoutService) {}

  @Get()
  get(@MerchantContext() context: AuthContext) {
    return this.service.get(context);
  }

  @Put()
  save(@MerchantContext() context: AuthContext, @Body() body: unknown) {
    return this.service.save(context, body);
  }
}

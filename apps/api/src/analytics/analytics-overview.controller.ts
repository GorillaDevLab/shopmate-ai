import { Controller, Get, Query } from "@nestjs/common";

import { MerchantContext } from "../auth/access/merchant-context.decorator.js";
import type { AuthContext } from "../auth/contracts/index.js";
import { AnalyticsOverviewService } from "./analytics-overview.service.js";

@Controller({ path: "analytics/overview", version: "1" })
export class AnalyticsOverviewController {
  constructor(private readonly overviewService: AnalyticsOverviewService) {}

  @Get()
  get(@MerchantContext() context: AuthContext, @Query() query: Record<string, unknown>) {
    return this.overviewService.get(context, query);
  }
}

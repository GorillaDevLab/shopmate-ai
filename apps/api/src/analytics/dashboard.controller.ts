import { Controller, Get, Query } from "@nestjs/common";

import { MerchantContext } from "../auth/access/merchant-context.decorator.js";
import type { AuthContext } from "../auth/contracts/index.js";
import { DashboardApiService } from "./dashboard-api.service.js";

@Controller({ path: "analytics/dashboard", version: "1" })
export class DashboardController {
  constructor(private readonly dashboardApiService: DashboardApiService) {}

  @Get()
  get(@MerchantContext() context: AuthContext, @Query() query: Record<string, unknown>) {
    return this.dashboardApiService.get(context, query);
  }
}

import { Body, Controller, Get, Put } from "@nestjs/common";

import { MerchantContext } from "../auth/access/merchant-context.decorator.js";
import type { AuthContext } from "../auth/contracts/index.js";
import { DashboardLayoutService } from "./dashboard-layout.service.js";

@Controller({ path: "dashboard/layout", version: "1" })
export class DashboardLayoutController {
  constructor(private readonly dashboardLayoutService: DashboardLayoutService) {}

  @Get()
  get(@MerchantContext() context: AuthContext) {
    return this.dashboardLayoutService.get(context);
  }

  @Put()
  save(@MerchantContext() context: AuthContext, @Body() body: unknown) {
    return this.dashboardLayoutService.save(context, body);
  }
}

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";

import { MerchantContext } from "../auth/access/merchant-context.decorator.js";
import type { AuthContext } from "../auth/contracts/index.js";
import { MonitoringRuleGenerator } from "./monitoring-rule-generator.js";
import { MonitoringService } from "./monitoring.service.js";

@Controller({ path: "monitoring", version: "1" })
export class MonitoringController {
  constructor(
    private readonly service: MonitoringService,
    private readonly generator: MonitoringRuleGenerator,
  ) {}

  @Post("rules/preview")
  @HttpCode(200)
  preview(@MerchantContext() context: AuthContext, @Body() body: unknown) {
    return this.generator.generate(context, body);
  }

  @Post("rules")
  create(@MerchantContext() context: AuthContext, @Body() body: unknown) {
    return this.service.create(context, body);
  }

  @Get("rules")
  listRules(@MerchantContext() context: AuthContext) {
    return this.service.listRules(context);
  }

  @Patch("rules/:id/status")
  updateStatus(
    @MerchantContext() context: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.service.updateStatus(context, id, body);
  }

  @Delete("rules/:id")
  @HttpCode(204)
  deleteRule(@MerchantContext() context: AuthContext, @Param("id") id: string) {
    return this.service.deleteRule(context, id);
  }

  @Post("rules/:id/run")
  @HttpCode(200)
  runRule(@MerchantContext() context: AuthContext, @Param("id") id: string) {
    return this.service.runRule(context, id);
  }

  @Post("sync")
  @HttpCode(200)
  sync(@MerchantContext() context: AuthContext) {
    return this.service.sync(context);
  }

  @Get("notifications")
  listNotifications(@MerchantContext() context: AuthContext) {
    return this.service.listNotifications(context);
  }

  @Get("notifications/unread-count")
  unreadCount(@MerchantContext() context: AuthContext) {
    return this.service.unreadCount(context);
  }

  @Patch("notifications/:id/read")
  markRead(@MerchantContext() context: AuthContext, @Param("id") id: string) {
    return this.service.markRead(context, id);
  }

  @Post("notifications/read-all")
  @HttpCode(200)
  markAllRead(@MerchantContext() context: AuthContext) {
    return this.service.markAllRead(context);
  }
}

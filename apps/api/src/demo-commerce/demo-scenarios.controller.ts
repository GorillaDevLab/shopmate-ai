import { Body, Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from "@nestjs/common";
import type { AuthContext } from "../auth/contracts/index.js";
import { MerchantContext } from "../auth/access/merchant-context.decorator.js";
import { DemoCommerceGuard } from "./demo-commerce.guard.js";
import { DemoScenariosService } from "./demo-scenarios.service.js";
@Controller({ path: "demo-commerce/stores/:storeId/session/scenarios", version: "1" })
@UseGuards(DemoCommerceGuard)
export class DemoScenariosController {
  constructor(@Inject(DemoScenariosService) private readonly service: DemoScenariosService) {}
  @Get()
  get(@MerchantContext() actor: AuthContext, @Param("storeId") storeId: string) {
    return this.service.get({ userId: actor.userId, merchantId: actor.merchantId }, storeId);
  }
  @Post("load")
  @HttpCode(200)
  load(
    @MerchantContext() actor: AuthContext,
    @Param("storeId") storeId: string,
    @Body() body: unknown,
  ) {
    return this.service.load({ userId: actor.userId, merchantId: actor.merchantId }, storeId, body);
  }
}

import { Body, Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from "@nestjs/common";
import type { AuthContext } from "../auth/contracts/index.js";
import { MerchantContext } from "../auth/access/merchant-context.decorator.js";
import { DemoCommerceGuard } from "./demo-commerce.guard.js";
import { DemoCommerceService } from "./demo-commerce.service.js";

@Controller({ path: "demo-commerce/stores/:storeId/session", version: "1" })
@UseGuards(DemoCommerceGuard)
export class DemoCommerceController {
  constructor(@Inject(DemoCommerceService) private readonly service: DemoCommerceService) {}
  @Get()
  get(@MerchantContext() actor: AuthContext, @Param("storeId") storeId: string) {
    return this.service.get({ userId: actor.userId, merchantId: actor.merchantId }, storeId);
  }
  @Post()
  create(
    @MerchantContext() actor: AuthContext,
    @Param("storeId") storeId: string,
    @Body() body: unknown,
  ) {
    return this.service.create(
      { userId: actor.userId, merchantId: actor.merchantId },
      storeId,
      body,
    );
  }
  @Post("advance")
  @HttpCode(200)
  advance(
    @MerchantContext() actor: AuthContext,
    @Param("storeId") storeId: string,
    @Body() body: unknown,
  ) {
    return this.service.advance(
      { userId: actor.userId, merchantId: actor.merchantId },
      storeId,
      body,
    );
  }
  @Post("reset")
  @HttpCode(200)
  reset(
    @MerchantContext() actor: AuthContext,
    @Param("storeId") storeId: string,
    @Body() body: unknown,
  ) {
    return this.service.reset(
      { userId: actor.userId, merchantId: actor.merchantId },
      storeId,
      body,
    );
  }
  @Post("disconnect")
  @HttpCode(200)
  disconnect(
    @MerchantContext() actor: AuthContext,
    @Param("storeId") storeId: string,
    @Body() body: unknown,
  ) {
    return this.service.disconnect(
      { userId: actor.userId, merchantId: actor.merchantId },
      storeId,
      body,
    );
  }
}

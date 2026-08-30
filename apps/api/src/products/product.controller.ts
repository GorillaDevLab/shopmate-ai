import { Controller, Get, Param, Query } from "@nestjs/common";

import { MerchantContext } from "../auth/access/merchant-context.decorator.js";
import type { AuthContext } from "../auth/contracts/index.js";
import { ProductService } from "./product.service.js";

@Controller({ path: "products", version: "1" })
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @Get()
  list(@MerchantContext() context: AuthContext, @Query() query: Record<string, unknown>) {
    return this.productService.list(context, query);
  }

  @Get(":productId")
  detail(@MerchantContext() context: AuthContext, @Param() params: Record<string, unknown>) {
    return this.productService.findById(context, params);
  }
}

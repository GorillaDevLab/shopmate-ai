import { Module } from "@nestjs/common";

import { ProductController } from "./product.controller.js";
import { PRODUCT_REPOSITORY, PrismaProductRepository } from "./product.repository.js";
import { ProductService } from "./product.service.js";

@Module({
  controllers: [ProductController],
  providers: [
    ProductService,
    PrismaProductRepository,
    { provide: PRODUCT_REPOSITORY, useExisting: PrismaProductRepository },
  ],
  exports: [ProductService],
})
export class ProductModule {}

import { Module } from "@nestjs/common";

import { LOW_STOCK_REPOSITORY, PrismaLowStockRepository } from "./low-stock.repository.js";
import { LowStockService } from "./low-stock.service.js";
import { PrismaSalesQueryRepository, SALES_QUERY_REPOSITORY } from "./sales-query.repository.js";
import { SalesQueryService } from "./sales-query.service.js";

@Module({
  providers: [
    SalesQueryService,
    PrismaSalesQueryRepository,
    {
      provide: SALES_QUERY_REPOSITORY,
      useExisting: PrismaSalesQueryRepository,
    },

    LowStockService,
    PrismaLowStockRepository,
    {
      provide: LOW_STOCK_REPOSITORY,
      useExisting: PrismaLowStockRepository,
    },
  ],
  exports: [SalesQueryService, LowStockService],
})
export class AnalyticsModule {}

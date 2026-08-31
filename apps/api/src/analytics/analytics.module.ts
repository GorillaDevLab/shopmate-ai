import { Module } from "@nestjs/common";

import { DashboardApiService } from "./dashboard-api.service.js";
import { DashboardController } from "./dashboard.controller.js";
import { DashboardService } from "./dashboard.service.js";
import { LOW_STOCK_REPOSITORY, PrismaLowStockRepository } from "./low-stock.repository.js";
import { LowStockService } from "./low-stock.service.js";
import { ProductPerformanceService } from "./product-performance.service.js";
import { PrismaSalesQueryRepository, SALES_QUERY_REPOSITORY } from "./sales-query.repository.js";
import { SalesQueryService } from "./sales-query.service.js";

@Module({
  controllers: [DashboardController],
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

    DashboardService,
    DashboardApiService,
    ProductPerformanceService,
  ],

  exports: [SalesQueryService, LowStockService, DashboardService, ProductPerformanceService],
})
export class AnalyticsModule {}

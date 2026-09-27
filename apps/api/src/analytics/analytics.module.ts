import { Module } from "@nestjs/common";

import { AnalyticsLayoutController } from "./analytics-layout.controller.js";
import {
  ANALYTICS_LAYOUT_REPOSITORY,
  PrismaAnalyticsLayoutRepository,
} from "./analytics-layout.repository.js";
import { AnalyticsLayoutService } from "./analytics-layout.service.js";
import { AnalyticsOverviewController } from "./analytics-overview.controller.js";
import { AnalyticsOverviewService } from "./analytics-overview.service.js";
import { DashboardApiService } from "./dashboard-api.service.js";
import { DashboardController } from "./dashboard.controller.js";
import { DashboardService } from "./dashboard.service.js";
import { LOW_STOCK_REPOSITORY, PrismaLowStockRepository } from "./low-stock.repository.js";
import { LowStockService } from "./low-stock.service.js";
import { ProductPerformanceService } from "./product-performance.service.js";
import { PrismaSalesQueryRepository, SALES_QUERY_REPOSITORY } from "./sales-query.repository.js";
import { SalesQueryService } from "./sales-query.service.js";

@Module({
  controllers: [DashboardController, AnalyticsOverviewController, AnalyticsLayoutController],
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
    AnalyticsOverviewService,
    AnalyticsLayoutService,
    PrismaAnalyticsLayoutRepository,
    { provide: ANALYTICS_LAYOUT_REPOSITORY, useExisting: PrismaAnalyticsLayoutRepository },
    ProductPerformanceService,
  ],

  exports: [
    SalesQueryService,
    LowStockService,
    DashboardService,
    ProductPerformanceService,
    AnalyticsOverviewService,
    AnalyticsLayoutService,
  ],
})
export class AnalyticsModule {}

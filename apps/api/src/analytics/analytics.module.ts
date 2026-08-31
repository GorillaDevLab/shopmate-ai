import { Module } from "@nestjs/common";

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
  ],
  exports: [SalesQueryService],
})
export class AnalyticsModule {}

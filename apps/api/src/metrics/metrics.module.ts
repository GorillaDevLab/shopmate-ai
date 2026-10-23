import { Module } from "@nestjs/common";
import { TenantScopeService } from "../tenant/tenant-scope.service.js";
import {
  DatabaseTenantMembershipRepository,
  TENANT_MEMBERSHIP_REPOSITORY,
} from "../tenant/tenant-membership.repository.js";
import { MetricRuntimeService } from "./metric-runtime.service.js";
import { MetricsController } from "./metrics.controller.js";
import {
  MetricsQueryService,
  METRIC_READ_PORT,
  METRIC_HISTORY_READ_PORT,
  METRIC_STORE_OWNERSHIP_RESOLVER,
} from "./metrics-query.service.js";

@Module({
  controllers: [MetricsController],
  providers: [
    MetricRuntimeService,
    MetricsQueryService,
    TenantScopeService,
    { provide: TENANT_MEMBERSHIP_REPOSITORY, useClass: DatabaseTenantMembershipRepository },
    { provide: METRIC_READ_PORT, useExisting: MetricRuntimeService },
    { provide: METRIC_HISTORY_READ_PORT, useExisting: MetricRuntimeService },
    { provide: METRIC_STORE_OWNERSHIP_RESOLVER, useExisting: MetricRuntimeService },
  ],
  exports: [MetricRuntimeService],
})
export class MetricsModule {}

import { Module } from "@nestjs/common";
import { MetricsModule } from "../metrics/metrics.module.js";
import { MetricRuntimeService } from "../metrics/metric-runtime.service.js";
import { DecisionsModule } from "../decisions/decisions.module.js";
import { TenantScopeService } from "../tenant/tenant-scope.service.js";
import {
  DatabaseTenantMembershipRepository,
  TENANT_MEMBERSHIP_REPOSITORY,
} from "../tenant/tenant-membership.repository.js";
import { AuditAppendRepository } from "../audit/audit-append.repository.js";
import { EventsController } from "./events.controller.js";
import { EventLifecycleController } from "./event-lifecycle.controller.js";
import {
  EventQueryService,
  EVENT_STORE_OWNERSHIP_RESOLVER,
  EVENT_QUERY_PORT,
  EVENT_DECISION_SUMMARY_READER,
} from "./event-query.service.js";
import { EVENT_LIFECYCLE_SERVICE, EventLifecycleService } from "./event-lifecycle.service.js";
import { EventDecisionUnitOfWork } from "./event-decision-unit-of-work.js";
import { EventRuntimeSource } from "./event-runtime-source.js";
import { EventDecisionRuntimeService } from "./event-decision-runtime.service.js";
import { EventLifecycleRuntime } from "./event-lifecycle-runtime.js";
import { createEventDecisionPool } from "@shopmate/database";
import { EVENT_RUNTIME_POOL_FACTORY } from "./event-runtime-pool.js";

@Module({
  imports: [MetricsModule, DecisionsModule],
  controllers: [EventsController, EventLifecycleController],
  providers: [
    TenantScopeService,
    EventDecisionUnitOfWork,
    EventRuntimeSource,
    EventDecisionRuntimeService,
    EventLifecycleRuntime,
    EventQueryService,
    { provide: EVENT_RUNTIME_POOL_FACTORY, useValue: createEventDecisionPool },
    { provide: TENANT_MEMBERSHIP_REPOSITORY, useClass: DatabaseTenantMembershipRepository },
    { provide: EVENT_STORE_OWNERSHIP_RESOLVER, useExisting: MetricRuntimeService },
    {
      provide: EVENT_QUERY_PORT,
      inject: [EventDecisionUnitOfWork],
      useFactory: (uow: EventDecisionUnitOfWork) => uow.queryPort(),
    },
    {
      provide: EVENT_DECISION_SUMMARY_READER,
      inject: [EventDecisionUnitOfWork],
      useFactory: (uow: EventDecisionUnitOfWork) => ({
        read: (query: Parameters<ReturnType<EventDecisionUnitOfWork["decisions"]>["read"]>[0]) =>
          uow.read(query.actor, query.binding, (scope) => uow.decisions(scope).read(query)),
      }),
    },
    {
      provide: EVENT_LIFECYCLE_SERVICE,
      inject: [TenantScopeService, EventLifecycleRuntime],
      useFactory: (tenants: TenantScopeService, uow: EventLifecycleRuntime) =>
        new EventLifecycleService(tenants, uow, new AuditAppendRepository()),
    },
  ],
  exports: [EventDecisionRuntimeService],
})
export class EventsModule {}

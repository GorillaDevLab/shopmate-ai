import { HttpException, Injectable } from "@nestjs/common";
import type { EventQueryPort, EventRecord, TenantContext } from "@shopmate/contracts";
import type { AuthContext } from "../auth/contracts/index.js";
import type { BoundNotificationTransaction } from "../notifications/notification-enqueue.repository.js";
import { TenantScopeService, tenantNotFound } from "../tenant/tenant-scope.service.js";
import { MetricRuntimeService } from "../metrics/metric-runtime.service.js";
import { EventDecisionUnitOfWork, runtimeControl } from "./event-decision-unit-of-work.js";
import type {
  EventLifecycleUnitOfWork,
  LifecycleScope,
  LifecycleSelection,
} from "./event-lifecycle.service.js";
import type { EventRuntimeTransaction } from "./event-decision-transaction.js";
import { readRuntimeBundle } from "./event-runtime-source.js";
import { runtimeUnavailable } from "./event-transaction-lifetime.js";

@Injectable()
export class EventLifecycleRuntime
  implements EventLifecycleUnitOfWork<BoundNotificationTransaction>
{
  constructor(
    private readonly tenants: TenantScopeService,
    private readonly metrics: MetricRuntimeService,
    private readonly uow: EventDecisionUnitOfWork,
  ) {}
  async run<T>(
    identity: AuthContext,
    selection: LifecycleSelection,
    work: (scope: LifecycleScope<BoundNotificationTransaction>) => Promise<T>,
  ): Promise<T> {
    this.uow.requireAvailable();
    const actor = await this.tenants.resolve(identity, selection.workspaceId);
    if (actor.organizationId !== selection.organizationId) tenantNotFound();
    const binding = await this.resolve(actor, selection.storeId);
    return this.uow.transaction(
      {
        actor,
        binding,
        generation: null,
        revisions: [],
        recipientId: null,
        writable: true,
        control: runtimeControl(),
      },
      (scope) =>
        work({
          actor,
          binding,
          transaction: scope.handle,
          query: { detail: (query) => this.detail(scope, query) },
          events: {
            stateTransition: async (input) => {
              if (scope.authority.generation === null || scope.authority.revisions.length === 0)
                throw runtimeUnavailable();
              await scope.reauthorize();
              return this.uow.events(scope).stateTransition(input);
            },
          },
        }),
    );
  }
  private async resolve(actor: TenantContext, storeId: string) {
    try {
      const binding = await this.metrics.resolve(actor, storeId);
      if (!binding) tenantNotFound();
      return binding;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw runtimeUnavailable();
    }
  }
  private async detail(
    scope: EventRuntimeTransaction,
    query: Parameters<EventQueryPort["detail"]>[0],
  ) {
    const record = await this.uow.events(scope).detail(query);
    if (record.ok) await this.pin(scope, record.value);
    return record;
  }
  private async pin(scope: EventRuntimeTransaction, record: EventRecord): Promise<void> {
    const evidence = await this.uow.events(scope).evidence({
      actor: scope.authority.actor,
      binding: scope.authority.binding,
      eventId: record.id,
      reference: record.currentEvidence,
    });
    if (!evidence.ok) throw runtimeUnavailable();
    const value = evidence.value.evidence;
    const revisions = [...new Set(value.sourceReferences.map((ref) => ref.version))];
    if (revisions.length !== 1) throw runtimeUnavailable();
    const bundle = await readRuntimeBundle(scope, {
      binding: value.binding,
      window: {
        periodStart: value.periodStart,
        periodEnd: value.periodEnd,
        timezone: value.timezone,
        currency: value.currency,
      },
      visibleAt: value.observedAt,
      inputRevision: revisions[0]!,
      definitionVersion: value.definitionVersion,
      subject: value.entity.kind === "CONNECTION" ? { kind: "STORE" } : value.entity,
      kinds: [],
    });
    scope.authority.generation = bundle.generation;
    scope.authority.revisions = revisions;
    await scope.reauthorize();
  }
}

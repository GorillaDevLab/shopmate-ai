import { Injectable, Inject, HttpException, type OnModuleDestroy } from "@nestjs/common";
import {
  createEventRepository,
  createDecisionRunRepository,
  type EventDecisionPool,
} from "@shopmate/database";
import type {
  ConnectorBinding,
  EventQueryPort,
  SecurityClock,
  TenantContext,
} from "@shopmate/contracts";
import {
  EventDecisionTransactionOwner,
  type EventRuntimeTransaction,
} from "./event-decision-transaction.js";
import type { RuntimeAuthority } from "./event-runtime-authority.js";
import { eventRuntimeEnvironment } from "./event-runtime.environment.js";
import { runtimeUnavailable } from "./event-transaction-lifetime.js";
import { runtimeDecisionKey } from "../decisions/decision-runtime-policy.js";
import { EVENT_RUNTIME_POOL_FACTORY, type EventRuntimePoolFactory } from "./event-runtime-pool.js";

export const EVENT_SECURITY_CLOCK: SecurityClock = Object.freeze({
  timeDomain: "SECURITY_UTC",
  now: () => new Date().toISOString(),
});
export function runtimeControl(milliseconds = 30_000) {
  return {
    timeDomain: "SECURITY_UTC" as const,
    deadlineAt: new Date(Date.now() + milliseconds).toISOString(),
    signal: new AbortController().signal,
  };
}
@Injectable()
export class EventDecisionUnitOfWork implements OnModuleDestroy {
  private readonly configuration = eventRuntimeEnvironment(process.env);
  private pool: EventDecisionPool | undefined;
  constructor(
    @Inject(EVENT_RUNTIME_POOL_FACTORY) private readonly poolFactory: EventRuntimePoolFactory,
  ) {}
  requireAvailable(): void {
    if (!this.configuration) throw runtimeUnavailable();
  }
  async transaction<T>(
    input: RuntimeAuthority,
    work: (scope: EventRuntimeTransaction) => Promise<T>,
  ): Promise<T> {
    if (!this.configuration) throw runtimeUnavailable();
    this.pool ??= this.poolFactory(this.configuration.databaseUrl);
    try {
      return await new EventDecisionTransactionOwner(this.pool, EVENT_SECURITY_CLOCK).run(
        input,
        work,
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw runtimeUnavailable();
    }
  }
  read<T>(
    actor: TenantContext,
    binding: ConnectorBinding,
    work: (scope: EventRuntimeTransaction) => Promise<T>,
  ): Promise<T> {
    return this.transaction(
      {
        actor,
        binding,
        generation: null,
        revisions: [],
        recipientId: null,
        writable: false,
        control: runtimeControl(),
      },
      work,
    );
  }
  events(scope: EventRuntimeTransaction) {
    return createEventRepository({
      actor: scope.authority.actor,
      client: scope.client,
      now: EVENT_SECURITY_CLOCK.now,
    });
  }
  decisions(scope: EventRuntimeTransaction) {
    return createDecisionRunRepository({
      actor: scope.authority.actor,
      client: scope.client,
      clock: EVENT_SECURITY_CLOCK,
      decisionKey: runtimeDecisionKey,
    });
  }
  queryPort(): EventQueryPort {
    return {
      list: (query) =>
        this.read(query.actor, query.binding, (scope) => this.events(scope).list(query)),
      detail: (query) =>
        this.read(query.actor, query.binding, (scope) => this.events(scope).detail(query)),
      evidence: (query) =>
        this.read(query.actor, query.binding, (scope) => this.events(scope).evidence(query)),
      history: (query) =>
        this.read(query.actor, query.binding, (scope) => this.events(scope).history(query)),
    };
  }
  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}

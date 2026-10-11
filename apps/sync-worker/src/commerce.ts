import { types } from "node:util";
import {
  MockConnectorFactory,
  MockConnectorError,
  PersistentMockClock,
  type MockConnectorAccessResolver,
  type MockFailureRuleLoader,
} from "@shopmate/api/mock-commerce";
import {
  ReadOptionsSchema,
  TENANT_ROLE_PERMISSIONS,
  type CommerceConnector,
  type ConnectorResult,
  type ReadOptions,
} from "@shopmate/contracts";
import type { SyncRuntimeBootstrap, SyncWorkerPorts } from "@shopmate/database/sync-host";
import type { SourceReadPorts } from "@shopmate/database/mock-platform-read";
import { CommerceReadPort, commerceFailure } from "./commerce-read.js";
import { validReadSignal } from "./checkpoint-read.js";

type BootstrapPort = Pick<SyncWorkerPorts, "runtimeBootstrap">;
export interface OpenedSyncCommerce {
  readonly bootstrap: SyncRuntimeBootstrap;
  readonly connector: CommerceConnector;
}
function options(input: unknown): ReadOptions {
  const { signal, ...json } = optionData(input);
  const parsed = ReadOptionsSchema.safeParse(json);
  if (!parsed.success || (signal !== undefined && !validReadSignal(signal)))
    throw new MockConnectorError("INVALID_INPUT");
  return {
    ...parsed.data,
    ...(signal ? { signal } : {}),
    deadlineAt: new Date(
      Math.min(Date.parse(parsed.data.deadlineAt), Date.now() + 25000),
    ).toISOString(),
  };
}
function optionData(input: unknown): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    throw new MockConnectorError("INVALID_INPUT");
  const data: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      typeof key !== "string" ||
      !["requestId", "deadlineAt", "signal"].includes(key) ||
      !descriptor ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    )
      throw new MockConnectorError("INVALID_INPUT");
    data[key] = descriptor.value;
  }
  return data;
}
function check(call: ReadOptions): void {
  if (call.signal?.aborted) throw new MockConnectorError("ABORTED");
  if (Date.now() >= Date.parse(call.deadlineAt)) throw new MockConnectorError("TIMEOUT");
}
async function current(host: BootstrapPort, call: ReadOptions) {
  check(call);
  try {
    return await host.runtimeBootstrap();
  } catch (error) {
    throw commerceFailure(error);
  } finally {
    check(call);
  }
}
function identity(record: SyncRuntimeBootstrap) {
  return { userId: record.principalUserId, merchantId: record.merchantId, permissions: [] };
}

/** Only a checked SDK bootstrap supplies DEMO authority; callers supply read controls alone. */
class BootstrapResolver implements MockConnectorAccessResolver {
  latest: SyncRuntimeBootstrap;
  constructor(
    private readonly host: BootstrapPort,
    private readonly pinned: SyncRuntimeBootstrap,
    private readonly clock: PersistentMockClock,
  ) {
    this.latest = pinned;
  }
  async resolve(
    actor: Parameters<MockConnectorAccessResolver["resolve"]>[0],
    storeId: string,
    call: ReadOptions,
  ): Promise<unknown | null> {
    const record = await current(this.host, call);
    if (
      !record ||
      record.state !== "READY" ||
      !record.runtimeOpening ||
      record.grantId !== this.pinned.grantId ||
      record.principalUserId !== this.pinned.principalUserId ||
      record.merchantId !== this.pinned.merchantId ||
      actor.userId !== record.principalUserId ||
      actor.merchantId !== record.merchantId ||
      storeId !== record.scope.storeId
    )
      return null;
    this.clock.refresh({
      now: record.businessNow,
      revision: record.clockRevision,
      generation: record.scope.generation,
    });
    this.latest = record;
    return accessRecord(record);
  }
}
function accessRecord(record: SyncRuntimeBootstrap) {
  return {
    sessionId: record.scope.sessionId,
    generation: record.scope.generation,
    config: record.config,
    context: {
      ...identity(record),
      organizationId: record.scope.organizationId,
      workspaceId: record.scope.workspaceId,
      role: "VIEWER",
      permissions: [...TENANT_ROLE_PERMISSIONS.VIEWER],
    },
    environmentMarker: "demo",
    demoTenant: true,
  };
}
function compose(
  host: BootstrapPort,
  sources: SourceReadPorts,
  record: SyncRuntimeBootstrap,
  failureRules?: MockFailureRuleLoader,
) {
  const clock = new PersistentMockClock();
  const resolver = new BootstrapResolver(host, record, clock);
  const binder = {
    bind: (
      actor: Parameters<SourceReadPorts["bind"]>[0],
      scope: Parameters<SourceReadPorts["bind"]>[1],
    ) => new CommerceReadPort(sources.bind(actor, scope)),
  };
  const factory = new MockConnectorFactory(
    { appEnv: "demo", enableDemoMode: true },
    resolver,
    clock,
    binder,
    failureRules,
  );
  return { factory, resolver };
}

export class SyncCommerce {
  constructor(
    private readonly host: BootstrapPort,
    private readonly sources: SourceReadPorts,
    private readonly failureRules?: MockFailureRuleLoader,
  ) {}
  async open(input: unknown): Promise<ConnectorResult<OpenedSyncCommerce | null>> {
    try {
      const call = options(input),
        record = await current(this.host, call);
      if (!record || record.state !== "READY" || !record.runtimeOpening)
        return { ok: true, data: null };
      const { factory, resolver } = compose(this.host, this.sources, record, this.failureRules);
      const result = await factory.open(identity(record), record.scope.storeId, call);
      check(call);
      return result.ok
        ? { ok: true, data: Object.freeze({ bootstrap: resolver.latest, connector: result.data }) }
        : result;
    } catch (error) {
      return {
        ok: false,
        error: {
          code: commerceFailure(error).code,
          retryAfterMs: null,
        },
      };
    }
  }
}

import { randomUUID } from "node:crypto";
import { ServiceUnavailableException } from "@nestjs/common";
import {
  EventTransactionLifetime,
  runtimeUnavailable,
  type RuntimeTransactionClient,
} from "./event-transaction-lifetime.js";
import {
  checkRuntimeAuthority,
  initializeRuntime,
  runtimeAuthoritySchema,
  runtimeLive,
  type RuntimeAuthority,
} from "./event-runtime-authority.js";
import type { SecurityClock } from "@shopmate/contracts";
import type { BoundNotificationTransaction } from "../notifications/notification-enqueue.repository.js";

export interface RuntimeConnection extends RuntimeTransactionClient {
  release(discard?: boolean): void;
  on(event: "error", listener: () => void): unknown;
  off(event: "error", listener: () => void): unknown;
}
interface RuntimePool {
  connect(): Promise<RuntimeConnection>;
}
export class EventCommitIndeterminate extends ServiceUnavailableException {
  readonly code = "COMMIT_INDETERMINATE";
  constructor() {
    super("Event runtime commit status unavailable");
  }
}
export interface EventRuntimeTransaction {
  readonly client: RuntimeTransactionClient;
  readonly handle: BoundNotificationTransaction;
  readonly authority: RuntimeAuthority;
  readonly reauthorize: () => Promise<void>;
}
interface Operation {
  readonly raw: RuntimeConnection;
  readonly lifetime: EventTransactionLifetime;
  readonly input: RuntimeAuthority;
  discard: boolean;
  committing: boolean;
}

/** One physical client owns every repository and effect through the final statement snapshot. */
export class EventDecisionTransactionOwner {
  constructor(
    private readonly pool: RuntimePool,
    private readonly clock: SecurityClock,
  ) {}
  async run<T>(
    request: RuntimeAuthority,
    work: (scope: EventRuntimeTransaction) => Promise<T>,
  ): Promise<T> {
    const input = runtimeAuthoritySchema.parse(request);
    const raw = await this.pool.connect();
    const lifetime = new EventTransactionLifetime(raw, () => runtimeLive(input, this.clock));
    const op: Operation = { raw, lifetime, input, discard: false, committing: false };
    const onError = () => {
      op.discard = true;
      lifetime.close();
    };
    raw.on("error", onError);
    try {
      return await this.execute(op, work);
    } catch (error) {
      await this.abort(op);
      if (op.committing) throw new EventCommitIndeterminate();
      throw error;
    } finally {
      lifetime.close();
      raw.off("error", onError);
      raw.release(op.discard);
    }
  }
  private scope(op: Operation): EventRuntimeTransaction {
    const { input, lifetime } = op;
    const { organizationId, workspaceId, storeId } = input.binding;
    return {
      client: lifetime.client,
      authority: input,
      reauthorize: () => checkRuntimeAuthority(lifetime.client, input, this.clock),
      handle: {
        kind: "TENANT",
        client: lifetime.client,
        scope: { organizationId, workspaceId, storeId },
        actor: { actorId: input.actor.userId, actorKind: "USER", identitySource: "SERVER" },
        isActive: lifetime.isActive,
        binding: input.binding,
        get connectionGeneration() {
          return input.generation ?? 0;
        },
        auditRequestId: randomUUID(),
      },
    };
  }
  private async execute<T>(
    op: Operation,
    work: (scope: EventRuntimeTransaction) => Promise<T>,
  ): Promise<T> {
    const client = op.lifetime.client;
    await initializeRuntime(client, op.input);
    const scope = this.scope(op);
    await scope.reauthorize();
    if (op.input.writable)
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        JSON.stringify(["event-runtime-routing-v1", op.input.binding]),
      ]);
    await scope.reauthorize();
    const result = await work(scope);
    return this.finish(op, result);
  }
  private async finish<T>(op: Operation, result: T): Promise<T> {
    op.lifetime.close();
    await op.lifetime.drain();
    if (op.discard) throw runtimeUnavailable();
    if (result !== null && typeof result === "object" && "ok" in result && result.ok === false) {
      if (op.input.writable) throw runtimeUnavailable();
      await op.raw.query("ROLLBACK");
      return result;
    }
    // This single READ COMMITTED statement is the authority linearization point, not physical COMMIT.
    await checkRuntimeAuthority(op.raw, op.input, this.clock);
    op.committing = true;
    await op.raw.query("COMMIT");
    if (op.discard) throw new EventCommitIndeterminate();
    op.committing = false;
    return result;
  }
  private async abort(op: Operation): Promise<void> {
    op.lifetime.close();
    try {
      await op.lifetime.drain();
    } catch {
      op.discard = true;
    }
    if (op.committing) {
      op.discard = true;
      return;
    }
    try {
      await op.raw.query("ROLLBACK");
    } catch {
      op.discard = true;
    }
  }
}

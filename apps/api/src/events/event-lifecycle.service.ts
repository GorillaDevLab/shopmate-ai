import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  ConnectorBindingSchema,
  EventRecordSchema,
  EventStateTransitionSchema,
  ExternalIdSchema,
  TenantAuditEntrySchema,
  TenantAuditEventSchema,
  TenantContextSchema,
  TenantIdSchema,
  sameEventBinding,
  type AuditAppendPort,
  type ConnectorBinding,
  type EventQueryPort,
  type EventRecord,
  type EventRepository,
  type EventStateTransition,
  type TenantAuditEvent,
  type TenantContext,
} from "@shopmate/contracts";
import { z } from "zod";
import type { AuthContext } from "../auth/contracts/index.js";
import type { TenantScopeService } from "../tenant/tenant-scope.service.js";

export const EVENT_LIFECYCLE_SERVICE = Symbol("EVENT_LIFECYCLE_SERVICE");
export type EventMutationPort = Pick<EventRepository, "stateTransition">;
export type SameTxAuditAppendPort<Tx> = Pick<AuditAppendPort<Tx, never>, "appendTenant">;
export type LifecycleOperation = "acknowledge" | "resolve" | "suppress";
export interface LifecycleSelection {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly storeId: string;
}
export interface LifecycleScope<Tx> {
  readonly transaction: Tx;
  readonly actor: TenantContext;
  readonly binding: ConnectorBinding;
  readonly events: EventMutationPort;
  readonly query: Pick<EventQueryPort, "detail">;
}
/**
 * Resolve current membership, role and store/connection ownership INSIDE the write unit.
 * Bind query/mutation closures to transaction; never use an independently committing repository.
 * Commit only after callback success; any thrown error must roll back state and audit together.
 * This component contract does not implement the later production database adapter.
 */
export interface EventLifecycleUnitOfWork<Tx> {
  run<T>(
    identity: AuthContext,
    selection: LifecycleSelection,
    work: (scope: LifecycleScope<Tx>) => Promise<T>,
  ): Promise<T>;
}
export interface LifecycleHttpRequest {
  readonly auth?: AuthContext;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly rawHeaders: readonly string[];
  readonly params: Record<string, unknown>;
  readonly query?: unknown;
  readonly body?: unknown;
}
const revision = z.number().int().positive().safe();
const bodies = {
  acknowledge: z.strictObject({
    expectedRevision: revision,
    reason: z.literal("ACKNOWLEDGED_BY_OPERATOR"),
  }),
  resolve: z.strictObject({
    expectedRevision: revision,
    reason: z.enum(["CONDITION_CLEARED", "MANUALLY_RESOLVED"]),
  }),
  suppress: z.strictObject({
    expectedRevision: revision,
    reason: z.enum(["FALSE_POSITIVE", "DUPLICATE", "MAINTENANCE"]),
  }),
};
const targets = {
  acknowledge: "ACKNOWLEDGED",
  resolve: "RESOLVED",
  suppress: "SUPPRESSED",
} as const;
const pathSchema = z.strictObject({
  workspaceId: TenantIdSchema.optional(),
  storeId: TenantIdSchema,
  eventId: ExternalIdSchema,
});
const actorSchema = TenantContextSchema.extend({
  permissions: TenantContextSchema.shape.permissions.readonly(),
});
const recordResult = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: EventRecordSchema }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum([
        "INVALID_INPUT",
        "SCOPE_MISMATCH",
        "VERSION_MISMATCH",
        "WINDOW_MISMATCH",
        "FORBIDDEN",
        "NOT_FOUND",
        "CONFLICT",
        "SOURCE_UNAVAILABLE",
        "OVERFLOW",
      ]),
      evidenceIds: z.array(ExternalIdSchema).readonly(),
    }),
  }),
]);
type Body = z.infer<(typeof bodies)[LifecycleOperation]>;
type Path = z.infer<typeof pathSchema>;
interface ValidRequest {
  readonly path: Path;
  readonly body: Body;
  readonly workspaceId?: string;
}
interface WriteRequest {
  readonly identity: AuthContext;
  readonly selection: LifecycleSelection;
  readonly eventId: string;
  readonly operation: LifecycleOperation;
  readonly body: Body;
}

export class EventLifecycleService<Tx> {
  constructor(
    private readonly tenants: TenantScopeService,
    private readonly uow: EventLifecycleUnitOfWork<Tx>,
    private readonly audit: SameTxAuditAppendPort<Tx>,
    private readonly now = () => new Date().toISOString(),
    private readonly correlation: () => { requestId: string; occurrenceId: string } = () => ({
      requestId: randomUUID(),
      occurrenceId: randomUUID(),
    }),
  ) {}
  async execute(
    operation: LifecycleOperation,
    request: LifecycleHttpRequest,
  ): Promise<EventRecord> {
    if (!request.auth) throw new UnauthorizedException();
    const input = validateRequest(operation, request);
    const actor = await this.tenants.resolve(request.auth, input.workspaceId);
    requireRole(actor);
    const selection = {
      organizationId: actor.organizationId,
      workspaceId: actor.workspaceId,
      storeId: input.path.storeId,
    };
    const write = {
      identity: request.auth,
      selection,
      eventId: input.path.eventId,
      operation,
      body: input.body,
    };
    return this.uow.run(request.auth, selection, (scope) => this.change(scope, write));
  }
  private async change(scope: LifecycleScope<Tx>, input: WriteRequest): Promise<EventRecord> {
    const { actor, binding } = validateScope(scope, input);
    const current = readRecord(
      await scope.query.detail({ actor, binding, eventId: input.eventId }),
    );
    if (current.id !== input.eventId || !sameEventBinding(current.binding, binding))
      throw new NotFoundException();
    if (
      current.revision !== input.body.expectedRevision ||
      current.revision === Number.MAX_SAFE_INTEGER
    )
      throw new ConflictException();
    const transition = EventStateTransitionSchema.safeParse({
      actor,
      binding,
      eventId: current.id,
      expectedRevision: input.body.expectedRevision,
      fromState: current.state,
      toState: targets[input.operation],
      reason: input.body.reason,
      changedAt: this.now(),
    });
    if (!transition.success) throw new ConflictException();
    const changed = readRecord(await scope.events.stateTransition(transition.data));
    if (
      !sameRecord(changed, {
        ...current,
        state: transition.data.toState,
        revision: current.revision + 1,
      })
    )
      throw new ServiceUnavailableException();
    const event = createAudit(transition.data, changed, this.correlation());
    const appended = await this.audit.appendTenant(scope.transaction, event);
    verifyAudit(appended, event);
    return changed;
  }
}
function validateRequest(
  operation: LifecycleOperation,
  request: LifecycleHttpRequest,
): ValidRequest {
  if (!Object.hasOwn(bodies, operation)) throw new BadRequestException();
  const path = pathSchema.safeParse(request.params);
  const body = bodies[operation].safeParse(request.body);
  if (!path.success || !body.success || !z.strictObject({}).safeParse(request.query ?? {}).success)
    throw new BadRequestException();
  const count = request.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === "x-workspace-id",
  ).length;
  const header = request.headers["x-workspace-id"];
  if (count > 1 || (header !== undefined && !TenantIdSchema.safeParse(header).success))
    throw new BadRequestException();
  if (
    header !== undefined &&
    path.data.workspaceId !== undefined &&
    header !== path.data.workspaceId
  )
    throw new BadRequestException();
  const workspaceId = path.data.workspaceId ?? (typeof header === "string" ? header : undefined);
  return { path: path.data, body: body.data, workspaceId };
}
function requireRole(actor: TenantContext): void {
  if (!["OWNER", "ADMIN", "OPERATOR"].includes(actor.role)) throw new ForbiddenException();
}
function validateScope<Tx>(scope: LifecycleScope<Tx>, input: WriteRequest) {
  const actor = actorSchema.safeParse(scope.actor);
  const binding = ConnectorBindingSchema.safeParse(scope.binding);
  if (!actor.success || !binding.success) throw new ServiceUnavailableException();
  requireRole(actor.data);
  if (
    actor.data.userId !== input.identity.userId ||
    actor.data.merchantId !== input.identity.merchantId ||
    actor.data.organizationId !== input.selection.organizationId ||
    actor.data.workspaceId !== input.selection.workspaceId ||
    binding.data.organizationId !== actor.data.organizationId ||
    binding.data.workspaceId !== actor.data.workspaceId ||
    binding.data.storeId !== input.selection.storeId
  )
    throw new NotFoundException();
  return { actor: actor.data, binding: binding.data };
}
function readRecord(value: unknown): EventRecord {
  const result = recordResult.safeParse(value);
  if (!result.success) throw new ServiceUnavailableException();
  if (result.data.ok) return result.data.value;
  switch (result.data.error.code) {
    case "CONFLICT":
    case "VERSION_MISMATCH":
      throw new ConflictException();
    case "FORBIDDEN":
      throw new ForbiddenException();
    case "NOT_FOUND":
    case "SCOPE_MISMATCH":
      throw new NotFoundException();
    default:
      throw new ServiceUnavailableException();
  }
}
function sameRecord(left: EventRecord, right: EventRecord): boolean {
  return (
    JSON.stringify(EventRecordSchema.parse(left)) === JSON.stringify(EventRecordSchema.parse(right))
  );
}
const unusedAuditLinks = {
  runId: null,
  evidenceId: null,
  actionId: null,
  revisionId: null,
  approvalId: null,
  executionId: null,
};
function createAudit(
  transition: EventStateTransition,
  changed: EventRecord,
  correlation: { requestId: string; occurrenceId: string },
): TenantAuditEvent {
  const binding = transition.binding;
  return TenantAuditEventSchema.parse({
    scopeKind: "TENANT",
    scope: {
      organizationId: binding.organizationId,
      workspaceId: binding.workspaceId,
      storeId: binding.storeId,
    },
    actor: { actorId: transition.actor.userId, actorKind: "USER", identitySource: "SERVER" },
    resource: { type: "EVENT", id: transition.eventId },
    result: "SUCCESS",
    occurredAt: transition.changedAt,
    sourceOccurredAt: null,
    links: {
      requestId: correlation.requestId,
      occurrenceId: correlation.occurrenceId,
      ...unusedAuditLinks,
    },
    event: {
      eventType: "EVENT_STATE_CHANGE",
      redactedMetadata: {
        fromState: transition.fromState,
        toState: transition.toState,
        reason: transition.reason,
        expectedRevision: transition.expectedRevision,
        revision: changed.revision,
        evidenceReference: changed.currentEvidence,
      },
    },
  });
}
function verifyAudit(value: unknown, event: TenantAuditEvent): void {
  const entry = TenantAuditEntrySchema.safeParse(value);
  if (!entry.success) throw new ServiceUnavailableException();
  const projected = Object.fromEntries(
    Object.entries(entry.data).filter(([key]) => Object.hasOwn(event, key)),
  );
  const parsed = TenantAuditEventSchema.safeParse(projected);
  if (!parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(event))
    throw new ServiceUnavailableException();
}

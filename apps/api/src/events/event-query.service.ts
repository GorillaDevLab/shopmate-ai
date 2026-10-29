import { isDeepStrictEqual } from "node:util";
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  ConnectorBindingSchema,
  DecisionRunSchema,
  CursorSchema,
  createEventFingerprint,
  EventDetailQuerySchema,
  EventHistoryQuerySchema,
  EventEvidenceQuerySchema,
  EventEvidenceRecordSchema,
  ExternalIdSchema,
  EventListQuerySchema,
  EventRecordSchema,
  EventStateSchema,
  EventTypeSchema,
  TenantContextSchema,
  TenantIdSchema,
  SourceVersionSchema,
  type ConnectorBinding,
  type EventQueryPort,
  type EventListQuery,
  type EventDetailQuery,
  type EventEvidenceReference,
  type EventRecord,
  type DecisionRun,
  type DecisionPortResult,
  type TenantContext,
} from "@shopmate/contracts";
import { z } from "zod";
import type { AuthContext } from "../auth/contracts/index.js";
import { TenantScopeService, tenantNotFound } from "../tenant/tenant-scope.service.js";

export const EVENT_QUERY_PORT = Symbol("EVENT_QUERY_PORT");
export const EVENT_DECISION_SUMMARY_READER = Symbol("EVENT_DECISION_SUMMARY_READER");
export const EVENT_STORE_OWNERSHIP_RESOLVER = Symbol("EVENT_STORE_OWNERSHIP_RESOLVER");
export interface EventStoreOwnershipResolver {
  resolve(actor: TenantContext, storeId: string): Promise<ConnectorBinding | null>;
}
/** Local read-model seam only; the append-only runtime repository is supplied at P04-027/029. */
export interface EventDecisionSummaryQuery extends EventDetailQuery {
  readonly decisionId: string | null;
}
export interface EventDecisionSummaryReader {
  readonly read: (
    query: EventDecisionSummaryQuery,
  ) => Promise<DecisionPortResult<readonly DecisionRun[]>>;
}
export interface EventHttpRequest {
  readonly auth?: AuthContext;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly rawHeaders: readonly string[];
  readonly params: Readonly<Record<string, unknown>>;
  readonly query?: unknown;
  readonly body?: unknown;
}

const paginationFilters = {
  cursor: CursorSchema.optional(),
  limit: z
    .string()
    .regex(/^(?:[1-9][0-9]?|100)$/u)
    .transform(Number)
    .default(20),
};
const listFiltersSchema = z.strictObject({
  ...paginationFilters,
  type: EventTypeSchema.optional(),
  state: EventStateSchema.optional(),
});
const pathSchema = z.strictObject({
  storeId: TenantIdSchema,
  workspaceId: TenantIdSchema.optional(),
  eventId: ExternalIdSchema.optional(),
  evidenceId: ExternalIdSchema.optional(),
  decisionId: ExternalIdSchema.optional(),
});
const historyFiltersSchema = z.strictObject(paginationFilters);
const evidenceFiltersSchema = z.strictObject({
  version: SourceVersionSchema,
  hash: ExternalIdSchema,
  definitionVersion: SourceVersionSchema,
  baselineVersion: SourceVersionSchema.optional(),
});
const emptyFiltersSchema = z.strictObject({});
const pageSchema = z.strictObject({
  items: z.array(EventRecordSchema),
  nextCursor: CursorSchema.nullable(),
});
const historyPageSchema = z.strictObject({
  items: z.array(EventEvidenceRecordSchema),
  nextCursor: CursorSchema.nullable(),
});
const decisionEnvelopeSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: z.array(DecisionRunSchema).max(1000) }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum([
      "INVALID_INPUT",
      "FORBIDDEN",
      "SCOPE_MISMATCH",
      "VERSION_MISMATCH",
      "HASH_MISMATCH",
      "CONFLICT",
      "UNAVAILABLE",
    ]),
  }),
]);
const envelopeSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: z.unknown() }),
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
      evidenceIds: z.array(z.string()),
    }),
  }),
]);
function invalid() {
  return new BadRequestException({ statusCode: 400, code: "INVALID_EVENT_QUERY" });
}
function forbidden() {
  return new ForbiddenException({ statusCode: 403, code: "EVENTS_FORBIDDEN" });
}
function unavailable() {
  return new ServiceUnavailableException({
    statusCode: 503,
    status: "UNAVAILABLE",
    code: "EVENTS_UNAVAILABLE",
  });
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid();
  return result.data;
}
function output<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw unavailable();
  return result.data;
}
async function invoke(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    return await operation();
  } catch {
    throw unavailable();
  }
}
function unwrap(value: unknown): unknown {
  const result = output(envelopeSchema, value);
  if (result.ok) return result.value;
  switch (result.error.code) {
    case "INVALID_INPUT":
      throw invalid();
    case "FORBIDDEN":
      throw forbidden();
    case "NOT_FOUND":
    case "SCOPE_MISMATCH":
      return tenantNotFound();
    default:
      throw unavailable();
  }
}
function unwrapDecisions(value: unknown): readonly DecisionRun[] {
  const result = output(decisionEnvelopeSchema, value);
  if (result.ok) return result.value;
  switch (result.code) {
    case "INVALID_INPUT":
      throw invalid();
    case "FORBIDDEN":
      throw forbidden();
    case "SCOPE_MISMATCH":
      return tenantNotFound();
    default:
      throw unavailable();
  }
}
function workspaceSelection(request: EventHttpRequest): string | undefined {
  const count = request.rawHeaders.filter(
    (header, index) => index % 2 === 0 && header.toLowerCase() === "x-workspace-id",
  ).length;
  const header = request.headers["x-workspace-id"];
  const path = request.params.workspaceId;
  if (count > 1) throw invalid();
  for (const value of [header, path]) {
    if (value !== undefined) parse(TenantIdSchema, value);
  }
  if (header !== undefined && path !== undefined && header !== path) throw invalid();
  return (path ?? header) as string | undefined;
}
function validateRequest(request: EventHttpRequest) {
  if (!request.auth) throw new UnauthorizedException();
  const params = parse(pathSchema, request.params);
  if (request.body !== undefined && request.body !== null && !isDeepStrictEqual(request.body, {}))
    throw invalid();
  return { params, workspaceId: workspaceSelection(request) };
}
function hasReadPermission(actor: TenantContext): boolean {
  // Source evidence can include every normalized commerce domain.
  return (["tenant:read", "products:read", "orders:read", "inventory:read"] as const).every(
    (permission) => actor.permissions.includes(permission),
  );
}
function validPage<T>(
  page: { items: readonly T[]; nextCursor: string | null },
  query: { limit: number; cursor: string | null },
  id: (item: T) => string,
): boolean {
  return (
    page.items.length <= query.limit &&
    new Set(page.items.map(id)).size === page.items.length &&
    (page.nextCursor === null || (page.items.length > 0 && page.nextCursor !== query.cursor))
  );
}
function matchesEvidence(reference: EventEvidenceReference, event: EventRecord): boolean {
  return (
    isDeepStrictEqual(reference.binding, event.binding) &&
    isDeepStrictEqual(reference.entity, event.entity) &&
    reference.eventType === event.eventType &&
    createEventFingerprint(reference) === event.fingerprint
  );
}

@Injectable()
export class EventQueryService {
  constructor(
    @Inject(TenantScopeService) private readonly tenants: TenantScopeService,
    @Inject(EVENT_QUERY_PORT) private readonly events: EventQueryPort,
    @Inject(EVENT_STORE_OWNERSHIP_RESOLVER) private readonly ownership: EventStoreOwnershipResolver,
    @Inject(EVENT_DECISION_SUMMARY_READER) private readonly summaries: EventDecisionSummaryReader,
  ) {}

  async list(request: EventHttpRequest) {
    validateRequest(request);
    const filters = parse(listFiltersSchema, request.query ?? {});
    const scope = await this.authorize(request);
    const query = parse(EventListQuerySchema, {
      ...scope,
      eventTypes: filters.type ? [filters.type] : [],
      states: filters.state ? [filters.state] : [],
      entity: null,
      cursor: filters.cursor ?? null,
      limit: filters.limit,
    });
    const value = await invoke(() => this.events.list(structuredClone(query)));
    const page = output(pageSchema, unwrap(value));
    if (
      !validPage(page, query, (event) => event.id) ||
      !page.items.every((event) => this.matches(event, query))
    )
      throw unavailable();
    return { status: page.items.length ? "AVAILABLE" : "EMPTY", ...page };
  }

  async detail(request: EventHttpRequest) {
    validateRequest(request);
    parse(emptyFiltersSchema, request.query ?? {});
    const { event } = await this.authorizedEvent(request);
    return { status: "AVAILABLE", event };
  }

  async history(request: EventHttpRequest) {
    validateRequest(request);
    const filters = parse(historyFiltersSchema, request.query ?? {});
    const { event, query: scope } = await this.authorizedEvent(request);
    const query = parse(EventHistoryQuerySchema, {
      ...scope,
      cursor: filters.cursor ?? null,
      limit: filters.limit,
    });
    const value = await invoke(() => this.events.history(structuredClone(query)));
    const page = output(historyPageSchema, unwrap(value));
    if (
      !validPage(page, query, (item) =>
        JSON.stringify([item.reference.id, item.reference.version]),
      ) ||
      !page.items.every((item) => matchesEvidence(item.reference, event))
    )
      throw unavailable();
    return { status: page.items.length ? "AVAILABLE" : "EMPTY", ...page };
  }

  /** History supplies immutable metadata; the port deliberately does not offer an ID-only lookup. */
  async evidence(request: EventHttpRequest) {
    validateRequest(request);
    const filters = parse(evidenceFiltersSchema, request.query ?? {});
    const evidenceId = parse(ExternalIdSchema, request.params.evidenceId);
    const { event, query } = await this.authorizedEvent(request);
    const reference: EventEvidenceReference = {
      schemaVersion: 1,
      id: evidenceId,
      ...filters,
      baselineVersion: filters.baselineVersion ?? null,
      binding: query.binding,
      eventType: event.eventType,
      entity: event.entity,
    };
    if (!matchesEvidence(reference, event)) throw invalid();
    return { status: "AVAILABLE", ...(await this.readEvidence(query, reference)) };
  }

  async decisions(request: EventHttpRequest) {
    const items = await this.readDecisions(request, null);
    return { status: items.length ? "AVAILABLE" : "EMPTY", items };
  }

  async decision(request: EventHttpRequest) {
    validateRequest(request);
    const decisionId = parse(ExternalIdSchema, request.params.decisionId);
    const items = await this.readDecisions(request, decisionId);
    if (!items.length) return tenantNotFound();
    return { status: "AVAILABLE", decision: items[0] };
  }

  private async readDecisions(request: EventHttpRequest, decisionId: string | null) {
    validateRequest(request);
    parse(emptyFiltersSchema, request.query ?? {});
    const { event, query } = await this.authorizedEvent(request);
    const value = await invoke(() =>
      this.summaries.read(structuredClone({ ...query, decisionId })),
    );
    const items = unwrapDecisions(value);
    if (
      new Set(items.map((item) => item.id)).size !== items.length ||
      (decisionId !== null && items.length > 1)
    )
      throw unavailable();
    for (const item of items) {
      if (
        item.eventId !== event.id ||
        !matchesEvidence(item.evidence, event) ||
        (decisionId !== null && item.id !== decisionId)
      )
        throw unavailable();
      // Resolve the run's own immutable evidence, including older versions, before exposure.
      await this.readEvidence(query, item.evidence);
    }
    return items;
  }

  private async authorizedEvent(request: EventHttpRequest) {
    const eventId = parse(ExternalIdSchema, request.params.eventId);
    const scope = await this.authorize(request);
    const query = parse(EventDetailQuerySchema, { ...scope, eventId });
    const value = await invoke(() => this.events.detail(structuredClone(query)));
    const event = output(EventRecordSchema, unwrap(value));
    if (event.id !== eventId || !isDeepStrictEqual(event.binding, query.binding))
      throw unavailable();
    return { event, query };
  }

  private async readEvidence(query: EventDetailQuery, reference: EventEvidenceReference) {
    const request = parse(EventEvidenceQuerySchema, { ...query, reference });
    const value = await invoke(() => this.events.evidence(structuredClone(request)));
    const record = output(EventEvidenceRecordSchema, unwrap(value));
    if (!isDeepStrictEqual(record.reference, reference)) throw unavailable();
    return record;
  }

  private matches(event: z.infer<typeof EventRecordSchema>, query: EventListQuery): boolean {
    return (
      isDeepStrictEqual(event.binding, query.binding) &&
      (!query.eventTypes.length || query.eventTypes.includes(event.eventType)) &&
      (!query.states.length || query.states.includes(event.state))
    );
  }

  private async authorize(request: EventHttpRequest) {
    const { params, workspaceId } = validateRequest(request);
    if (!request.auth) throw new UnauthorizedException();
    const actor = output(
      TenantContextSchema,
      await this.tenants.resolve(request.auth, workspaceId),
    );
    if (
      actor.userId !== request.auth.userId ||
      actor.merchantId !== request.auth.merchantId ||
      (workspaceId !== undefined && actor.workspaceId !== workspaceId)
    )
      throw unavailable();
    if (!hasReadPermission(actor)) throw forbidden();
    const value = await invoke(() =>
      this.ownership.resolve(structuredClone(actor), params.storeId),
    );
    if (value === null) return tenantNotFound();
    const binding = output(ConnectorBindingSchema, value);
    if (
      binding.organizationId !== actor.organizationId ||
      binding.workspaceId !== actor.workspaceId ||
      binding.storeId !== params.storeId
    )
      return tenantNotFound();
    return { actor, binding };
  }
}

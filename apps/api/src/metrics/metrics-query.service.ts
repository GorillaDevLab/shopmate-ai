import { createHash, createHmac, timingSafeEqual } from "node:crypto";
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
  MetricSnapshotV1Schema,
  MetricSubjectSchema,
  MetricTimestampSchema,
  MetricValueSchema,
  MetricWindowSchema,
  SourceVersionSchema,
  TenantContextSchema,
  TenantIdSchema,
  type AuthorizedMetricRead,
  type ConnectorBinding,
  type MetricErrorCode,
  type MetricReadPort,
  type MetricResult,
  type MetricSnapshotQuery,
  type MetricSnapshotV1,
  type TenantContext,
} from "@shopmate/contracts";
import type { MetricHistoryPage, MetricSnapshotStore } from "@shopmate/database";
import { z } from "zod";
import type { AuthContext } from "../auth/contracts/index.js";
import { TenantScopeService, tenantNotFound } from "../tenant/tenant-scope.service.js";

export const METRIC_READ_PORT = Symbol("METRIC_READ_PORT");
export const METRIC_HISTORY_READ_PORT = Symbol("METRIC_HISTORY_READ_PORT");
export const METRIC_STORE_OWNERSHIP_RESOLVER = Symbol("METRIC_STORE_OWNERSHIP_RESOLVER");
export const METRIC_STORE_FACTORY = Symbol("METRIC_STORE_FACTORY");
export const METRIC_CURSOR_SECRET = Symbol("METRIC_CURSOR_SECRET");
export interface MetricStoreOwnershipResolver {
  /** Resolve current store/connection ownership server-side, never from request binding fields. */
  resolve(actor: TenantContext, storeId: string): Promise<ConnectorBinding | null>;
}
/** P18 supplies an actor-bound P15 repository; its DB capability independently authorizes reads. */
export type MetricStoreFactory = (
  actor: TenantContext,
) => Pick<MetricSnapshotStore, "read" | "history">;
export interface AuthorizedMetricHistoryRead extends AuthorizedMetricRead {
  readonly limit: number;
  readonly cursor: string | null;
}
export interface AuthorizedMetricHistoryReadPort {
  readonly history: (
    request: AuthorizedMetricHistoryRead,
  ) => Promise<MetricResult<MetricHistoryPage>>;
}
export interface MetricHttpRequest {
  readonly auth?: AuthContext;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly rawHeaders: readonly string[];
  readonly params: { readonly storeId?: unknown; readonly workspaceId?: unknown };
  readonly query?: unknown;
  readonly body?: unknown;
}
const kindSchema = z.union(MetricValueSchema.options.map((option) => option.unwrap().shape.kind));
const preciseTime = MetricTimestampSchema.refine((value) => !/\.\d{4,}Z$/u.test(value));
const querySchema = z
  .strictObject({
    binding: ConnectorBindingSchema,
    window: MetricWindowSchema,
    kinds: z
      .array(kindSchema)
      .min(1)
      .max(100)
      .refine((kinds) => new Set(kinds).size === kinds.length),
    subject: MetricSubjectSchema,
    definitionVersion: SourceVersionSchema,
    inputRevision: SourceVersionSchema.nullable(),
    visibleAt: preciseTime,
  })
  .refine(({ window }) =>
    [window.periodStart, window.periodEnd].every((time) => preciseTime.safeParse(time).success),
  );
const authorizedSchema = z.strictObject({ actor: TenantContextSchema, query: querySchema });
const historyRequestSchema = authorizedSchema.extend({
  limit: z.number().int().min(1).max(100),
  cursor: z.string().min(1).max(65536).nullable(),
});
const filterFields = {
  metricKey: kindSchema,
  definitionVersion: SourceVersionSchema,
  periodStart: preciseTime,
  periodEnd: preciseTime,
  timezone: z.literal("Asia/Shanghai"),
  currency: z.literal("CNY"),
  visibleAt: preciseTime,
  inputRevision: SourceVersionSchema.optional(),
  subjectKind: z.enum(["STORE", "SKU", "CAMPAIGN"]).default("STORE"),
  externalSkuId: SourceVersionSchema.optional(),
  externalCampaignId: SourceVersionSchema.optional(),
};
const filtersSchema = z.strictObject(filterFields);
const historyFiltersSchema = filtersSchema.extend({
  limit: z
    .string()
    .regex(/^(?:[1-9][0-9]?|100)$/u)
    .transform(Number)
    .pipe(z.number().int().min(1).max(100))
    .default(20),
  cursor: z.string().min(1).max(65536).optional(),
});
const envelopeSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: z.unknown() }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum([
        "INVALID_INPUT",
        "OVERFLOW",
        "SCOPE_MISMATCH",
        "VERSION_MISMATCH",
        "WINDOW_MISMATCH",
        "FORBIDDEN",
        "NOT_FOUND",
        "CONFLICT",
        "SOURCE_UNAVAILABLE",
      ]),
      evidenceIds: z.array(z.string()).readonly(),
    }),
  }),
]);
const storedSchema = z.strictObject({
  id: z.uuid(),
  inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  snapshot: MetricSnapshotV1Schema,
});
const pageSchema = z.strictObject({
  items: z.array(storedSchema),
  nextCursor: z.string().min(1).max(32768).nullable(),
});
const cursorSchema = z.strictObject({
  version: z.literal(1),
  scope: z.string().regex(/^[a-f0-9]{64}$/u),
  repositoryCursor: z.string().min(1).max(32768),
});

function failure(code: MetricErrorCode): MetricResult<never> {
  return { ok: false, error: { code, evidenceIds: [] } };
}
function unavailable() {
  return new ServiceUnavailableException({
    statusCode: 503,
    code: "METRICS_UNAVAILABLE",
    message: "指标服务暂时不可用",
  });
}
function invalid() {
  return new BadRequestException({
    statusCode: 400,
    code: "INVALID_METRIC_QUERY",
    message: "指标查询参数无效",
  });
}
function forbidden() {
  return new ForbiddenException({
    statusCode: 403,
    code: "METRICS_FORBIDDEN",
    message: "无指标读取权限",
  });
}
function unwrap(value: unknown): unknown {
  const result = envelopeSchema.safeParse(value);
  if (!result.success) throw unavailable();
  if (result.data.ok) return result.data.value;
  switch (result.data.error.code) {
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
function workspaceSelection(request: MetricHttpRequest): string | undefined {
  const count = request.rawHeaders.filter(
    (header, index) => index % 2 === 0 && header.toLowerCase() === "x-workspace-id",
  ).length;
  const header = request.headers["x-workspace-id"];
  const path = request.params.workspaceId;
  if (count > 1) throw invalid();
  for (const candidate of [header, path]) {
    if (candidate !== undefined && !TenantIdSchema.safeParse(candidate).success) throw invalid();
  }
  if (header !== undefined && path !== undefined && header !== path) throw invalid();
  return (path ?? header) as string | undefined;
}
function parseFilters(request: MetricHttpRequest, history: boolean) {
  if (
    request.body !== undefined &&
    request.body !== null &&
    Object.keys(Object(request.body)).length
  )
    throw invalid();
  if (!TenantIdSchema.safeParse(request.params.storeId).success) throw invalid();
  const parsed = (history ? historyFiltersSchema : filtersSchema).safeParse(request.query);
  if (!parsed.success) throw invalid();
  const {
    periodStart,
    periodEnd,
    timezone,
    currency,
    subjectKind,
    externalSkuId,
    externalCampaignId,
  } = parsed.data;
  const window = MetricWindowSchema.safeParse({ periodStart, periodEnd, timezone, currency });
  const subject = MetricSubjectSchema.safeParse(
    subjectKind === "SKU"
      ? { kind: subjectKind, externalSkuId }
      : subjectKind === "CAMPAIGN"
        ? { kind: subjectKind, externalCampaignId }
        : { kind: subjectKind },
  );
  if (
    !window.success ||
    !subject.success ||
    (externalSkuId !== undefined && subjectKind !== "SKU") ||
    (externalCampaignId !== undefined && subjectKind !== "CAMPAIGN")
  )
    throw invalid();
  return { filters: parsed.data, window: window.data, subject: subject.data };
}
function sameTime(left: string, right: string): boolean {
  return Date.parse(left) === Date.parse(right);
}
function matches(snapshot: MetricSnapshotV1, query: MetricSnapshotQuery): boolean {
  return (
    isDeepStrictEqual(snapshot.binding, query.binding) &&
    isDeepStrictEqual(snapshot.subject, query.subject) &&
    snapshot.definitionVersion === query.definitionVersion &&
    query.kinds.includes(snapshot.metric.kind) &&
    (query.inputRevision === null || snapshot.inputRevision === query.inputRevision) &&
    sameTime(snapshot.periodStart, query.window.periodStart) &&
    sameTime(snapshot.periodEnd, query.window.periodEnd) &&
    snapshot.timezone === query.window.timezone &&
    snapshot.currency === query.window.currency &&
    Date.parse(snapshot.visibleAt) <= Date.parse(query.visibleAt) &&
    [
      snapshot.periodStart,
      snapshot.periodEnd,
      snapshot.visibleAt,
      snapshot.computedAt,
      snapshot.sourceWatermark,
    ].every((time) => time === null || preciseTime.safeParse(time).success)
  );
}
function permitted(request: AuthorizedMetricRead): MetricErrorCode | null {
  const { actor, query } = request;
  if (!hasReadPermission(actor)) return "FORBIDDEN";
  return actor.organizationId === query.binding.organizationId &&
    actor.workspaceId === query.binding.workspaceId
    ? null
    : "NOT_FOUND";
}
function hasReadPermission(actor: TenantContext): boolean {
  // Match the computation boundary: aggregate snapshots may combine all normalized source domains.
  return (["tenant:read", "products:read", "orders:read", "inventory:read"] as const).every(
    (permission) => actor.permissions.includes(permission),
  );
}
function scopeHash(request: AuthorizedMetricHistoryRead): string {
  const { userId, merchantId, organizationId, workspaceId } = request.actor;
  return createHash("sha256")
    .update(
      JSON.stringify({
        actor: { userId, merchantId, organizationId, workspaceId },
        query: request.query,
        limit: request.limit,
      }),
    )
    .digest("hex");
}
function decodeCursor(
  cursor: string,
  request: AuthorizedMetricHistoryRead,
  secret: Buffer,
): string | null {
  const pieces = cursor.split(".");
  if (pieces.length !== 2 || !pieces.every((piece) => /^[A-Za-z0-9_-]+$/u.test(piece))) return null;
  const [payload, signature] = pieces as [string, string];
  const actual = Buffer.from(signature, "base64url");
  const expected = createHmac("sha256", secret).update(payload).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const decoded = cursorSchema.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    return decoded.success && decoded.data.scope === scopeHash(request)
      ? decoded.data.repositoryCursor
      : null;
  } catch {
    return null;
  }
}
function encodeCursor(
  repositoryCursor: string,
  request: AuthorizedMetricHistoryRead,
  secret: Buffer,
): string {
  const payload = Buffer.from(
    JSON.stringify({ version: 1, scope: scopeHash(request), repositoryCursor }),
  ).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

/** Additive authorized history capability; MetricReadPort itself remains read-only and unchanged. */
@Injectable()
export class PersistedMetricReadAdapter implements MetricReadPort, AuthorizedMetricHistoryReadPort {
  private readonly secret: Buffer;
  constructor(
    @Inject(METRIC_STORE_FACTORY) private readonly storeFactory: MetricStoreFactory,
    @Inject(METRIC_CURSOR_SECRET) secret: Buffer,
  ) {
    // P18 must load the same stable secret from the environment on every replica/restart.
    if (!Buffer.isBuffer(secret) || secret.length < 32)
      throw new TypeError("Invalid metric cursor secret");
    this.secret = Buffer.from(secret);
  }

  async read(request: AuthorizedMetricRead): Promise<MetricResult<readonly MetricSnapshotV1[]>> {
    const parsed = authorizedSchema.safeParse(request);
    if (!parsed.success) return failure("INVALID_INPUT");
    const denied = permitted(parsed.data);
    if (denied) return failure(denied);
    try {
      const store = this.storeFactory(structuredClone(parsed.data.actor));
      const result = envelopeSchema.safeParse(await store.read(structuredClone(parsed.data.query)));
      if (!result.success) return failure("SOURCE_UNAVAILABLE");
      if (!result.data.ok) return failure(result.data.error.code);
      const snapshots = z.array(MetricSnapshotV1Schema).safeParse(result.data.value);
      if (!snapshots.success || !snapshots.data.every((item) => matches(item, parsed.data.query)))
        return failure("SOURCE_UNAVAILABLE");
      return { ok: true, value: snapshots.data };
    } catch {
      return failure("SOURCE_UNAVAILABLE");
    }
  }

  async history(request: AuthorizedMetricHistoryRead): Promise<MetricResult<MetricHistoryPage>> {
    const parsed = historyRequestSchema.safeParse(request);
    if (!parsed.success) return failure("INVALID_INPUT");
    const denied = permitted(parsed.data);
    if (denied) return failure(denied);
    const cursor =
      parsed.data.cursor === null
        ? null
        : decodeCursor(parsed.data.cursor, parsed.data, this.secret);
    if (parsed.data.cursor !== null && cursor === null) return failure("INVALID_INPUT");
    try {
      const store = this.storeFactory(structuredClone(parsed.data.actor));
      const result = envelopeSchema.safeParse(
        await store.history({
          query: structuredClone(parsed.data.query),
          limit: parsed.data.limit,
          cursor,
        }),
      );
      if (!result.success) return failure("SOURCE_UNAVAILABLE");
      if (!result.data.ok) return failure(result.data.error.code);
      return this.validateHistory(result.data.value, parsed.data);
    } catch {
      return failure("SOURCE_UNAVAILABLE");
    }
  }

  private validateHistory(
    value: unknown,
    request: AuthorizedMetricHistoryRead,
  ): MetricResult<MetricHistoryPage> {
    const page = pageSchema.safeParse(value);
    if (
      !page.success ||
      page.data.items.length > request.limit ||
      new Set(page.data.items.map((item) => item.id)).size !== page.data.items.length ||
      !page.data.items.every((item) => matches(item.snapshot, request.query)) ||
      (page.data.nextCursor !== null && page.data.items.length !== request.limit)
    )
      return failure("SOURCE_UNAVAILABLE");
    return {
      ok: true,
      value: {
        items: page.data.items,
        nextCursor:
          page.data.nextCursor === null
            ? null
            : encodeCursor(page.data.nextCursor, request, this.secret),
      },
    };
  }
}

@Injectable()
export class MetricsQueryService {
  constructor(
    @Inject(TenantScopeService) private readonly tenants: TenantScopeService,
    @Inject(METRIC_STORE_OWNERSHIP_RESOLVER)
    private readonly ownership: MetricStoreOwnershipResolver,
    @Inject(METRIC_READ_PORT) private readonly reads: MetricReadPort,
    @Inject(METRIC_HISTORY_READ_PORT) private readonly histories: AuthorizedMetricHistoryReadPort,
  ) {}

  async read(request: MetricHttpRequest) {
    const authorized = await this.authorize(request, false);
    let result: unknown;
    try {
      result = await this.reads.read(
        structuredClone({ actor: authorized.actor, query: authorized.query }),
      );
    } catch {
      throw unavailable();
    }
    const snapshots = z.array(MetricSnapshotV1Schema).safeParse(unwrap(result));
    if (!snapshots.success || !snapshots.data.every((item) => matches(item, authorized.query)))
      throw unavailable();
    return snapshots.data.length
      ? { status: "AVAILABLE", snapshots: snapshots.data }
      : { status: "UNAVAILABLE", snapshots: [], reason: "NO_SNAPSHOT" };
  }

  async history(request: MetricHttpRequest) {
    const authorized = await this.authorize(request, true);
    let result: unknown;
    try {
      result = await this.histories.history(structuredClone(authorized));
    } catch {
      throw unavailable();
    }
    const page = pageSchema
      .extend({ nextCursor: z.string().min(1).max(65536).nullable() })
      .safeParse(unwrap(result));
    if (
      !page.success ||
      page.data.items.length > authorized.limit ||
      !page.data.items.every((item) => matches(item.snapshot, authorized.query))
    )
      throw unavailable();
    return {
      status: page.data.items.length ? "AVAILABLE" : "UNAVAILABLE",
      ...page.data,
      ...(page.data.items.length ? {} : { reason: "NO_SNAPSHOT" }),
    };
  }

  private async authorize(
    request: MetricHttpRequest,
    history: boolean,
  ): Promise<AuthorizedMetricHistoryRead> {
    if (!request.auth) throw new UnauthorizedException();
    const selection = workspaceSelection(request);
    const parsed = parseFilters(request, history);
    const actor = await this.tenants.resolve(request.auth, selection);
    if (!hasReadPermission(actor)) throw forbidden();
    const binding = await this.resolveBinding(actor, request.params.storeId as string);
    const filters = parsed.filters;
    const query: MetricSnapshotQuery = {
      binding,
      window: parsed.window,
      subject: parsed.subject,
      kinds: [filters.metricKey],
      definitionVersion: filters.definitionVersion,
      inputRevision: filters.inputRevision ?? null,
      visibleAt: filters.visibleAt,
    };
    return {
      actor,
      query,
      limit: "limit" in filters ? (filters.limit as number) : 20,
      cursor: "cursor" in filters ? ((filters.cursor as string) ?? null) : null,
    };
  }

  private async resolveBinding(actor: TenantContext, storeId: string): Promise<ConnectorBinding> {
    let value: unknown;
    try {
      value = await this.ownership.resolve(actor, storeId);
    } catch {
      throw unavailable();
    }
    if (value === null) tenantNotFound();
    const binding = ConnectorBindingSchema.safeParse(value);
    if (!binding.success) throw unavailable();
    if (
      binding.data.organizationId !== actor.organizationId ||
      binding.data.workspaceId !== actor.workspaceId ||
      binding.data.storeId !== storeId
    )
      tenantNotFound();
    return binding.data;
  }
}

import {
  ConnectorBindingSchema,
  MetricTimestampSchema,
  MetricWindowSchema,
  TenantContextSchema,
  TenantIdSchema,
  type MetricErrorCode,
  type MetricResult,
} from "@shopmate/contracts";
import type { PoolClient } from "pg";
import { decodeNormalizedMetricSourceBundle, sourceObject } from "./metric-source-bundle.decode.js";
import type {
  MetricSourceBundleRepository,
  MetricSourceBundleRepositoryOptions,
  MetricSourceCaptureRequest,
  MetricSourceReadRequest,
  NormalizedMetricSourceBundle,
} from "./metric-source-bundle.types.js";

function failure<T>(code: MetricErrorCode): MetricResult<T> {
  return { ok: false, error: { code, evidenceIds: [] } };
}
async function rollback(client: PoolClient | undefined, begun: boolean): Promise<boolean> {
  if (!client || !begun) return false;
  try {
    await client.query("ROLLBACK");
    return false;
  } catch {
    return true;
  }
}
async function initialize(
  client: PoolClient,
  options: MetricSourceBundleRepositoryOptions,
): Promise<void> {
  const { actor } = options;
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query("SET LOCAL statement_timeout='10s'");
  await client.query(
    "SELECT set_config('app.user_id',$1,true),set_config('app.merchant_id',$2,true),set_config('app.organization_id',$3,true),set_config('app.workspace_id',$4,true)",
    [actor.userId, actor.merchantId, actor.organizationId, actor.workspaceId],
  );
  const safe = await client.query("SELECT public.metric_source_safe_login() AS safe");
  if (safe.rows[0]?.safe !== true) throw new Error("Unsafe metric source capability");
}
async function transaction<T>(
  options: MetricSourceBundleRepositoryOptions,
  work: (client: PoolClient) => Promise<MetricResult<T>>,
): Promise<MetricResult<T>> {
  let client: PoolClient | undefined;
  let begun = false;
  let discard = false;
  let finishing = false;
  const onError = () => {
    discard = true;
  };
  try {
    client = await options.pool.connect();
    client.on("error", onError);
    begun = true;
    await initialize(client, options);
    const result = await work(client);
    if (discard) throw new Error("Metric source connection unavailable");
    finishing = true;
    await client.query(result.ok ? "COMMIT" : "ROLLBACK");
    begun = false;
    if (discard) throw new Error("Metric source connection unavailable");
    return result;
  } catch {
    discard = finishing || (await rollback(client, begun)) || discard;
    return failure("SOURCE_UNAVAILABLE");
  } finally {
    client?.off("error", onError);
    client?.release(discard);
  }
}
function validRequest(value: unknown, read: boolean): boolean {
  try {
    const row = sourceObject(
      value,
      read
        ? ["binding", "window", "visibleAt", "inputRevision"]
        : ["binding", "window", "visibleAt"],
    );
    return (
      ConnectorBindingSchema.safeParse(row.binding).success &&
      MetricWindowSchema.safeParse(row.window).success &&
      preciseTime(row.visibleAt) &&
      preciseWindow(row.window) &&
      (!read ||
        (typeof row.inputRevision === "string" &&
          /^p2-normalized-v1:[a-f0-9]{64}$/u.test(row.inputRevision)))
    );
  } catch {
    return false;
  }
}
function preciseTime(value: unknown): boolean {
  return (
    typeof value === "string" &&
    MetricTimestampSchema.safeParse(value).success &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(value)
  );
}
function preciseWindow(value: unknown): boolean {
  const parsed = MetricWindowSchema.safeParse(value);
  return (
    parsed.success && preciseTime(parsed.data.periodStart) && preciseTime(parsed.data.periodEnd)
  );
}
function canonicalRequest(
  value: MetricSourceCaptureRequest | MetricSourceReadRequest,
): MetricSourceCaptureRequest | MetricSourceReadRequest {
  const request = structuredClone(value);
  return {
    ...request,
    visibleAt: new Date(request.visibleAt).toISOString(),
    window: {
      ...request.window,
      periodStart: new Date(request.window.periodStart).toISOString(),
      periodEnd: new Date(request.window.periodEnd).toISOString(),
    },
  };
}
function sameRequest(
  bundle: NormalizedMetricSourceBundle,
  request: MetricSourceCaptureRequest,
): boolean {
  return (
    Object.entries(request.binding).every(
      ([key, value]) => Reflect.get(bundle.binding, key) === value,
    ) &&
    Object.entries(request.window).every(
      ([key, value]) => Reflect.get(bundle.window, key) === value,
    ) &&
    Date.parse(bundle.visibleAt) === Date.parse(request.visibleAt)
  );
}
async function access(
  options: MetricSourceBundleRepositoryOptions,
  value: MetricSourceCaptureRequest | MetricSourceReadRequest,
  read: boolean,
): Promise<MetricResult<NormalizedMetricSourceBundle>> {
  if (!validRequest(value, read)) return failure("INVALID_INPUT");
  const request = canonicalRequest(value);
  if (
    request.binding.organizationId !== options.actor.organizationId ||
    request.binding.workspaceId !== options.actor.workspaceId
  )
    return failure("NOT_FOUND");
  return transaction(options, async (client) => {
    const values: unknown[] = [
      JSON.stringify(request.binding),
      JSON.stringify(request.window),
      request.visibleAt,
    ];
    if (read && "inputRevision" in request) values.push(request.inputRevision);
    const sql = read
      ? "SELECT public.metric_source_read($1,$2,$3,$4) AS bundle"
      : "SELECT public.metric_source_capture($1,$2,$3) AS bundle";
    let result = await client.query(sql, values);
    // ON CONFLICT can wait on a winner absent from the statement snapshot. A new
    // READ COMMITTED statement rechecks authority and captures coherent current state.
    if (!read && !result.rows[0]?.bundle) result = await client.query(sql, values);
    if (!result.rows[0]?.bundle) return failure(read ? "NOT_FOUND" : "SOURCE_UNAVAILABLE");
    const bundle = decodeNormalizedMetricSourceBundle(result.rows[0].bundle);
    if (
      !sameRequest(bundle, request) ||
      (read && "inputRevision" in request && bundle.inputRevision !== request.inputRevision)
    )
      return failure("SOURCE_UNAVAILABLE");
    return { ok: true, value: bundle };
  });
}
export function createMetricSourceBundleRepository(
  options: MetricSourceBundleRepositoryOptions,
): MetricSourceBundleRepository {
  const actor = TenantContextSchema.safeParse(options?.actor);
  if (!actor.success || typeof options?.pool?.connect !== "function")
    throw new TypeError("Invalid metric source repository dependencies");
  const bound = { actor: actor.data, pool: options.pool };
  return Object.freeze({
    resolve: (storeId: string) => {
      if (!TenantIdSchema.safeParse(storeId).success)
        return Promise.resolve(failure<MetricSourceCaptureRequest["binding"]>("INVALID_INPUT"));
      return transaction<MetricSourceCaptureRequest["binding"]>(bound, async (client) => {
        const result = await client.query("SELECT public.metric_source_resolve($1) AS binding", [
          storeId,
        ]);
        const parsed = ConnectorBindingSchema.safeParse(result.rows[0]?.binding);
        return parsed.success ? { ok: true, value: parsed.data } : failure("NOT_FOUND");
      });
    },
    capture: (request: MetricSourceCaptureRequest) => access(bound, request, false),
    read: (request: MetricSourceReadRequest) => access(bound, request, true),
  });
}

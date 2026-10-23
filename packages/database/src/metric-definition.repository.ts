import {
  ConnectorBindingSchema,
  TenantContextSchema,
  MetricValueSchema,
  SourceVersionSchema,
  type ConnectorBinding,
  type MetricKind,
  type MetricResult,
  type TenantContext,
} from "@shopmate/contracts";
import type { Pool, PoolClient } from "pg";

export interface RuntimeMetricDefinition {
  readonly kind: MetricKind;
  readonly unit: "minorCNY" | "units" | "basisPoints" | "hours";
  readonly definitionVersion: string;
  readonly definitionHash: string;
}
interface Options {
  readonly pool: Pick<Pool, "connect">;
  readonly actor: TenantContext;
}
function failure(
  code: "INVALID_INPUT" | "SOURCE_UNAVAILABLE" | "VERSION_MISMATCH",
): MetricResult<true> {
  return { ok: false, error: { code, evidenceIds: [] } };
}
async function identity(client: PoolClient, actor: TenantContext, binding: ConnectorBinding) {
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  await client.query("SET LOCAL statement_timeout='10s'");
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query(
    `SELECT set_config('app.user_id',$1,true),set_config('app.merchant_id',$2,true),
    set_config('app.organization_id',$3,true),set_config('app.workspace_id',$4,true),
    set_config('app.store_id',$5,true),set_config('app.connection_id',$6,true),
    set_config('app.external_store_id',$7,true)`,
    [
      actor.userId,
      actor.merchantId,
      binding.organizationId,
      binding.workspaceId,
      binding.storeId,
      binding.connectionId,
      binding.externalStoreId,
    ],
  );
}
async function checkDefinition(
  client: PoolClient,
  binding: ConnectorBinding,
  entry: RuntimeMetricDefinition,
  provision: boolean,
): Promise<boolean> {
  const args = [
    binding.organizationId,
    binding.workspaceId,
    binding.storeId,
    binding.connectionId,
    binding.externalStoreId,
    entry.kind,
    entry.definitionVersion,
  ];
  if (provision)
    await client.query(
      `INSERT INTO public.metric_definitions
    ("organizationId","workspaceId","storeId","connectionId","externalStoreId",key,"definitionVersion",unit,"definitionHash")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [...args, entry.unit, entry.definitionHash],
    );
  // A separate READ COMMITTED statement sees an immutable concurrent provisioning winner.
  const result = await client.query(
    `SELECT unit,"definitionHash" FROM public.metric_definitions
    WHERE "organizationId"=$1 AND "workspaceId"=$2 AND "storeId"=$3 AND "connectionId"=$4
    AND "externalStoreId"=$5 AND key=$6 AND "definitionVersion"=$7`,
    args,
  );
  return (
    result.rowCount === 1 &&
    result.rows[0].unit === entry.unit &&
    result.rows[0].definitionHash === entry.definitionHash
  );
}
async function rollback(client: PoolClient | undefined): Promise<boolean> {
  if (!client) return false;
  try {
    await client.query("ROLLBACK");
    return false;
  } catch {
    return true;
  }
}
function validRequest(
  options: Options,
  binding: ConnectorBinding,
  entries: readonly RuntimeMetricDefinition[],
): boolean {
  return (
    TenantContextSchema.safeParse(options?.actor).success &&
    ConnectorBindingSchema.safeParse(binding).success &&
    options.actor.organizationId === binding.organizationId &&
    options.actor.workspaceId === binding.workspaceId &&
    Array.isArray(entries) &&
    entries.length > 0 &&
    entries.length <= 100 &&
    entries.every(
      (entry) =>
        MetricValueSchema.safeParse({ kind: entry?.kind, unit: entry?.unit, value: null })
          .success &&
        SourceVersionSchema.safeParse(entry?.definitionVersion).success &&
        /^sha256:[a-f0-9]{64}$/u.test(entry?.definitionHash),
    ) &&
    new Set(entries.map((entry) => entry.kind)).size === entries.length
  );
}
export async function ensureMetricDefinitions(
  options: Options,
  binding: ConnectorBinding,
  entries: readonly RuntimeMetricDefinition[],
  provision = false,
): Promise<MetricResult<true>> {
  if (!validRequest(options, binding, entries)) return failure("INVALID_INPUT");
  let client: PoolClient | undefined;
  let discard = false;
  let finishing = false;
  const onError = () => {
    discard = true;
  };
  try {
    client = await options.pool.connect();
    client.on("error", onError);
    await identity(client, options.actor, binding);
    for (const entry of entries) {
      if (!(await checkDefinition(client, binding, entry, provision))) {
        const failed = await rollback(client);
        discard = failed || discard;
        return failure(discard ? "SOURCE_UNAVAILABLE" : "VERSION_MISMATCH");
      }
    }
    if (discard) throw new Error("Metric definition connection unavailable");
    finishing = true;
    await client.query("COMMIT");
    return discard ? failure("SOURCE_UNAVAILABLE") : { ok: true, value: true };
  } catch {
    discard = finishing || (await rollback(client)) || discard;
    return failure("SOURCE_UNAVAILABLE");
  } finally {
    client?.off("error", onError);
    client?.release(discard);
  }
}

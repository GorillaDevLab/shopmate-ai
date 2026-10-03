import type pg from "pg";
import { frozenConfiguration } from "./configuration.js";
import { SourceStorageError } from "./errors.js";
import { scopeValues, currentAccess } from "./transaction.js";
import type { SourceGeneration, SourceInitialization, SourceScope } from "./types.js";

interface RuntimeRow extends SourceScope {
  sourceConfig: unknown;
  configHash: string;
  generatorVersion: string;
  runtimeVersion: "mock-runtime-v2";
  openingAt: string;
  baselineEnd: string;
  createdAt: string;
}
interface SessionRow {
  config: unknown;
  configHash: string;
  generatorVersion: string;
}
const generationSql = `SELECT "sessionId",generation,"organizationId","workspaceId","storeId","connectionId","externalStoreId","sourceConfig","configHash","generatorVersion","runtimeVersion",
  to_char("openingAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "openingAt",
  to_char("baselineEnd",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "baselineEnd",
  to_char("createdAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
  FROM mock_platform."Runtime" WHERE "organizationId"=$1 AND "workspaceId"=$2 AND "storeId"=$3 AND "sessionId"=$4 AND "connectionId"=$5 AND "externalStoreId"=$6 AND generation=$7`;

function generation(row: RuntimeRow, scope: SourceScope): SourceGeneration {
  const dates = frozenConfiguration(row.sourceConfig, row.configHash, row.generatorVersion, scope);
  if (
    row.runtimeVersion !== "mock-runtime-v2" ||
    dates.openingAt !== row.openingAt ||
    dates.baselineEnd !== row.baselineEnd ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(row.createdAt)
  )
    throw new SourceStorageError("SOURCE_INTEGRITY");
  return {
    scope: { ...scope },
    sourceConfig: row.sourceConfig,
    configHash: row.configHash,
    generatorVersion: row.generatorVersion,
    runtimeVersion: row.runtimeVersion,
    openingAt: row.openingAt,
    baselineEnd: row.baselineEnd,
    createdAt: row.createdAt,
  };
}
export async function findGeneration(
  client: pg.PoolClient,
  scope: SourceScope,
): Promise<SourceGeneration | null> {
  const result = await client.query<RuntimeRow>(generationSql, [...scopeValues(scope)]);
  if (result.rowCount === 0) return null;
  if (result.rowCount !== 1 || !result.rows[0]) throw new SourceStorageError("SOURCE_INTEGRITY");
  return generation(result.rows[0], scope);
}
async function currentSession(
  client: pg.PoolClient,
  scope: SourceScope,
): Promise<SessionRow | null> {
  const result = await client.query<SessionRow>(
    `SELECT config,"configHash","generatorVersion" FROM demo."DemoCommerceSession" WHERE id=$4 AND "organizationId"=$1 AND "workspaceId"=$2 AND "storeId"=$3 AND "connectionId"=$5 AND "externalStoreId"=$6 AND mock_platform.has_worker_access($1,$2,$3,$4,$5,$6,$7)`,
    [...scopeValues(scope)],
  );
  if (result.rowCount === 0) return null;
  if (result.rowCount !== 1 || !result.rows[0]) throw new SourceStorageError("SOURCE_INTEGRITY");
  return result.rows[0];
}
async function insertGeneration(
  client: pg.PoolClient,
  scope: SourceScope,
  session: SessionRow,
): Promise<number> {
  const dates = frozenConfiguration(
    session.config,
    session.configHash,
    session.generatorVersion,
    scope,
  );
  const result = await client.query(
    `INSERT INTO mock_platform."Runtime" ("sessionId",generation,"organizationId","workspaceId","storeId","connectionId","externalStoreId","sourceConfig","configHash","generatorVersion","runtimeVersion","openingAt","baselineEnd")
    SELECT d.id,$7,d."organizationId",d."workspaceId",d."storeId",d."connectionId",d."externalStoreId",d.config,d."configHash",d."generatorVersion",'mock-runtime-v2',$8::timestamp,$9::timestamp
    FROM demo."DemoCommerceSession" d WHERE d.id=$4 AND d."organizationId"=$1 AND d."workspaceId"=$2 AND d."storeId"=$3 AND d."connectionId"=$5 AND d."externalStoreId"=$6
      AND d.config=$10::jsonb AND d."configHash"=$11 AND d."generatorVersion"=$12 AND mock_platform.has_worker_access($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT ("sessionId",generation) DO NOTHING`,
    [
      ...scopeValues(scope),
      dates.openingAt,
      dates.baselineEnd,
      JSON.stringify(session.config),
      session.configHash,
      session.generatorVersion,
    ],
  );
  if (result.rowCount !== 0 && result.rowCount !== 1)
    throw new SourceStorageError("SOURCE_INTEGRITY");
  return result.rowCount;
}
function matchingSnapshot(found: SourceGeneration, session: SessionRow): boolean {
  return (
    found.configHash === session.configHash &&
    found.generatorVersion === session.generatorVersion &&
    JSON.stringify(found.sourceConfig) === JSON.stringify(session.config)
  );
}
export async function initializeGeneration(
  client: pg.PoolClient,
  scope: SourceScope,
): Promise<SourceInitialization> {
  const session = await currentSession(client, scope);
  if (!session) return { status: "DENIED" };
  frozenConfiguration(session.config, session.configHash, session.generatorVersion, scope);
  let found = await findGeneration(client, scope);
  const inserted = found ? 0 : await insertGeneration(client, scope, session);
  found ??= await findGeneration(client, scope);
  if (!(await currentAccess(client, scope, "worker"))) return { status: "DENIED" };
  if (!found || !matchingSnapshot(found, session)) throw new SourceStorageError("SOURCE_INTEGRITY");
  return { status: inserted === 1 ? "CREATED" : "EXISTS", generation: found };
}

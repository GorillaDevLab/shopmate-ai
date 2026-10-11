import { DemoScenarioViewSchema, type DemoScenarioView } from "@shopmate/contracts";
import {
  withDemoIdentity,
  readDemoStore,
  readDemoRecord,
  type DemoTransaction,
} from "./demo-commerce.repository.js";
import { executeOne, finish, mutateExisting, updateConnection } from "./demo-commerce.mutations.js";
import type {
  DemoActor,
  DemoConnectionRecord,
  DemoResetInput,
  DemoMutationResult,
} from "./demo-commerce.types.js";
import {
  validActor,
  validId,
  validCounter,
  sourceJson,
  MAX_COUNTER,
} from "./demo-commerce.validation.js";
import { frozenConfiguration } from "./mock-platform/configuration.js";
import { SourceStorageError } from "./mock-platform/errors.js";
export interface DemoScenarioInput extends DemoResetInput {
  readonly runId: string;
  readonly confirmSessionId: string;
  readonly expectedGeneration: number;
}
export type DemoScenarioResult =
  | { readonly status: "WRITTEN"; readonly view: DemoScenarioView }
  | { readonly status: "NOT_FOUND" | "CONFLICT" };
export async function scenarioView(
  tx: DemoTransaction,
  row: DemoConnectionRecord,
): Promise<DemoScenarioView> {
  const records = await tx.$queryRaw<{ run: unknown }[]>`
    SELECT jsonb_build_object('id',id,'generation',generation,'loadedRevision',"loadedRevision",
      'configHash',"configHash",'loadedAt',to_char("loadedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'businessClock',to_char("businessClock",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'plan',config->'scenarioPlan','status',CASE WHEN ${row.status}='DISCONNECTED' AND "configHash"=${row.configHash}
        AND generation=(SELECT max(previous.generation) FROM demo."DemoScenarioRun" previous WHERE previous."sessionId"=${row.id})
        AND NOT EXISTS (SELECT 1 FROM demo."DemoControlAudit" control WHERE control."organizationId"=${row.organizationId}
          AND control."workspaceId"=${row.workspaceId} AND control."sessionId"=${row.id}
          AND control.kind='RESET' AND control."afterRevision">"DemoScenarioRun"."loadedRevision") THEN 'DISCONNECTED'
        WHEN generation<>${row.generation} THEN 'SUPERSEDED' ELSE 'ACTIVE' END) AS run
    FROM demo."DemoScenarioRun" WHERE "sessionId"=${row.id} AND "organizationId"=${row.organizationId}
      AND "workspaceId"=${row.workspaceId} AND "storeId"=${row.storeId} AND "connectionId"=${row.connectionId}
      AND "externalStoreId"=${row.externalStoreId} ORDER BY generation DESC LIMIT 20`;
  return DemoScenarioViewSchema.parse({
    sessionId: row.id,
    generation: row.generation,
    revision: row.revision,
    clockNow: row.clockNow.toISOString(),
    runs: records.map((r) => r.run),
  });
}
export async function findDemoScenarios(
  actor: DemoActor,
  storeId: string,
): Promise<DemoScenarioView | null> {
  if (!validActor(actor, storeId)) return null;
  return withDemoIdentity(actor, async (tx) => {
    const access = await readDemoStore(tx, actor, storeId);
    const row = access && (await readDemoRecord(tx, access));
    if (!row) return null;
    const result = await scenarioView(tx, row);
    const current = await readDemoStore(tx, actor, storeId);
    const after = current && (await readDemoRecord(tx, current));
    return after?.id === row.id &&
      after.revision === row.revision &&
      after.generation === row.generation &&
      after.status === row.status
      ? result
      : null;
  });
}
function frozenInput(input: DemoScenarioInput, row: DemoConnectionRecord): string | null {
  const json = sourceJson(input);
  if (!json || input.generatorVersion !== "mock-source-v2") return null;
  try {
    frozenConfiguration(input.config, input.configHash, input.generatorVersion, {
      ...row,
      sessionId: row.id,
    });
    const config = JSON.parse(json) as { historyStart: string; days: number };
    const start = Date.parse(config.historyStart),
      clock = input.clockNow.getTime();
    return clock >= start && clock <= start + (config.days + 5) * 86400000 ? json : null;
  } catch (error) {
    if (error instanceof SourceStorageError) return null;
    throw error;
  }
}
async function writeRun(
  tx: DemoTransaction,
  row: DemoConnectionRecord,
  input: DemoScenarioInput,
  json: string,
) {
  await executeOne(
    tx,
  )`INSERT INTO demo."DemoScenarioRun" (id,"organizationId","workspaceId","storeId",
    "sessionId","connectionId","externalStoreId",generation,"loadedRevision","configHash",config,"businessClock","actorUserId")
    VALUES (${input.runId},${row.organizationId},${row.workspaceId},${row.storeId},${row.id},${row.connectionId},
      ${row.externalStoreId},${row.generation + 1},${row.revision + 1},${input.configHash},${json}::jsonb,${input.clockNow},${row.userId})`;
}
async function applyScenario(
  tx: DemoTransaction,
  row: DemoConnectionRecord,
  input: DemoScenarioInput,
): Promise<DemoMutationResult> {
  const json = frozenInput(input, row);
  if (
    !json ||
    row.id !== input.confirmSessionId ||
    row.generation !== input.expectedGeneration ||
    row.status !== "ACTIVE" ||
    row.generation >= MAX_COUNTER ||
    row.clockRevision >= MAX_COUNTER
  )
    return { status: "CONFLICT" };
  await updateConnection(tx, row, "ACTIVE");
  await executeOne(
    tx,
  )`UPDATE demo."DemoCommerceSession" SET config=${json}::jsonb,"configHash"=${input.configHash},
      "generatorVersion"=${input.generatorVersion},"clockNow"=${input.clockNow},"clockRevision"="clockRevision"+1,
      revision=revision+1 WHERE id=${row.id} AND revision=${input.expectedRevision}`;
  await writeRun(tx, row, input, json);
  const written = await finish(tx, row, "RESET", row.revision);
  if (written.status !== "WRITTEN") throw new Error("Scenario session was not written");
  return written;
}
export async function loadDemoScenario(
  actor: DemoActor,
  storeId: string,
  input: DemoScenarioInput,
): Promise<DemoScenarioResult> {
  if (!validActor(actor, storeId)) return { status: "NOT_FOUND" };
  if (
    !input ||
    !validId(input.runId) ||
    !validId(input.confirmSessionId) ||
    !validCounter(input.expectedGeneration)
  )
    return { status: "CONFLICT" };
  let view: DemoScenarioView | null = null;
  const result = await mutateExisting(actor, storeId, input.expectedRevision, async (tx, row) => {
    const written = await applyScenario(tx, row, input);
    if (written.status === "WRITTEN") view = await scenarioView(tx, written.record);
    return written;
  });
  if (result.status !== "WRITTEN") return result;
  if (!view) throw new Error("Scenario view missing after atomic load");
  return { status: "WRITTEN", view };
}

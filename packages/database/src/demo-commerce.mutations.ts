import { randomUUID } from "node:crypto";
import { readDemoRecord, readDemoStore, withDemoIdentity } from "./demo-commerce.repository.js";
import type { DemoTransaction } from "./demo-commerce.repository.js";
import type {
  DemoActor,
  DemoAdvanceInput,
  DemoConnectionRecord,
  DemoCreateInput,
  DemoMutationResult,
  DemoResetInput,
  DemoStoreAccess,
} from "./demo-commerce.types.js";
import {
  isConstraintConflict,
  matchesBinding,
  MAX_COUNTER,
  sourceJson,
  validActor,
  validClock,
  validCounter,
  validId,
} from "./demo-commerce.validation.js";

const conflict = { status: "CONFLICT" } as const;
const notFound = { status: "NOT_FOUND" } as const;
type ControlKind = "CREATE" | "ADVANCE" | "RESET" | "DISCONNECT";

class DemoWriteConflict extends Error {}

function executeOne(tx: DemoTransaction) {
  return async (template: TemplateStringsArray, ...values: unknown[]): Promise<void> => {
    // RLS can hide a previously locked row between statements; throwing rolls back prior writes.
    if ((await tx.$executeRaw(template, ...values)) !== 1)
      throw new DemoWriteConflict("Demo mutation did not affect exactly one row");
  };
}

async function finish(
  tx: DemoTransaction,
  access: DemoStoreAccess,
  kind: ControlKind,
  beforeRevision: number | null,
): Promise<DemoMutationResult> {
  const row = await readDemoRecord(tx, access);
  if (!row) throw new Error("Demo session disappeared during mutation");
  await executeOne(tx)`
    INSERT INTO demo."DemoControlAudit" (id,"organizationId","workspaceId","storeId","sessionId","connectionId",
      "actorUserId",kind,"beforeRevision","afterRevision",generation,"configHash","clockNow")
    VALUES (${randomUUID()},${row.organizationId},${row.workspaceId},${row.storeId},${row.id},${row.connectionId},
      ${access.userId},${kind},${beforeRevision},${row.revision},${row.generation},${row.configHash},${row.clockNow})`;
  return { status: "WRITTEN", record: row };
}

async function safelyMutate(
  actor: DemoActor,
  action: (tx: DemoTransaction) => Promise<DemoMutationResult>,
): Promise<DemoMutationResult> {
  try {
    return await withDemoIdentity(actor, action);
  } catch (error) {
    if (error instanceof DemoWriteConflict || isConstraintConflict(error)) return conflict;
    throw error;
  }
}

async function insertConnection(
  tx: DemoTransaction,
  access: DemoStoreAccess,
  input: DemoCreateInput,
): Promise<void> {
  await executeOne(tx)`
    INSERT INTO public."PlatformConnection" (id,"organizationId","workspaceId","storeId","externalStoreId")
    VALUES (${input.connectionId},${access.organizationId},${access.workspaceId},${access.storeId},${input.externalStoreId})`;
}

async function insertSession(
  tx: DemoTransaction,
  access: DemoStoreAccess,
  input: DemoCreateInput,
  json: string,
): Promise<void> {
  await executeOne(tx)`
    INSERT INTO demo."DemoCommerceSession" (id,"organizationId","workspaceId","storeId","connectionId","externalStoreId",
      config,"configHash","generatorVersion","clockNow")
    VALUES (${input.id},${access.organizationId},${access.workspaceId},${access.storeId},${input.connectionId},${input.externalStoreId},
      ${json}::jsonb,${input.configHash},${input.generatorVersion},${input.clockNow})`;
}

export async function createDemoSession(
  actor: DemoActor,
  storeId: string,
  input: DemoCreateInput,
): Promise<DemoMutationResult> {
  if (!validActor(actor, storeId)) return notFound;
  const json = sourceJson(input);
  if (!json || !validCreateIds(input)) return conflict;
  return safelyMutate(actor, async (tx) => {
    const access = await readDemoStore(tx, actor, storeId, true);
    if (!access) return notFound;
    if (!matchesBinding(json, bindingScope(access, input))) return conflict;
    await insertConnection(tx, access, input);
    await insertSession(tx, access, input, json);
    return finish(tx, access, "CREATE", null);
  });
}

function validCreateIds(input: DemoCreateInput): boolean {
  return (
    validId(input.id) &&
    validId(input.connectionId) &&
    typeof input.externalStoreId === "string" &&
    input.externalStoreId.length >= 1 &&
    input.externalStoreId.length <= 200
  );
}

function bindingScope(
  access: DemoStoreAccess,
  connection: { readonly connectionId: string; readonly externalStoreId: string },
) {
  return {
    organizationId: access.organizationId,
    workspaceId: access.workspaceId,
    storeId: access.storeId,
    connectionId: connection.connectionId,
    externalStoreId: connection.externalStoreId,
  };
}

async function mutateExisting(
  actor: DemoActor,
  storeId: string,
  revision: number,
  action: (tx: DemoTransaction, row: DemoConnectionRecord) => Promise<DemoMutationResult>,
): Promise<DemoMutationResult> {
  if (!validActor(actor, storeId)) return notFound;
  if (!validCounter(revision)) return conflict;
  return safelyMutate(actor, async (tx) => {
    const access = await readDemoStore(tx, actor, storeId, true);
    if (!access) return notFound;
    const row = await readDemoRecord(tx, access, true);
    if (!row) return notFound;
    if (row.revision !== revision) return conflict;
    return action(tx, row);
  });
}

export async function advanceDemoSession(
  actor: DemoActor,
  storeId: string,
  input: DemoAdvanceInput,
): Promise<DemoMutationResult> {
  if (
    !input ||
    !Number.isInteger(input.durationMs) ||
    input.durationMs < 1 ||
    input.durationMs > 2_592_000_000
  )
    return conflict;
  return mutateExisting(actor, storeId, input.expectedRevision, async (tx, row) => {
    const next = new Date(row.clockNow.getTime() + input.durationMs);
    if (!validClock(next) || row.clockRevision >= MAX_COUNTER || row.status !== "ACTIVE")
      return conflict;
    await executeOne(
      tx,
    )`UPDATE demo."DemoCommerceSession" SET "clockNow"=${next},"clockRevision"="clockRevision"+1,
      revision=revision+1 WHERE id=${row.id} AND revision=${input.expectedRevision}`;
    return finish(tx, row, "ADVANCE", row.revision);
  });
}

async function updateConnection(
  tx: DemoTransaction,
  row: DemoConnectionRecord,
  status: "ACTIVE" | "DISCONNECTED",
): Promise<void> {
  await executeOne(
    tx,
  )`UPDATE public."PlatformConnection" SET generation=generation+1,status=${status}
    WHERE id=${row.connectionId}`;
}

export async function resetDemoSession(
  actor: DemoActor,
  storeId: string,
  input: DemoResetInput,
): Promise<DemoMutationResult> {
  const json = sourceJson(input);
  if (!json) return conflict;
  return mutateExisting(actor, storeId, input.expectedRevision, async (tx, row) => {
    if (
      row.generation >= MAX_COUNTER ||
      row.clockRevision >= MAX_COUNTER ||
      !matchesBinding(json, bindingScope(row, row))
    )
      return conflict;
    await updateConnection(tx, row, "ACTIVE");
    await executeOne(
      tx,
    )`UPDATE demo."DemoCommerceSession" SET config=${json}::jsonb,"configHash"=${input.configHash},
      "generatorVersion"=${input.generatorVersion},"clockNow"=${input.clockNow},"clockRevision"="clockRevision"+1,
      revision=revision+1 WHERE id=${row.id} AND revision=${input.expectedRevision}`;
    return finish(tx, row, "RESET", row.revision);
  });
}

export async function disconnectDemoSession(
  actor: DemoActor,
  storeId: string,
  expectedRevision: number,
): Promise<DemoMutationResult> {
  return mutateExisting(actor, storeId, expectedRevision, async (tx, row) => {
    if (row.generation >= MAX_COUNTER) return conflict;
    await updateConnection(tx, row, "DISCONNECTED");
    await executeOne(tx)`UPDATE demo."DemoCommerceSession" SET revision=revision+1
      WHERE id=${row.id} AND revision=${expectedRevision}`;
    return finish(tx, row, "DISCONNECT", row.revision);
  });
}

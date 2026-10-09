import {
  DemoFailureRuleCreateSchema,
  DemoFailureRuleRemoveSchema,
  MockReadFailureRulesSchema,
  type MockReadFailureRule,
} from "@shopmate/contracts";
import {
  lockDemoControl,
  readDemoRecord,
  readDemoStore,
  withDemoIdentity,
  type DemoTransaction,
} from "./demo-commerce.repository.js";
import type { DemoActor, DemoConnectionRecord } from "./demo-commerce.types.js";
import { isConstraintConflict, validActor } from "./demo-commerce.validation.js";

const conflict = { status: "CONFLICT" } as const;
const denied = { status: "NOT_FOUND" } as const;
class FailureRuleConflict extends Error {}
export interface DemoFailureRuleView {
  readonly sessionId: string;
  readonly generation: number;
  readonly revision: number;
  readonly clockNow: string;
  readonly rules: readonly MockReadFailureRule[];
}
export type DemoFailureRuleResult =
  | typeof conflict
  | typeof denied
  | { readonly status: "WRITTEN"; readonly view: DemoFailureRuleView };

async function view(tx: DemoTransaction, row: DemoConnectionRecord): Promise<DemoFailureRuleView> {
  const records = await tx.$queryRaw<{ rule: unknown }[]>`
    SELECT jsonb_build_object('id',id,'priority',priority,'startsAt',to_char("startsAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'endsAt',to_char("endsAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'methods',methods,'effect',
      CASE WHEN "effectKind"='FAIL' THEN jsonb_build_object('kind','FAIL','code',"effectCode",'retryAfterMs',"retryAfterMs")
      ELSE jsonb_build_object('kind','DELAY','delayMs',"delayMs") END) AS rule
    FROM demo."DemoFailureRule" WHERE "sessionId"=${row.id} AND generation=${row.generation}
      AND "organizationId"=${row.organizationId} AND "workspaceId"=${row.workspaceId} AND "storeId"=${row.storeId}
      AND "connectionId"=${row.connectionId} AND "externalStoreId"=${row.externalStoreId}
      AND "removedRevision" IS NULL AND "endsAt">${row.clockNow} ORDER BY priority DESC,id LIMIT 33`;
  return {
    sessionId: row.id,
    generation: row.generation,
    revision: row.revision,
    clockNow: row.clockNow.toISOString(),
    rules: MockReadFailureRulesSchema.parse(records.map((item) => item.rule)),
  };
}
export async function findDemoFailureRules(
  actor: DemoActor,
  storeId: string,
): Promise<DemoFailureRuleView | null> {
  if (!validActor(actor, storeId)) return null;
  return withDemoIdentity(actor, async (tx) => {
    const access = await readDemoStore(tx, actor, storeId);
    const row = access && (await readDemoRecord(tx, access));
    if (!row || row.status !== "ACTIVE") return null;
    const result = await view(tx, row);
    const current = await readDemoStore(tx, actor, storeId);
    const after = current && (await readDemoRecord(tx, current));
    if (
      !after ||
      after.id !== row.id ||
      after.generation !== row.generation ||
      after.status !== "ACTIVE" ||
      after.revision !== row.revision
    )
      return null;
    return result;
  });
}
async function mutate(
  actor: DemoActor,
  storeId: string,
  revision: number,
  action: (tx: DemoTransaction, row: DemoConnectionRecord) => Promise<void>,
): Promise<DemoFailureRuleResult> {
  if (!validActor(actor, storeId)) return denied;
  try {
    return await withDemoIdentity(actor, async (tx) => {
      const candidateAccess = await readDemoStore(tx, actor, storeId);
      const candidate = candidateAccess && (await readDemoRecord(tx, candidateAccess));
      if (!candidate) return denied;
      await lockDemoControl(tx, candidate.id);
      const access = await readDemoStore(tx, actor, storeId, true);
      const row = access && (await readDemoRecord(tx, access, true));
      if (!row || row.status !== "ACTIVE") return denied;
      if (row.revision !== revision) return conflict;
      await action(tx, row);
      const afterAccess = await readDemoStore(tx, actor, storeId, true);
      const after = afterAccess && (await readDemoRecord(tx, afterAccess));
      if (!after || after.id !== row.id || after.generation !== row.generation)
        throw new FailureRuleConflict();
      return { status: "WRITTEN", view: await view(tx, after) };
    });
  } catch (error) {
    if (error instanceof FailureRuleConflict || isConstraintConflict(error)) return conflict;
    throw error;
  }
}
async function increment(tx: DemoTransaction, row: DemoConnectionRecord): Promise<void> {
  const count =
    await tx.$executeRaw`UPDATE demo."DemoCommerceSession" SET revision=revision+1 WHERE id=${row.id} AND revision=${row.revision}`;
  if (count !== 1) throw new FailureRuleConflict();
}
export async function createDemoFailureRule(
  actor: DemoActor,
  storeId: string,
  input: unknown,
): Promise<DemoFailureRuleResult> {
  const command = DemoFailureRuleCreateSchema.safeParse(input);
  if (!command.success) return conflict;
  return mutate(actor, storeId, command.data.expectedRevision, async (tx, row) => {
    const rule = command.data.rule;
    await increment(tx, row);
    const effect = rule.effect;
    const count = await tx.$executeRaw`INSERT INTO demo."DemoFailureRule"
      (id,"organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,priority,"startsAt","endsAt",methods,"effectKind","effectCode","retryAfterMs","delayMs","createdRevision")
      VALUES (${rule.id},${row.organizationId},${row.workspaceId},${row.storeId},${row.id},${row.connectionId},${row.externalStoreId},${row.generation},${rule.priority},${new Date(rule.startsAt)},${new Date(rule.endsAt)},${[...rule.methods]}::text[],${effect.kind},${effect.kind === "FAIL" ? effect.code : null},${effect.kind === "FAIL" ? effect.retryAfterMs : null},${effect.kind === "DELAY" ? effect.delayMs : null},${row.revision + 1})`;
    if (count !== 1) throw new FailureRuleConflict();
  });
}
export async function removeDemoFailureRule(
  actor: DemoActor,
  storeId: string,
  input: unknown,
): Promise<DemoFailureRuleResult> {
  const command = DemoFailureRuleRemoveSchema.safeParse(input);
  if (!command.success) return conflict;
  return mutate(actor, storeId, command.data.expectedRevision, async (tx, row) => {
    if (row.id !== command.data.confirmSessionId) throw new FailureRuleConflict();
    await increment(tx, row);
    const count =
      await tx.$executeRaw`UPDATE demo."DemoFailureRule" SET "removedRevision"=${row.revision + 1}
      WHERE "sessionId"=${row.id} AND generation=${row.generation} AND id=${command.data.ruleId} AND "removedRevision" IS NULL`;
    if (count !== 1) throw new FailureRuleConflict();
  });
}

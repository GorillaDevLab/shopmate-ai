import type { Prisma } from "../generated/prisma/client.js";
import { getPrismaClient } from "./client.js";
import type { DemoActor, DemoConnectionRecord, DemoStoreAccess } from "./demo-commerce.types.js";
import { validActor } from "./demo-commerce.validation.js";

export type DemoTransaction = Prisma.TransactionClient;

export async function withDemoIdentity<T>(
  actor: DemoActor,
  action: (tx: DemoTransaction) => Promise<T>,
): Promise<T> {
  return getPrismaClient().$transaction(
    async (tx) => {
      // Transaction-local identity cannot leak when pooled connections are reused.
      await tx.$queryRaw`SELECT set_config('app.user_id', ${actor.userId}, true)`;
      await tx.$executeRaw`SET LOCAL lock_timeout='5s'`;
      await tx.$executeRaw`SET LOCAL statement_timeout='10s'`;
      return action(tx);
    },
    { isolationLevel: "ReadCommitted", timeout: 15_000 },
  );
}

export async function lockDemoControl(tx: DemoTransaction, sessionId: string): Promise<void> {
  // VOID has no Prisma decoder; the text projection carries no authorization result.
  await tx.$queryRaw`SELECT demo.lock_source_control(${sessionId})::text`;
}

export async function readDemoStore(
  tx: DemoTransaction,
  actor: DemoActor,
  storeId: string,
  writable = false,
): Promise<DemoStoreAccess | null> {
  const rows = await tx.$queryRaw<DemoStoreAccess[]>`
    SELECT m."userId",s."merchantId",s."organizationId",s."workspaceId",s.id AS "storeId",m.role
    FROM public."Store" s
    JOIN public."Organization" o ON o.id=s."organizationId" AND o."legacyMerchantId"=s."merchantId"
    JOIN public."Workspace" w ON w.id=s."workspaceId" AND w."organizationId"=o.id
    JOIN public."OrganizationMember" m ON m."organizationId"=o.id
    JOIN public."DemoTenant" d ON d."organizationId"=o.id
    JOIN public."TenantBootstrapEnvironment" e ON e.id='singleton' AND e.environment='DEMO'
    WHERE s.id=${storeId} AND s."merchantId"=${actor.merchantId} AND m."userId"=${actor.userId}
      AND m.status='ACTIVE' AND o.status='ACTIVE' AND w.status='ACTIVE'
      AND (${writable}=false OR m.role IN ('OWNER','ADMIN'))
      AND (m.role IN ('OWNER','ADMIN') OR EXISTS (
        SELECT 1 FROM public."WorkspaceMember" wm WHERE wm."organizationId"=o.id AND wm."workspaceId"=w.id
          AND wm."userId"=m."userId" AND wm.status='ACTIVE')) LIMIT 1`;
  return rows[0] ?? null;
}

export async function readDemoRecord(
  tx: DemoTransaction,
  access: DemoStoreAccess,
  lock = false,
): Promise<DemoConnectionRecord | null> {
  const rows = lock
    ? await lockedRecord(tx, access.storeId)
    : await currentRecord(tx, access.storeId);
  return rows[0] ? { ...access, ...rows[0], environmentMarker: "DEMO", demoTenant: true } : null;
}

type SessionFields = Omit<
  DemoConnectionRecord,
  keyof DemoStoreAccess | "environmentMarker" | "demoTenant"
>;

async function currentRecord(tx: DemoTransaction, storeId: string): Promise<SessionFields[]> {
  return tx.$queryRaw<SessionFields[]>`
    SELECT s.id,s."connectionId",s."externalStoreId",s.config,s."configHash",s."generatorVersion",
      s."clockNow",s."clockRevision",s.revision,c.generation,c.status
    FROM demo."DemoCommerceSession" s JOIN public."PlatformConnection" c ON c.id=s."connectionId"
    WHERE s."storeId"=${storeId}`;
}

async function lockedRecord(tx: DemoTransaction, storeId: string): Promise<SessionFields[]> {
  // CONTROL precedes these separate ordered row locks on every supported mutation path.
  await tx.$queryRaw`SELECT id FROM demo."DemoCommerceSession" WHERE "storeId"=${storeId} FOR UPDATE`;
  await tx.$queryRaw`SELECT c.id FROM public."PlatformConnection" c
    JOIN demo."DemoCommerceSession" s ON s."connectionId"=c.id WHERE s."storeId"=${storeId} FOR UPDATE OF c`;
  return currentRecord(tx, storeId);
}

export async function findDemoStore(
  actor: DemoActor,
  storeId: string,
): Promise<DemoStoreAccess | null> {
  if (!validActor(actor, storeId)) return null;
  return withDemoIdentity(actor, (tx) => readDemoStore(tx, actor, storeId));
}

export async function findDemoSession(
  actor: DemoActor,
  storeId: string,
): Promise<DemoConnectionRecord | null> {
  if (!validActor(actor, storeId)) return null;
  return withDemoIdentity(actor, async (tx) => {
    const access = await readDemoStore(tx, actor, storeId);
    return access ? readDemoRecord(tx, access) : null;
  });
}

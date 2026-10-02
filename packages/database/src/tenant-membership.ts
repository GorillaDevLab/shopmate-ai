import type { TenantRole } from "../generated/prisma/client.js";
import { getPrismaClient } from "./client.js";

export interface TenantMembershipRecord {
  readonly userId: string;
  readonly merchantId: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly role: TenantRole;
}

export async function resolveTenantMembership(
  userId: string,
  merchantId: string,
  workspaceId?: string,
): Promise<TenantMembershipRecord | null> {
  return getPrismaClient().$transaction(async (transaction) => {
    // LOCAL scope is cleared on commit/rollback, including when pooled connections are reused.
    await transaction.$queryRaw`SELECT set_config('app.user_id', ${userId}, true)`;
    // One statement snapshot prevents a role change between membership and resource checks.
    const records = await transaction.$queryRaw<TenantMembershipRecord[]>`
      SELECT m."userId", o."legacyMerchantId" AS "merchantId", o.id AS "organizationId",
             w.id AS "workspaceId", m.role
      FROM "OrganizationMember" m
      JOIN "Organization" o ON o.id = m."organizationId"
      JOIN "Workspace" w ON w."organizationId" = o.id
      WHERE m."userId" = ${userId} AND o."legacyMerchantId" = ${merchantId}
        AND m.status = 'ACTIVE' AND o.status = 'ACTIVE' AND w.status = 'ACTIVE'
        AND ((${workspaceId ?? null}::text IS NULL AND w.slug = 'default') OR w.id = ${workspaceId ?? null})
        AND (m.role IN ('OWNER','ADMIN') OR EXISTS (
          SELECT 1 FROM "WorkspaceMember" wm
          WHERE wm."organizationId" = o.id AND wm."workspaceId" = w.id
            AND wm."userId" = ${userId} AND wm.status = 'ACTIVE'))
      LIMIT 1`;
    return records[0] ?? null;
  });
}

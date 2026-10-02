import type { Prisma, TenantRole } from "../generated/prisma/client.js";
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
    return readMembership(transaction, userId, merchantId, workspaceId);
  });
}

async function readMembership(
  transaction: Prisma.TransactionClient,
  userId: string,
  merchantId: string,
  workspaceId?: string,
): Promise<TenantMembershipRecord | null> {
  const membership = await transaction.organizationMember.findFirst({
    where: {
      userId,
      status: "ACTIVE",
      organization: { legacyMerchantId: merchantId, status: "ACTIVE" },
    },
    select: { organizationId: true, role: true },
  });
  if (!membership) return null;
  const organizationWide = membership.role === "OWNER" || membership.role === "ADMIN";
  const workspace = await transaction.workspace.findFirst({
    where: {
      organizationId: membership.organizationId,
      status: "ACTIVE",
      ...(workspaceId ? { id: workspaceId } : { slug: "default" }),
      ...(organizationWide ? {} : { members: { some: { userId, status: "ACTIVE" } } }),
    },
    select: { id: true },
  });
  if (!workspace) return null;
  return {
    userId,
    merchantId,
    organizationId: membership.organizationId,
    workspaceId: workspace.id,
    role: membership.role,
  };
}

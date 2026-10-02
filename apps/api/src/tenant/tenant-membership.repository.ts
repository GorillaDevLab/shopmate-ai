import { Injectable } from "@nestjs/common";
import { resolveTenantMembership, type TenantMembershipRecord } from "@shopmate/database";

export const TENANT_MEMBERSHIP_REPOSITORY = Symbol("TENANT_MEMBERSHIP_REPOSITORY");
export interface TenantMembershipRepository {
  resolve(
    userId: string,
    merchantId: string,
    workspaceId?: string,
  ): Promise<TenantMembershipRecord | null>;
}

@Injectable()
export class DatabaseTenantMembershipRepository implements TenantMembershipRepository {
  resolve(userId: string, merchantId: string, workspaceId?: string) {
    return resolveTenantMembership(userId, merchantId, workspaceId);
  }
}

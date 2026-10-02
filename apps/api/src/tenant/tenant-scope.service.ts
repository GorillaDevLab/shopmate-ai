import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import {
  TENANT_ROLE_PERMISSIONS,
  TenantContextSchema,
  TenantIdSchema,
  type TenantContext,
} from "@shopmate/contracts";
import type { AuthContext } from "../auth/contracts/index.js";
import {
  TENANT_MEMBERSHIP_REPOSITORY,
  type TenantMembershipRepository,
} from "./tenant-membership.repository.js";

export function tenantNotFound(): never {
  throw new NotFoundException({
    statusCode: 404,
    code: "RESOURCE_NOT_FOUND",
    message: "资源不存在",
  });
}

@Injectable()
export class TenantScopeService {
  constructor(
    @Inject(TENANT_MEMBERSHIP_REPOSITORY) private readonly repository: TenantMembershipRepository,
  ) {}

  async resolve(identity: AuthContext, workspaceId?: string): Promise<TenantContext> {
    if (
      !TenantIdSchema.safeParse(identity.userId).success ||
      !TenantIdSchema.safeParse(identity.merchantId).success
    )
      tenantNotFound();
    const record = await this.read(identity, workspaceId);
    if (!record) tenantNotFound();
    const context = TenantContextSchema.safeParse({
      ...record,
      permissions: TENANT_ROLE_PERMISSIONS[record.role],
    });
    if (
      !context.success ||
      record.userId !== identity.userId ||
      record.merchantId !== identity.merchantId ||
      (workspaceId && record.workspaceId !== workspaceId)
    )
      throw unavailable();
    return Object.freeze({
      ...context.data,
      permissions: Object.freeze([...context.data.permissions]),
    });
  }

  private async read(identity: AuthContext, workspaceId?: string) {
    try {
      return await this.repository.resolve(identity.userId, identity.merchantId, workspaceId);
    } catch {
      throw unavailable();
    }
  }
}

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    statusCode: 503,
    code: "TENANT_SERVICE_UNAVAILABLE",
    message: "租户服务暂时不可用",
  });
}

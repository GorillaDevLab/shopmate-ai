import { Module } from "@nestjs/common";
import { TenantController } from "./tenant.controller.js";
import { TenantContextGuard } from "./tenant-context.guard.js";
import { TenantScopeService } from "./tenant-scope.service.js";
import {
  DatabaseTenantMembershipRepository,
  TENANT_MEMBERSHIP_REPOSITORY,
} from "./tenant-membership.repository.js";

@Module({
  controllers: [TenantController],
  providers: [
    TenantContextGuard,
    TenantScopeService,
    { provide: TENANT_MEMBERSHIP_REPOSITORY, useClass: DatabaseTenantMembershipRepository },
  ],
})
export class TenantModule {}

import { Controller, Get, UseGuards } from "@nestjs/common";
import type { TenantContext } from "@shopmate/contracts";
import { TenantContextGuard } from "./tenant-context.guard.js";
import { CurrentTenant } from "./tenant-context.decorator.js";

@Controller({ path: "tenant", version: "1" })
@UseGuards(TenantContextGuard)
export class TenantController {
  @Get("context")
  context(@CurrentTenant() context: TenantContext): TenantContext {
    return context;
  }

  @Get("workspaces/:workspaceId")
  workspace(@CurrentTenant() context: TenantContext) {
    return { id: context.workspaceId, organizationId: context.organizationId };
  }
}

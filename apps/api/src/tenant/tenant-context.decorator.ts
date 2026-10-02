import { createParamDecorator, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import type { TenantRequest } from "./tenant-context.guard.js";

export const CurrentTenant = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const tenant = context.switchToHttp().getRequest<TenantRequest>().tenant;
  if (!tenant) throw new UnauthorizedException();
  return tenant;
});

import {
  BadRequestException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { TenantIdSchema, type TenantContext } from "@shopmate/contracts";
import type { AuthContext } from "../auth/contracts/index.js";
import { TenantScopeService, tenantNotFound } from "./tenant-scope.service.js";

export interface TenantRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly rawHeaders: readonly string[];
  readonly params?: { workspaceId?: unknown };
  readonly query?: Record<string, unknown>;
  readonly body?: unknown;
  readonly auth?: AuthContext;
  tenant?: TenantContext;
}

@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(@Inject(TenantScopeService) private readonly service: TenantScopeService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TenantRequest>();
    if (!request.auth) throw new UnauthorizedException();
    // Read-only tenant endpoints accept selection only through the validated header/path.
    if (hasContent(request.query) || hasContent(request.body)) tenantNotFound();
    const workspaceId = readWorkspaceSelection(request);
    request.tenant = await this.service.resolve(request.auth, workspaceId);
    return true;
  }
}

function hasContent(value: unknown): boolean {
  return value !== undefined && value !== null && Object.keys(Object(value)).length > 0;
}

function readWorkspaceSelection(request: TenantRequest): string | undefined {
  const count = request.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === "x-workspace-id",
  ).length;
  if (count > 1) throw invalidSelection();
  const header = request.headers["x-workspace-id"];
  const path = request.params?.workspaceId;
  for (const candidate of [header, path]) {
    if (candidate !== undefined && !TenantIdSchema.safeParse(candidate).success)
      throw invalidSelection();
  }
  if (header !== undefined && path !== undefined && header !== path) throw invalidSelection();
  return (path ?? header) as string | undefined;
}

function invalidSelection(): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    code: "INVALID_WORKSPACE_SELECTION",
    message: "工作区标识无效",
  });
}

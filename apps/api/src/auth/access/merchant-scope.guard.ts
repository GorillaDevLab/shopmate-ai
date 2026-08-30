import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { DEMO_AUTH_CONFIG, type DemoAuthConfig } from "../demo-auth.config.js";
import { AuthErrorCode, createAuthError, type AuthContext } from "../contracts/index.js";
import { DEMO_SESSION_COOKIE_NAME } from "../session/demo-session-cookie.js";
import { verifyDemoSession } from "../session/demo-session.js";
import { PUBLIC_ROUTE_KEY } from "./public.decorator.js";

interface ScopedRequest {
  readonly headers: { readonly cookie?: string | string[] };
  readonly params?: unknown;
  readonly query?: unknown;
  readonly body?: unknown;
  auth?: AuthContext;
}

@Injectable()
export class MerchantScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DEMO_AUTH_CONFIG) private readonly config: DemoAuthConfig | null,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.isPublic(context)) return true;
    const request = context.switchToHttp().getRequest<ScopedRequest>();
    const encodedSession = readUniqueSessionCookie(request.headers.cookie);
    const session =
      encodedSession && this.config
        ? verifyDemoSession(encodedSession, this.config.sessionSecret)
        : null;

    if (!session) throwUnauthenticated();
    if (containsMerchantOverride(request)) throwResourceNotFound();
    request.auth = session.context;
    return true;
  }

  private isPublic(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false
    );
  }
}

function readUniqueSessionCookie(header: string | string[] | undefined): string | null {
  if (typeof header !== "string") return null;
  const prefix = `${DEMO_SESSION_COOKIE_NAME}=`;
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix))
    .map((part) => part.slice(prefix.length));
  return values.length === 1 && values[0] ? values[0] : null;
}

function containsMerchantOverride(request: ScopedRequest): boolean {
  return [request.params, request.query, request.body].some(hasMerchantId);
}

function hasMerchantId(value: unknown): boolean {
  return value !== null && typeof value === "object" && Object.hasOwn(value, "merchantId");
}

function throwUnauthenticated(): never {
  throw new UnauthorizedException({
    statusCode: 401,
    ...createAuthError(AuthErrorCode.Unauthenticated),
  });
}

function throwResourceNotFound(): never {
  throw new NotFoundException({
    statusCode: 404,
    code: "RESOURCE_NOT_FOUND",
    message: "资源不存在",
  });
}

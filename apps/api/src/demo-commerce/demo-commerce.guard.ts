import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { AuthErrorCode, createAuthError, type AuthContext } from "../auth/contracts/index.js";
import { DEMO_COMMERCE_ENV, type DemoCommerceEnvironment } from "./demo-commerce.environment.js";

interface DemoRequest {
  readonly method: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly rawHeaders: readonly string[];
  readonly auth?: AuthContext;
  readonly query?: unknown;
  readonly body?: unknown;
}

@Injectable()
export class DemoCommerceGuard implements CanActivate {
  constructor(@Inject(DEMO_COMMERCE_ENV) private readonly environment: DemoCommerceEnvironment) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<DemoRequest>();
    if (!request.auth) {
      throw new UnauthorizedException({
        statusCode: 401,
        ...createAuthError(AuthErrorCode.Unauthenticated),
      });
    }
    if (!this.environment.enabled || !this.environment.origin) {
      throw new NotFoundException({
        statusCode: 404,
        code: "RESOURCE_NOT_FOUND",
        message: "资源不存在",
      });
    }
    validateReadControls(request);
    if (request.method === "POST") validateMutationOrigin(request, this.environment.origin);
    return true;
  }
}

function hasContent(input: unknown): boolean {
  if (input === undefined || input === null) return false;
  if (typeof input === "string") return input.length > 0;
  return typeof input === "object" ? Object.keys(input).length > 0 : true;
}

function validateReadControls(request: DemoRequest): void {
  const isRead = request.method === "GET" || request.method === "HEAD";
  if (
    (!isRead && request.method !== "POST") ||
    hasContent(request.query) ||
    (isRead && hasContent(request.body))
  ) {
    throw new BadRequestException({
      statusCode: 400,
      code: "INVALID_DEMO_REQUEST",
      message: "演示请求无效",
    });
  }
}

function validateMutationOrigin(request: DemoRequest, origin: string): void {
  const count = request.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === "origin",
  ).length;
  const suppliedOrigin = request.headers.origin;
  const fetchSite = request.headers["sec-fetch-site"];
  if (
    count !== 1 ||
    typeof suppliedOrigin !== "string" ||
    suppliedOrigin !== origin ||
    (fetchSite !== undefined &&
      (typeof fetchSite !== "string" || fetchSite.trim().toLowerCase() === "cross-site"))
  ) {
    throw new ForbiddenException({
      statusCode: 403,
      code: "INVALID_DEMO_ORIGIN",
      message: "演示请求来源无效",
    });
  }
}

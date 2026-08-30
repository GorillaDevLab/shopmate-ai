import { createHash, timingSafeEqual } from "node:crypto";

import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";

import {
  AuthPermission,
  createAuthContext,
  createAuthError,
  type LoginInputDto,
} from "./contracts/index.js";
import { DEMO_AUTH_CONFIG, type DemoAuthConfig } from "./demo-auth.config.js";
import { signDemoSession } from "./session/demo-session.js";

export interface DemoLoginResult {
  readonly token: string;
  readonly expiresAt: string;
  readonly ttlSeconds: number;
  readonly secureCookie: boolean;
}

@Injectable()
export class DemoAuthService {
  constructor(@Inject(DEMO_AUTH_CONFIG) private readonly config: DemoAuthConfig | null) {}

  login(input: LoginInputDto): DemoLoginResult {
    const config = this.requireConfig();
    if (!safeEqual(input.email, config.email) || !safeEqual(input.password, config.password)) {
      throw new UnauthorizedException({
        statusCode: 401,
        ...createAuthError("INVALID_CREDENTIALS"),
      });
    }

    const context = createAuthContext({
      userId: config.userId,
      merchantId: config.merchantId,
      permissions: Object.values(AuthPermission),
    });
    const session = signDemoSession(context, config.sessionSecret, config.ttlSeconds);
    return { ...session, ttlSeconds: config.ttlSeconds, secureCookie: config.secureCookie };
  }

  private requireConfig(): DemoAuthConfig {
    if (!this.config) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: "AUTH_NOT_CONFIGURED",
        message: "Demo 登录服务尚未配置",
      });
    }
    return this.config;
  }
}

function safeEqual(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

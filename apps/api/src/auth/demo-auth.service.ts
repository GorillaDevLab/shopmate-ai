import { createHash, timingSafeEqual } from "node:crypto";

import { verifyPassword } from "@shopmate/database";
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
import { UserAccountRepository } from "./user-account.repository.js";

export interface DemoLoginResult {
  readonly token: string;
  readonly expiresAt: string;
  readonly ttlSeconds: number;
  readonly secureCookie: boolean;
}

@Injectable()
export class DemoAuthService {
  constructor(
    @Inject(DEMO_AUTH_CONFIG)
    private readonly config: DemoAuthConfig | null,
    private readonly userAccounts: UserAccountRepository,
  ) {}

  usesSecureCookie(): boolean {
    return this.config?.secureCookie ?? false;
  }

  async login(input: LoginInputDto): Promise<DemoLoginResult> {
    const config = this.requireConfig();
    const email = input.email.trim().toLowerCase();

    // Keep the original Demo account as a temporary compatibility path.
    // Existing E2E fixtures and the current production Demo login continue
    // to work while database-backed accounts are rolled out.
    if (safeEqual(email, config.email)) {
      if (!safeEqual(input.password, config.password)) {
        throwInvalidCredentials();
      }

      return this.createSession(config.userId, config.merchantId, config);
    }

    const account = await this.userAccounts.findByEmail(email);

    if (!account || !verifyPassword(input.password, account.passwordHash)) {
      throwInvalidCredentials();
    }

    const [merchantId] = account.merchantIds;

    // The current login contract has no merchant selector.
    // Never silently choose one when an account belongs to multiple merchants.
    if (!merchantId || account.merchantIds.length !== 1) {
      throwInvalidCredentials();
    }

    return this.createSession(account.id, merchantId, config);
  }

  private createSession(
    userId: string,
    merchantId: string,
    config: DemoAuthConfig,
  ): DemoLoginResult {
    const context = createAuthContext({
      userId,
      merchantId,
      permissions: Object.values(AuthPermission),
    });

    const session = signDemoSession(context, config.sessionSecret, config.ttlSeconds);

    return {
      ...session,
      ttlSeconds: config.ttlSeconds,
      secureCookie: config.secureCookie,
    };
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

function throwInvalidCredentials(): never {
  throw new UnauthorizedException({
    statusCode: 401,
    ...createAuthError("INVALID_CREDENTIALS"),
  });
}

function safeEqual(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

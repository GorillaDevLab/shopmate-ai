import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  verifyPassword: vi.fn(),
}));

vi.mock("@shopmate/database", () => ({
  getPrismaClient: vi.fn(),
  verifyPassword: database.verifyPassword,
}));

import type { DemoAuthConfig } from "./demo-auth.config.js";
import { DemoAuthService } from "./demo-auth.service.js";
import { verifyDemoSession } from "./session/demo-session.js";
import type { UserAccountRepository } from "./user-account.repository.js";

const fixture = {
  legacy: ["demo", "credential", "2026"].join("-"),
  account: ["account", "credential", "2026"].join("-"),
  wrong: ["wrong", "credential", "2026"].join("-"),
  encoded: ["encoded", "fixture", "hash"].join("-"),
  session: ["test", "session", "fixture", "key", "with", "at", "least", "32", "characters"].join(
    "-",
  ),
} as const;

const config: DemoAuthConfig = {
  email: "owner@shopmate.co.nz",
  password: fixture.legacy,
  userId: "demo-user",
  merchantId: "demo-merchant",
  sessionSecret: fixture.session,
  ttlSeconds: 3600,
  secureCookie: false,
};

describe("DemoAuthService", () => {
  const findByEmail = vi.fn();

  beforeEach(() => {
    findByEmail.mockReset();
    database.verifyPassword.mockReset();
  });

  function createService() {
    return new DemoAuthService(config, {
      findByEmail,
    } as unknown as UserAccountRepository);
  }

  it("保留旧 Demo 账号登录且不查询数据库", async () => {
    const result = await createService().login({
      email: " OWNER@SHOPMATE.CO.NZ ",
      password: fixture.legacy,
    });

    expect(findByEmail).not.toHaveBeenCalled();
    expect(database.verifyPassword).not.toHaveBeenCalled();

    const session = verifyDemoSession(result.token, config.sessionSecret);

    expect(session?.context).toMatchObject({
      userId: "demo-user",
      merchantId: "demo-merchant",
    });
  });

  it("数据库账号通过密码和单一商家成员关系登录", async () => {
    findByEmail.mockResolvedValue({
      id: "demo-user-a",
      email: "demo-a@shopmate.test",
      passwordHash: fixture.encoded,
      merchantIds: ["analytics-demo-a"],
    });

    database.verifyPassword.mockReturnValue(true);

    const result = await createService().login({
      email: " Demo-A@ShopMate.Test ",
      password: fixture.account,
    });

    expect(findByEmail).toHaveBeenCalledWith("demo-a@shopmate.test");
    expect(database.verifyPassword).toHaveBeenCalledWith(fixture.account, fixture.encoded);

    const session = verifyDemoSession(result.token, config.sessionSecret);

    expect(session?.context).toMatchObject({
      userId: "demo-user-a",
      merchantId: "analytics-demo-a",
    });
  });

  it("数据库账号密码错误时拒绝登录", async () => {
    findByEmail.mockResolvedValue({
      id: "demo-user-a",
      email: "demo-a@shopmate.test",
      passwordHash: fixture.encoded,
      merchantIds: ["analytics-demo-a"],
    });

    database.verifyPassword.mockReturnValue(false);

    await expect(
      createService().login({
        email: "demo-a@shopmate.test",
        password: fixture.wrong,
      }),
    ).rejects.toMatchObject({
      status: 401,
    });
  });

  it("数据库账号不存在时拒绝登录", async () => {
    findByEmail.mockResolvedValue(null);

    await expect(
      createService().login({
        email: "missing@shopmate.test",
        password: fixture.account,
      }),
    ).rejects.toMatchObject({
      status: 401,
    });
  });

  it("没有启用商家时拒绝登录", async () => {
    findByEmail.mockResolvedValue({
      id: "demo-user-a",
      email: "demo-a@shopmate.test",
      passwordHash: fixture.encoded,
      merchantIds: [],
    });

    database.verifyPassword.mockReturnValue(true);

    await expect(
      createService().login({
        email: "demo-a@shopmate.test",
        password: fixture.account,
      }),
    ).rejects.toMatchObject({
      status: 401,
    });
  });

  it("多个启用商家时不会静默选择其中一个", async () => {
    findByEmail.mockResolvedValue({
      id: "multi-user",
      email: "multi@shopmate.test",
      passwordHash: fixture.encoded,
      merchantIds: ["analytics-demo-a", "analytics-demo-b"],
    });

    database.verifyPassword.mockReturnValue(true);

    await expect(
      createService().login({
        email: "multi@shopmate.test",
        password: fixture.account,
      }),
    ).rejects.toMatchObject({
      status: 401,
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  findUnique: vi.fn(),
}));

vi.mock("@shopmate/database", () => ({
  getPrismaClient: () => ({
    userAccount: {
      findUnique: database.findUnique,
    },
  }),
}));

import { UserAccountRepository } from "./user-account.repository.js";

describe("UserAccountRepository", () => {
  beforeEach(() => {
    database.findUnique.mockReset();
  });

  it("按规范化邮箱读取账号和启用商家成员关系", async () => {
    database.findUnique.mockResolvedValue({
      id: "demo-user-a",
      email: "demo-a@shopmate.test",
      passwordHash: "encoded-password",
      memberships: [
        {
          merchantId: "analytics-demo-a",
        },
      ],
    });

    const repository = new UserAccountRepository();

    await expect(repository.findByEmail(" Demo-A@ShopMate.Test ")).resolves.toEqual({
      id: "demo-user-a",
      email: "demo-a@shopmate.test",
      passwordHash: "encoded-password",
      merchantIds: ["analytics-demo-a"],
    });

    expect(database.findUnique).toHaveBeenCalledWith({
      where: {
        email: "demo-a@shopmate.test",
      },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        memberships: {
          where: {
            merchant: {
              status: "ACTIVE",
            },
          },
          select: {
            merchantId: true,
          },
          orderBy: {
            createdAt: "asc",
          },
        },
      },
    });
  });

  it("账号不存在时返回 null", async () => {
    database.findUnique.mockResolvedValue(null);

    const repository = new UserAccountRepository();

    await expect(repository.findByEmail("missing@shopmate.test")).resolves.toBeNull();
  });

  it("允许返回多个启用商家，由认证层决定如何处理", async () => {
    database.findUnique.mockResolvedValue({
      id: "multi-user",
      email: "multi@shopmate.test",
      passwordHash: "encoded-password",
      memberships: [
        {
          merchantId: "analytics-demo-a",
        },
        {
          merchantId: "analytics-demo-b",
        },
      ],
    });

    const repository = new UserAccountRepository();

    await expect(repository.findByEmail("multi@shopmate.test")).resolves.toMatchObject({
      merchantIds: ["analytics-demo-a", "analytics-demo-b"],
    });
  });
});

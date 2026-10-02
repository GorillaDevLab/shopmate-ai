import { Injectable } from "@nestjs/common";
import { getPrismaClient } from "@shopmate/database";

export interface LoginUserAccount {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly merchantIds: readonly string[];
}

@Injectable()
export class UserAccountRepository {
  async findByEmail(email: string): Promise<LoginUserAccount | null> {
    const normalizedEmail = email.trim().toLowerCase();

    const account = await getPrismaClient().userAccount.findUnique({
      where: {
        email: normalizedEmail,
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

    if (!account) {
      return null;
    }

    return {
      id: account.id,
      email: account.email,
      passwordHash: account.passwordHash,
      merchantIds: account.memberships.map((membership) => membership.merchantId),
    };
  }
}

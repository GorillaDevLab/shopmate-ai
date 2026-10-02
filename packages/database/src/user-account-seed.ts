import "dotenv/config";

import { disconnectPrismaClient, getPrismaClient } from "./index.js";
import { hashPassword, verifyPassword } from "./password-hash.js";
import { demoUserAccounts } from "./user-account-seed-data.js";

async function main(): Promise<void> {
  if (!process.argv.includes("--apply")) {
    printPreview();
    return;
  }

  if (process.env.DEMO_DATABASE_WRITE !== "isolated-demo-only") {
    throw new Error("先确认独立演示数据库并设置 DEMO_DATABASE_WRITE=isolated-demo-only");
  }

  const credentials = demoUserAccounts.map((account) => ({
    ...account,
    password: readPassword(account.passwordEnv),
  }));

  const prisma = getPrismaClient();

  await prisma.$transaction(async (tx) => {
    for (const account of credentials) {
      const merchant = await tx.merchant.findUnique({
        where: { id: account.merchantId },
        select: {
          id: true,
          status: true,
        },
      });

      if (!merchant) {
        throw new Error(`测试账号对应的商家不存在：${account.merchantId}`);
      }

      if (merchant.status !== "ACTIVE") {
        throw new Error(`测试账号对应的商家未启用：${account.merchantId}`);
      }

      const emailOwner = await tx.userAccount.findUnique({
        where: { email: account.email },
        select: { id: true },
      });

      if (emailOwner && emailOwner.id !== account.id) {
        throw new Error(`测试邮箱已被其他账号占用：${account.email}`);
      }

      const existing = await tx.userAccount.findUnique({
        where: { id: account.id },
        select: {
          passwordHash: true,
        },
      });

      const passwordHash =
        existing && verifyPassword(account.password, existing.passwordHash)
          ? existing.passwordHash
          : hashPassword(account.password);

      await tx.userAccount.upsert({
        where: { id: account.id },
        create: {
          id: account.id,
          email: account.email,
          passwordHash,
        },
        update: {
          email: account.email,
          passwordHash,
        },
      });

      await tx.userMerchantMembership.upsert({
        where: {
          userId_merchantId: {
            userId: account.id,
            merchantId: account.merchantId,
          },
        },
        create: {
          userId: account.id,
          merchantId: account.merchantId,
        },
        update: {},
      });
    }
  });

  process.stdout.write(`测试账号导入完成：${demoUserAccounts.length} 个用户。\n`);
}

function printPreview(): void {
  process.stdout.write(
    JSON.stringify(
      {
        dryRun: true,
        users: demoUserAccounts.map(({ id, email, merchantId, passwordEnv }) => ({
          id,
          email,
          merchantId,
          passwordEnv,
        })),
      },
      null,
      2,
    ) + "\n",
  );
}

function readPassword(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`缺少测试账号密码环境变量：${name}`);
  }

  if (value.length < 8 || value.length > 128) {
    throw new Error(`测试账号密码环境变量 ${name} 长度必须为 8 至 128 个字符`);
  }

  return value;
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `测试账号导入失败：${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  await disconnectPrismaClient();
}

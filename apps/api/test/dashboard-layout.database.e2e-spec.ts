import { randomUUID } from "node:crypto";

import { DEFAULT_DASHBOARD_LAYOUT, type DashboardLayout } from "@shopmate/contracts";
import { disconnectPrismaClient, getPrismaClient } from "@shopmate/database";
import { config as loadEnv } from "dotenv";
import { afterAll, describe, expect, it } from "vitest";

import { createAuthContext } from "../src/auth/contracts/index.js";
import { PrismaDashboardLayoutRepository } from "../src/dashboard-layout/dashboard-layout.repository.js";

loadEnv({ path: "../../packages/database/.env" });

const describeDatabase = process.env.RUN_K7_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const merchantId = "demo-merchant-cn";
const testUsers: string[] = [];

describeDatabase("K7 Prisma 布局并发与隔离", () => {
  const repository = new PrismaDashboardLayoutRepository();

  afterAll(async () => {
    await getPrismaClient().userDashboardLayout.deleteMany({
      where: { userId: { in: testUsers }, merchantId },
    });
    await disconnectPrismaClient();
  });

  it("同一版本的并发写入只允许一个成功", async () => {
    const context = testContext();
    await expect(repository.save(context, DEFAULT_DASHBOARD_LAYOUT, 0)).resolves.toMatchObject({
      kind: "saved",
      record: { revision: 1 },
    });

    const results = await Promise.all([
      repository.save(context, reorderedLayout(1), 1),
      repository.save(context, reorderedLayout(2), 1),
    ]);

    expect(results.map(({ kind }) => kind).sort()).toEqual(["conflict", "saved"]);
    await expect(repository.find(context)).resolves.toMatchObject({ revision: 2 });
  });

  it("相同商家的两个用户读取各自布局", async () => {
    const first = testContext();
    const second = testContext();
    await repository.save(first, reorderedLayout(1), 0);
    await repository.save(second, reorderedLayout(2), 0);

    await expect(repository.find(first)).resolves.toMatchObject({ layout: reorderedLayout(1) });
    await expect(repository.find(second)).resolves.toMatchObject({ layout: reorderedLayout(2) });
  });
});

function testContext() {
  const userId = `k7-${randomUUID()}`;
  testUsers.push(userId);
  return createAuthContext({ userId, merchantId, permissions: [] });
}

function reorderedLayout(offset: number): DashboardLayout {
  const cards = [...DEFAULT_DASHBOARD_LAYOUT.cards];
  return {
    ...DEFAULT_DASHBOARD_LAYOUT,
    cards: [...cards.slice(offset), ...cards.slice(0, offset)],
  };
}

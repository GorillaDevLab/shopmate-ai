import { getPrismaClient } from "@shopmate/database";

import type { AuthContext } from "../../auth/contracts/index.js";

export const ASSISTANT_MEMORY_REPOSITORY = Symbol("ASSISTANT_MEMORY_REPOSITORY");

export interface AssistantMemoryRecord {
  readonly id: string;
  readonly content: string;
  readonly createdAt: Date;
}

export interface AssistantMemoryRepository {
  list(context: AuthContext): Promise<AssistantMemoryRecord[]>;
  count(context: AuthContext): Promise<number>;
  /** 已存在相同内容时返回 null。 */
  create(context: AuthContext, content: string): Promise<AssistantMemoryRecord | null>;
  delete(context: AuthContext, id: string): Promise<boolean>;
  clear(context: AuthContext): Promise<void>;
}

const selection = { id: true, content: true, createdAt: true } as const;

export class PrismaAssistantMemoryRepository implements AssistantMemoryRepository {
  list(context: AuthContext): Promise<AssistantMemoryRecord[]> {
    return getPrismaClient().assistantMemory.findMany({
      where: owner(context),
      orderBy: { createdAt: "asc" },
      select: selection,
    });
  }

  count(context: AuthContext): Promise<number> {
    return getPrismaClient().assistantMemory.count({ where: owner(context) });
  }

  async create(context: AuthContext, content: string): Promise<AssistantMemoryRecord | null> {
    try {
      return await getPrismaClient().assistantMemory.create({
        data: { ...owner(context), content },
        select: selection,
      });
    } catch (error: unknown) {
      if (isUniqueConflict(error)) return null;
      throw error;
    }
  }

  async delete(context: AuthContext, id: string): Promise<boolean> {
    // 按 id + 用户 + 商家删除：别人的记忆 id 不会命中。
    const result = await getPrismaClient().assistantMemory.deleteMany({
      where: { id, ...owner(context) },
    });
    return result.count > 0;
  }

  async clear(context: AuthContext): Promise<void> {
    await getPrismaClient().assistantMemory.deleteMany({ where: owner(context) });
  }
}

function owner(context: AuthContext) {
  return { userId: context.userId, merchantId: context.merchantId };
}

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code: unknown }).code === "P2002"
  );
}

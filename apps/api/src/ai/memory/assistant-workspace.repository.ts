import { getPrismaClient } from "@shopmate/database";
import type { WorkspaceSnapshot } from "@shopmate/contracts";

import type { AuthContext } from "../../auth/contracts/index.js";

export const ASSISTANT_WORKSPACE_REPOSITORY = Symbol("ASSISTANT_WORKSPACE_REPOSITORY");

export interface AssistantWorkspaceRecord {
  readonly snapshot: unknown;
  readonly revision: number;
}

export type WorkspaceSaveResult =
  | { readonly kind: "saved"; readonly revision: number }
  | { readonly kind: "conflict" };

export interface AssistantWorkspaceRepository {
  find(context: AuthContext): Promise<AssistantWorkspaceRecord | null>;
  save(
    context: AuthContext,
    snapshot: WorkspaceSnapshot,
    expectedRevision: number,
  ): Promise<WorkspaceSaveResult>;
  delete(context: AuthContext): Promise<void>;
}

export class PrismaAssistantWorkspaceRepository implements AssistantWorkspaceRepository {
  find(context: AuthContext): Promise<AssistantWorkspaceRecord | null> {
    return getPrismaClient().userAssistantWorkspace.findUnique({
      where: { userId_merchantId: owner(context) },
      select: { snapshot: true, revision: true },
    });
  }

  async save(
    context: AuthContext,
    snapshot: WorkspaceSnapshot,
    expectedRevision: number,
  ): Promise<WorkspaceSaveResult> {
    const prisma = getPrismaClient();
    if (expectedRevision === 0) {
      try {
        const created = await prisma.userAssistantWorkspace.create({
          data: { ...owner(context), snapshot, revision: 1 },
          select: { revision: true },
        });
        return { kind: "saved", revision: created.revision };
      } catch (error: unknown) {
        if (isUniqueConflict(error)) return { kind: "conflict" };
        throw error;
      }
    }
    // 比较并交换：另一台设备先保存过时返回冲突，由客户端合并后重试。
    const updated = await prisma.userAssistantWorkspace.updateManyAndReturn({
      where: { ...owner(context), revision: expectedRevision },
      data: { snapshot, revision: { increment: 1 } },
      select: { revision: true },
    });
    const record = updated[0];
    return record ? { kind: "saved", revision: record.revision } : { kind: "conflict" };
  }

  async delete(context: AuthContext): Promise<void> {
    await getPrismaClient().userAssistantWorkspace.deleteMany({ where: owner(context) });
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

import { getPrismaClient } from "@shopmate/database";
import type { AnalyticsLayout } from "@shopmate/contracts";

import type { AuthContext } from "../auth/contracts/index.js";

export const ANALYTICS_LAYOUT_REPOSITORY = Symbol("ANALYTICS_LAYOUT_REPOSITORY");

export interface AnalyticsLayoutRecord {
  readonly layout: unknown;
  readonly revision: number;
  readonly updatedAt: Date;
}

export type AnalyticsLayoutSaveResult =
  | { readonly kind: "saved"; readonly record: AnalyticsLayoutRecord }
  | { readonly kind: "conflict" };

export interface AnalyticsLayoutRepository {
  find(context: AuthContext): Promise<AnalyticsLayoutRecord | null>;
  save(
    context: AuthContext,
    layout: AnalyticsLayout,
    expectedRevision: number,
  ): Promise<AnalyticsLayoutSaveResult>;
}

const recordSelection = { layout: true, revision: true, updatedAt: true } as const;

export class PrismaAnalyticsLayoutRepository implements AnalyticsLayoutRepository {
  async find(context: AuthContext): Promise<AnalyticsLayoutRecord | null> {
    return getPrismaClient().userAnalyticsLayout.findUnique({
      where: { userId_merchantId: identityKey(context) },
      select: recordSelection,
    });
  }

  async save(
    context: AuthContext,
    layout: AnalyticsLayout,
    expectedRevision: number,
  ): Promise<AnalyticsLayoutSaveResult> {
    if (expectedRevision === 0) return this.create(context, layout);
    // 按 revision 做比较并交换：另一台设备先保存过时不覆盖，返回冲突。
    const updated = await getPrismaClient().userAnalyticsLayout.updateManyAndReturn({
      where: { ...identityKey(context), revision: expectedRevision },
      data: { layout, schemaVersion: layout.version, revision: { increment: 1 } },
      select: recordSelection,
    });
    const record = updated[0];
    return record ? { kind: "saved", record } : { kind: "conflict" };
  }

  private async create(
    context: AuthContext,
    layout: AnalyticsLayout,
  ): Promise<AnalyticsLayoutSaveResult> {
    try {
      const record = await getPrismaClient().userAnalyticsLayout.create({
        data: { ...identityKey(context), schemaVersion: layout.version, revision: 1, layout },
        select: recordSelection,
      });
      return { kind: "saved", record };
    } catch (error: unknown) {
      if (isUniqueConflict(error)) return { kind: "conflict" };
      throw error;
    }
  }
}

function identityKey(context: AuthContext) {
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

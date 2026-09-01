import { getPrismaClient } from "@shopmate/database";
import type { DashboardLayout } from "@shopmate/contracts";

import type { AuthContext } from "../auth/contracts/index.js";

export const DASHBOARD_LAYOUT_REPOSITORY = Symbol("DASHBOARD_LAYOUT_REPOSITORY");

export interface DashboardLayoutRecord {
  readonly layout: unknown;
  readonly revision: number;
  readonly updatedAt: Date;
}

export type DashboardLayoutSaveResult =
  | { readonly kind: "saved"; readonly record: DashboardLayoutRecord }
  | { readonly kind: "conflict" };

export interface DashboardLayoutRepository {
  find(context: AuthContext): Promise<DashboardLayoutRecord | null>;
  save(
    context: AuthContext,
    layout: DashboardLayout,
    expectedRevision: number,
  ): Promise<DashboardLayoutSaveResult>;
}

const recordSelection = { layout: true, revision: true, updatedAt: true } as const;

export class PrismaDashboardLayoutRepository implements DashboardLayoutRepository {
  async find(context: AuthContext): Promise<DashboardLayoutRecord | null> {
    return getPrismaClient().userDashboardLayout.findUnique({
      where: { userId_merchantId: identityKey(context) },
      select: recordSelection,
    });
  }

  async save(
    context: AuthContext,
    layout: DashboardLayout,
    expectedRevision: number,
  ): Promise<DashboardLayoutSaveResult> {
    if (expectedRevision === 0) return this.create(context, layout);
    const prisma = getPrismaClient();
    // Returning the updated row from the same SQL statement prevents a later writer
    // from changing the response between the compare-and-swap and result read.
    const updated = await prisma.userDashboardLayout.updateManyAndReturn({
      where: { ...identityKey(context), revision: expectedRevision },
      data: { layout, schemaVersion: layout.version, revision: { increment: 1 } },
      select: recordSelection,
    });
    const record = updated[0];
    return record ? { kind: "saved", record } : { kind: "conflict" };
  }

  private async create(
    context: AuthContext,
    layout: DashboardLayout,
  ): Promise<DashboardLayoutSaveResult> {
    try {
      const record = await getPrismaClient().userDashboardLayout.create({
        data: {
          ...identityKey(context),
          schemaVersion: layout.version,
          revision: 1,
          layout,
        },
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

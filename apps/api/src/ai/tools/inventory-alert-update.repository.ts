import { getPrismaClient } from "@shopmate/database";

import type { InventoryAlertSkuSnapshot } from "@shopmate/contracts";

export interface ConfirmInventoryAlertThresholdInput {
  readonly merchantId: string;
  readonly skuId: string;

  readonly expectedAlertThreshold: number;
  readonly expectedSkuUpdatedAt: string;

  readonly targetAlertThreshold: number;
}

export type ConfirmInventoryAlertThresholdResult =
  | {
      readonly kind: "CONFIRMED";
      readonly skuId: string;
      readonly previousAlertThreshold: number;
      readonly newAlertThreshold: number;
    }
  | {
      readonly kind: "CONFLICT";
      readonly skuId: string;
      readonly actualAlertThreshold: number;
      readonly actualSkuUpdatedAt: string;
    }
  | {
      readonly kind: "NOT_FOUND";
    };

export interface InventoryAlertUpdateRepository {
  findSkuSnapshot(merchantId: string, skuId: string): Promise<InventoryAlertSkuSnapshot | null>;

  confirmAlertThreshold(
    input: ConfirmInventoryAlertThresholdInput,
  ): Promise<ConfirmInventoryAlertThresholdResult>;
}

export class PrismaInventoryAlertUpdateRepository implements InventoryAlertUpdateRepository {
  async findSkuSnapshot(
    merchantId: string,
    skuId: string,
  ): Promise<InventoryAlertSkuSnapshot | null> {
    const row = await getPrismaClient().sku.findFirst({
      where: {
        id: skuId,
        merchantId,
      },
      select: {
        id: true,
        alertThreshold: true,
        updatedAt: true,
      },
    });

    if (!row) {
      return null;
    }

    return {
      skuId: row.id,
      alertThreshold: row.alertThreshold,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async confirmAlertThreshold(
    input: ConfirmInventoryAlertThresholdInput,
  ): Promise<ConfirmInventoryAlertThresholdResult> {
    const prisma = getPrismaClient();

    return prisma.$transaction(async (transaction) => {
      const current = await transaction.sku.findFirst({
        where: {
          id: input.skuId,
          merchantId: input.merchantId,
        },
        select: {
          id: true,
          alertThreshold: true,
          updatedAt: true,
        },
      });

      if (!current) {
        return {
          kind: "NOT_FOUND",
        };
      }

      const currentUpdatedAt = current.updatedAt.toISOString();

      if (
        current.alertThreshold !== input.expectedAlertThreshold ||
        currentUpdatedAt !== input.expectedSkuUpdatedAt
      ) {
        return {
          kind: "CONFLICT",
          skuId: current.id,
          actualAlertThreshold: current.alertThreshold,
          actualSkuUpdatedAt: currentUpdatedAt,
        };
      }

      const updated = await transaction.sku.updateMany({
        where: {
          id: input.skuId,
          merchantId: input.merchantId,
          alertThreshold: input.expectedAlertThreshold,
          updatedAt: new Date(input.expectedSkuUpdatedAt),
        },
        data: {
          alertThreshold: input.targetAlertThreshold,
        },
      });

      if (updated.count !== 1) {
        const latest = await transaction.sku.findFirst({
          where: {
            id: input.skuId,
            merchantId: input.merchantId,
          },
          select: {
            id: true,
            alertThreshold: true,
            updatedAt: true,
          },
        });

        if (!latest) {
          return {
            kind: "NOT_FOUND",
          };
        }

        return {
          kind: "CONFLICT",
          skuId: latest.id,
          actualAlertThreshold: latest.alertThreshold,
          actualSkuUpdatedAt: latest.updatedAt.toISOString(),
        };
      }

      return {
        kind: "CONFIRMED",
        skuId: current.id,
        previousAlertThreshold: current.alertThreshold,
        newAlertThreshold: input.targetAlertThreshold,
      };
    });
  }
}

import { ForbiddenException, NotFoundException } from "@nestjs/common";
import {
  GetInventoryRisksTool,
  GetProductDetailsTool,
  type ProductDetail,
} from "@shopmate/contracts";

import { LowStockService, type LowStockAnalysisResult } from "../../analytics/low-stock.service.js";
import { AuthPermission } from "../../auth/contracts/auth-context.js";
import { ProductService } from "../../products/product.service.js";

import type { ToolInvocationContext, ToolRegistration } from "./tool-registry.js";

type ProductDetailsInput = ReturnType<typeof GetProductDetailsTool.input.parse>;
type ProductDetailsOutput = ReturnType<typeof GetProductDetailsTool.output.parse>;
type InventoryRisksInput = ReturnType<typeof GetInventoryRisksTool.input.parse>;
type InventoryRisksOutput = ReturnType<typeof GetInventoryRisksTool.output.parse>;

type ProductReader = Pick<ProductService, "findById">;
type InventoryReader = Pick<LowStockService, "analyze">;

export function createProductDetailsToolRegistration(
  productService: ProductReader,
): ToolRegistration<ProductDetailsInput, ProductDetailsOutput> {
  return {
    ...GetProductDetailsTool,
    requiredPermissions: [AuthPermission.ProductsRead],
    handler: async (input, context) => readProductDetails(productService, input, context),
  };
}

export function createInventoryRisksToolRegistration(
  lowStockService: InventoryReader,
): ToolRegistration<InventoryRisksInput, InventoryRisksOutput> {
  return {
    ...GetInventoryRisksTool,
    requiredPermissions: [AuthPermission.ProductsRead, AuthPermission.OrdersRead],
    handler: async (input, context) => readInventoryRisks(lowStockService, input, context),
  };
}

async function readProductDetails(
  service: ProductReader,
  input: ProductDetailsInput,
  context: Readonly<ToolInvocationContext>,
): Promise<ProductDetailsOutput> {
  try {
    const product = await service.findById(context, { productId: input.productId });
    return GetProductDetailsTool.output.parse({ status: "ok", data: mapProduct(product) });
  } catch (error: unknown) {
    return GetProductDetailsTool.output.parse(toSafeError(error, "商品详情暂时无法读取。"));
  }
}

async function readInventoryRisks(
  service: InventoryReader,
  input: InventoryRisksInput,
  context: Readonly<ToolInvocationContext>,
): Promise<InventoryRisksOutput> {
  try {
    const result = await service.analyze(context, input.endDate, input.startDate);
    if (result.risks.length === 0) return inventoryEmptyResult();
    return GetInventoryRisksTool.output.parse({
      status: "ok",
      data: mapInventoryRisks(result, input.limit),
    });
  } catch (error: unknown) {
    return GetInventoryRisksTool.output.parse(toSafeError(error, "库存风险暂时无法读取。"));
  }
}

function mapProduct(product: ProductDetail) {
  return {
    source: "ProductService" as const,
    productId: product.id,
    name: product.name,
    status: product.status,
    priceMinor: product.price.amountMinor,
    currency: product.price.currency,
    totalInventory: product.totalInventory,
    skus: product.skus.map((sku) => ({
      skuId: sku.id,
      code: sku.code,
      inventory: sku.inventory,
      alertThreshold: sku.alertThreshold,
    })),
  };
}

function mapInventoryRisks(result: LowStockAnalysisResult, limit: number) {
  return {
    source: "LowStockService" as const,
    period: {
      startDate: result.window.startDate,
      endDate: result.window.endDate,
      timezone: "Asia/Shanghai" as const,
    },
    items: result.risks.slice(0, limit).map((risk) => ({
      productId: risk.productId,
      productName: risk.productName,
      skuId: risk.skuId,
      skuCode: risk.code,
      inventory: risk.inventory,
      alertThreshold: risk.alertThreshold,
      soldUnits: risk.soldUnits7d,
      averageDailyUnits: risk.averageDailyUnits,
      daysToStockout: risk.daysToStockout,
      riskLevel: risk.level,
    })),
  };
}

function inventoryEmptyResult(): InventoryRisksOutput {
  return GetInventoryRisksTool.output.parse({
    status: "empty",
    reason: "NO_DATA",
    message: "指定范围内没有低库存风险。",
  });
}

function toSafeError(error: unknown, unavailableMessage: string) {
  if (error instanceof NotFoundException) {
    return safeError("NOT_FOUND", "未找到当前商家范围内的资源。", false);
  }
  if (error instanceof ForbiddenException) {
    return safeError("FORBIDDEN", "当前身份无权读取该资源。", false);
  }
  return safeError("UNAVAILABLE", unavailableMessage, true);
}

function safeError(
  code: "NOT_FOUND" | "FORBIDDEN" | "UNAVAILABLE",
  message: string,
  retryable: boolean,
) {
  return { status: "error" as const, error: { code, message, retryable } };
}

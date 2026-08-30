import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  ProductDetailParamsSchema,
  ProductDetailSchema,
  ProductListQuerySchema,
  ProductListResponseSchema,
  type ProductDetail,
  type ProductListResponse,
  type ProductSummary,
} from "@shopmate/contracts";

import type { AuthContext } from "../auth/contracts/index.js";
import {
  PRODUCT_REPOSITORY,
  type ProductRecord,
  type ProductRepository,
} from "./product.repository.js";

@Injectable()
export class ProductService {
  constructor(@Inject(PRODUCT_REPOSITORY) private readonly repository: ProductRepository) {}

  async list(context: AuthContext, rawQuery: unknown): Promise<ProductListResponse> {
    const parsedQuery = ProductListQuerySchema.safeParse(rawQuery);
    if (!parsedQuery.success) throwInvalidInput();

    try {
      const page = await this.repository.list(context, parsedQuery.data);
      return ProductListResponseSchema.parse({
        items: page.rows.map(toSummary),
        pagination: {
          page: parsedQuery.data.page,
          pageSize: parsedQuery.data.pageSize,
          total: page.total,
          totalPages: Math.ceil(page.total / parsedQuery.data.pageSize),
        },
      });
    } catch (error) {
      throwProductServiceError(error);
    }
  }

  async findById(context: AuthContext, rawParams: unknown): Promise<ProductDetail> {
    const parsedParams = ProductDetailParamsSchema.safeParse(rawParams);
    if (!parsedParams.success) throwInvalidInput();

    try {
      const product = await this.repository.findById(context, parsedParams.data.productId);
      if (!product) throwResourceNotFound();
      return ProductDetailSchema.parse(toDetail(product));
    } catch (error) {
      throwProductServiceError(error);
    }
  }
}

function toSummary(product: ProductRecord): ProductSummary {
  return {
    id: product.id,
    name: product.name,
    status: product.status,
    price: toMoney(product.price, product.currency),
    totalInventory: product.skus.reduce((total, sku) => total + sku.inventory, 0),
    skuCount: product.skus.length,
    updatedAt: product.updatedAt.toISOString(),
  };
}

function toDetail(product: ProductRecord): ProductDetail {
  return {
    ...toSummary(product),
    description: product.description ?? "暂无描述",
    features: toTextArray(product.features),
    sellingPoints: toTextArray(product.sellingPoints),
    skus: product.skus.map((sku) => ({
      id: sku.id,
      code: sku.code,
      inventory: sku.inventory,
      cost: toMoney(sku.cost, product.currency),
      alertThreshold: sku.alertThreshold,
      isLowStock: sku.inventory <= sku.alertThreshold,
    })),
    createdAt: product.createdAt.toISOString(),
  };
}

function toMoney(value: string, currency: string): { amountMinor: number; currency: "CNY" } {
  if (currency !== "CNY") throw new Error("数据库币种不受支持");
  const match = /^(\d+)(?:\.(\d{1,2}))?$/u.exec(value.trim());
  if (!match) throw new Error("数据库金额格式无效");
  const amountMinor = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(amountMinor)) throw new Error("数据库金额超出安全范围");
  return { amountMinor, currency: "CNY" };
}

function toTextArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : [];
}

function throwInvalidInput(): never {
  throw new BadRequestException({
    statusCode: 400,
    error: "请求参数无效",
    message: "请求参数校验失败",
  });
}

function throwResourceNotFound(): never {
  throw new NotFoundException({
    statusCode: 404,
    code: "RESOURCE_NOT_FOUND",
    message: "资源不存在",
  });
}

function throwProductServiceError(error: unknown): never {
  if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
  throw new ServiceUnavailableException({
    statusCode: 503,
    code: "PRODUCT_SERVICE_UNAVAILABLE",
    message: "商品服务暂不可用",
  });
}

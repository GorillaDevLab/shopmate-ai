import { ConnectorProductSchema, type ConnectorProduct } from "@shopmate/contracts";
import { openingTime, type MockConfig } from "./mock-config.js";
import { seededInteger } from "./mock-random.js";

const categories = [
  "手机壳",
  "充电器",
  "充电宝",
  "键盘",
  "鼠标",
  "耳机",
  "钢化膜",
  "USB扩展坞",
  "数据线",
  "支架",
];
const colors = ["黑色", "白色", "蓝色"];

export interface CatalogEntry {
  readonly product: ConnectorProduct;
  readonly launchAt: string;
  readonly weightGrams: number;
  readonly safetyStock: number;
  readonly leadTimeDays: number;
}

export function sourceAt(at: string, missingCost = false): ConnectorProduct["source"] {
  return {
    version: "mock-v1",
    updatedAt: at,
    quality: {
      state: missingCost ? "PARTIAL" : "COMPLETE",
      issues: missingCost ? ["COST_MISSING"] : [],
    },
  };
}

function catalogEntry(config: MockConfig, index: number): CatalogEntry {
  const id = `${config.binding.externalStoreId}:product:${index}`;
  const launchAt = new Date(openingTime(config)).toISOString();
  const base = 1900 + seededInteger(config.seed, ["catalog", index, "price"], 15_000);
  const missingCost = config.profile === "new" && index % 12 === 0;
  const skus = Array.from({ length: config.variantsPerProduct }, (_, variant) => ({
    externalSkuId: `${id}:sku:${variant}`,
    externalProductId: id,
    attributes: [{ name: "颜色", value: colors[variant]! }],
    salePriceMinor: base + variant * 100,
    costPriceMinor: missingCost ? null : Math.floor((base * (40 + (index % 30))) / 100),
    originalPriceMinor: base + 1000,
    status: "ACTIVE" as const,
  }));
  const product = ConnectorProductSchema.parse({
    externalStoreId: config.binding.externalStoreId,
    source: sourceAt(launchAt, missingCost),
    externalProductId: id,
    title: `演示 ${categories[index % categories.length]} ${index + 1}`,
    description: "合成经营商品",
    category: categories[index % categories.length],
    brand: "合成品牌",
    status: "ACTIVE",
    skus,
  });
  return Object.freeze({
    product,
    launchAt,
    weightGrams: 50 + index * 10,
    safetyStock: 10 + (index % 20),
    leadTimeDays: 2 + (index % 6),
  });
}

export function generateCatalog(config: MockConfig): readonly CatalogEntry[] {
  return Object.freeze(
    Array.from({ length: config.productCount }, (_, index) => catalogEntry(config, index)),
  );
}

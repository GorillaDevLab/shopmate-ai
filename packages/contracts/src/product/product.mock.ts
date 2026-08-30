import {
  ProductDetailSchema,
  ProductListResponseSchema,
  type ProductDetail,
  type ProductSummary,
} from "./product.schema.js";

const rawProductDetails = [
  {
    id: "demo-product-001",
    name: "云感纯棉短袖T恤",
    description: "柔软亲肤的基础款纯棉短袖，适合通勤、居家和日常休闲穿着。",
    features: ["100%纯棉", "宽松版型", "透气亲肤"],
    sellingPoints: ["基础百搭", "高性价比", "春夏热销"],
    status: "ACTIVE",
    price: { amountMinor: 7_900, currency: "CNY" },
    totalInventory: 120,
    skuCount: 1,
    skus: [
      {
        id: "demo-sku-001",
        code: "CN-DEMO-001",
        inventory: 120,
        cost: { amountMinor: 2_800, currency: "CNY" },
        alertThreshold: 25,
        isLowStock: false,
      },
    ],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  },
  {
    id: "demo-product-002",
    name: "便携榨汁杯",
    description: "USB 充电便携榨汁杯，可用于制作果汁、奶昔等日常饮品。",
    features: ["USB充电", "便携杯身", "食品级材质"],
    sellingPoints: ["办公室适用", "随身榨汁", "年轻用户热门"],
    status: "ACTIVE",
    price: { amountMinor: 12_900, currency: "CNY" },
    totalInventory: 14,
    skuCount: 2,
    skus: [
      {
        id: "demo-sku-002-white",
        code: "CN-DEMO-002-WHITE",
        inventory: 9,
        cost: { amountMinor: 5_200, currency: "CNY" },
        alertThreshold: 12,
        isLowStock: true,
      },
      {
        id: "demo-sku-002-green",
        code: "CN-DEMO-002-GREEN",
        inventory: 5,
        cost: { amountMinor: 5_200, currency: "CNY" },
        alertThreshold: 8,
        isLowStock: true,
      },
    ],
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  },
  {
    id: "demo-product-003",
    name: "无线蓝牙耳机",
    description: "面向日常通勤和影音娱乐使用的真无线蓝牙耳机。",
    features: ["蓝牙连接", "触控操作", "便携充电仓"],
    sellingPoints: ["通勤娱乐", "年轻用户热门", "高客单商品"],
    status: "INACTIVE",
    price: { amountMinor: 19_900, currency: "CNY" },
    totalInventory: 5,
    skuCount: 1,
    skus: [
      {
        id: "demo-sku-003",
        code: "CN-DEMO-003",
        inventory: 5,
        cost: { amountMinor: 8_800, currency: "CNY" },
        alertThreshold: 10,
        isLowStock: true,
      },
    ],
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  },
] satisfies readonly ProductDetail[];

export const mockProductDetails = ProductDetailSchema.array().parse(rawProductDetails);

const toSummary = (product: ProductDetail): ProductSummary => ({
  id: product.id,
  name: product.name,
  status: product.status,
  price: product.price,
  totalInventory: product.totalInventory,
  skuCount: product.skuCount,
  updatedAt: product.updatedAt,
});

export const mockProductListResponse = ProductListResponseSchema.parse({
  items: mockProductDetails.map(toSummary),
  pagination: {
    page: 1,
    pageSize: 20,
    total: mockProductDetails.length,
    totalPages: 1,
  },
});

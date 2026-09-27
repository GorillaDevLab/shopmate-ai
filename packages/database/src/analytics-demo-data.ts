import { demoProducts } from "./seed-data.js";

const dayMs = 86400000;
const outlets = [
  ["北京朝阳店", "OFFLINE"],
  ["北京海淀店", "OFFLINE"],
  ["北京西城店", "OFFLINE"],
  ["淘宝旗舰店", "TAOBAO"],
  ["抖音旗舰店", "DOUYIN"],
  ["小红书店", "XIAOHONGSHU"],
] as const;

export function createAnalyticsDemo(asOf: string) {
  const end = Date.parse(`${asOf}T04:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(asOf) ||
    !Number.isFinite(end) ||
    new Date(end).toISOString().slice(0, 10) !== asOf
  )
    throw new Error("需要有效的 YYYY-MM-DD 日期");
  return ["a", "b"].map((key) => createTenant(key, end));
}

function createTenant(key: string, end: number) {
  const id = `analytics-demo-${key}`;
  const products = Array.from({ length: 30 }, (_, index) => ({
    id: `${id}-product-${index}`,
    name: `${demoProducts[index % demoProducts.length].name} · ${Math.floor(index / 10) + 1}款`,
    priceCents: 1900 + index * 1370,
  }));
  const skus = products.flatMap((product, index) =>
    [0, 1].map((variant) => ({
      id: `${product.id}-sku-${variant}`,
      productId: product.id,
      code: `${id}-SKU-${index}-${variant}`,
      inventory: index % 7 === 0 ? variant * 3 : 20 + index * 7,
      alertThreshold: 10,
      costCents: Math.round(product.priceCents * 0.55),
    })),
  );
  const stores = outlets.map(([name, platform], index) => ({
    id: `${id}-store-${index}`,
    name: `【演示】${name}`,
    platform,
    city: "北京",
  }));
  const orders = Array.from({ length: 3000 }, (_, index) =>
    createOrder(id, index, end, products, key === "a" ? 0 : 7),
  );
  return {
    id,
    slug: id,
    name: `【演示】多渠道商家 ${key.toUpperCase()}`,
    stores,
    products,
    skus,
    orders,
  };
}

function createOrder(
  id: string,
  index: number,
  end: number,
  products: readonly { id: string; priceCents: number }[],
  shift: number,
) {
  const offset = Math.floor((index * 180) / 3000);
  // Keep one truly empty business day for empty-state demos.
  const date = new Date(end - (offset === 45 ? 44 : offset) * dayMs);
  const weekend = [0, 6].includes(date.getUTCDay()) ? 2 : 1;
  const items = [0, 1].map((item) => {
    const product = products[(index * 7 + item * 11 + shift) % products.length];
    return {
      id: `${id}-order-${index}-item-${item}`,
      skuId: `${product.id}-sku-${index % 2}`,
      quantity:
        weekend + (index % 6 < 3 ? Math.floor((180 - offset) / 60) : Math.floor(offset / 60)),
      unitCents: product.priceCents,
    };
  });
  return {
    id: `${id}-order-${index}`,
    orderNo: `ANALYTICS-DEMO-${index}`,
    storeId: `${id}-store-${index % 6}`,
    orderedAt: date.toISOString(),
    status: index % 19 === 0 ? ("CANCELLED" as const) : ("PAID" as const),
    totalCents: items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0),
    items,
  };
}

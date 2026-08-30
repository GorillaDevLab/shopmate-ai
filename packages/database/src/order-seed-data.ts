import { demoProducts } from "./seed-data.js";

export type DemoOrderItem = {
  id: string;
  skuId: string;
  quantity: number;
  unitPrice: string;
  lineAmount: string;
};

export type DemoOrder = {
  id: string;
  orderNo: string;
  orderedAt: string;
  status: "PAID" | "CANCELLED";
  totalAmount: string;
  items: DemoOrderItem[];
};

function moneyToCents(value: string): number {
  const [yuan, decimal = ""] = value.split(".");
  const normalizedDecimal = decimal.padEnd(2, "0").slice(0, 2);

  return Number(yuan) * 100 + Number(normalizedDecimal);
}

function centsToMoney(value: number): string {
  return (value / 100).toFixed(2);
}

function createItem(
  orderIndex: number,
  itemIndex: number,
  productIndex: number,
  quantity: number,
): DemoOrderItem {
  const product = demoProducts[productIndex];

  const unitPriceCents = moneyToCents(product.price);
  const lineAmountCents = unitPriceCents * quantity;

  return {
    id: `demo-order-item-${String(orderIndex).padStart(2, "0")}-${itemIndex}`,
    skuId: product.sku.id,
    quantity,
    unitPrice: product.price,
    lineAmount: centsToMoney(lineAmountCents),
  };
}

function calculateTotal(items: DemoOrderItem[]): string {
  const totalCents = items.reduce((total, item) => total + moneyToCents(item.lineAmount), 0);

  return centsToMoney(totalCents);
}

export const demoOrders: DemoOrder[] = Array.from({ length: 30 }, (_, index) => {
  const day = index + 1;

  let primaryQuantity: number;
  let secondaryQuantity: number;

  if (day <= 10) {
    // 1–10 日：整体上涨
    primaryQuantity = day;
    secondaryQuantity = Math.ceil(day / 2);
  } else if (day <= 20) {
    // 11–20 日：维持高位，制造热销样本
    primaryQuantity = 8;
    secondaryQuantity = 6;
  } else {
    // 21–30 日：整体下降
    primaryQuantity = 31 - day;
    secondaryQuantity = Math.ceil((31 - day) / 2);
  }

  const items = [
    // T 恤作为主要热销商品
    createItem(day, 1, 0, primaryQuantity),

    // 猫砂作为第二个稳定热销商品
    createItem(day, 2, 8, secondaryQuantity),
  ];

  // 固定取消第 7、17、27 天订单
  const status = day === 7 || day === 17 || day === 27 ? "CANCELLED" : "PAID";

  return {
    id: `demo-order-${String(day).padStart(2, "0")}`,
    orderNo: `DEMO-ORDER-202608${String(day).padStart(2, "0")}`,
    orderedAt: `2026-08-${String(day).padStart(2, "0")}T12:00:00.000Z`,
    status,
    totalAmount: calculateTotal(items),
    items,
  };
});

export function calculateEffectiveSales(orders: DemoOrder[]): string {
  const totalCents = orders
    .filter((order) => order.status !== "CANCELLED")
    .reduce((total, order) => total + moneyToCents(order.totalAmount), 0);

  return centsToMoney(totalCents);
}

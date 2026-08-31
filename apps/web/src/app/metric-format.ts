import type { DashboardMetric } from "@shopmate/contracts";

const currency = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  currencyDisplay: "narrowSymbol",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const integer = new Intl.NumberFormat("zh-CN");
const percent = new Intl.NumberFormat("zh-CN", {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function formatMetricValue({ key, value }: DashboardMetric): string {
  if (value === null) return "暂无数据";
  if (key === "orders") return `${integer.format(value)} 单`;
  if (key === "units") return `${integer.format(value)} 件`;
  // 避免安全整数上界的“分”转为浮点元时丢失分位精度。
  const minor = BigInt(value);
  const scale = BigInt(100);
  return currency
    .formatToParts(minor / scale)
    .map((part) => (part.type === "fraction" ? String(minor % scale).padStart(2, "0") : part.value))
    .join("");
}

export function formatMetricChange(ratio: number | null): string {
  if (ratio === null) return "暂无可比数据";
  if (ratio === 0) return "— 持平 0.0%";
  const direction = ratio > 0 ? "↑ 上升" : "↓ 下降";
  const magnitude = Math.abs(ratio);
  if (magnitude < 0.001) return `${direction}不足 0.1%`;
  return `${direction} ${percent.format(magnitude)}`;
}

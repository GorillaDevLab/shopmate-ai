import type { DashboardInventoryAlert, DashboardStockForecast } from "@shopmate/contracts";
import { ProductPanelFrame, type ProductPanelState } from "./product-panel-frame";

const count = new Intl.NumberFormat("zh-CN");
const days = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });

export function LowInventoryPanel({
  items,
  state = "ready",
  periodLabel = "近 7 天",
}: {
  items: readonly DashboardInventoryAlert[];
  state?: ProductPanelState;
  periodLabel?: string;
}) {
  return (
    <ProductPanelFrame
      title="库存提醒"
      emptyText="暂无低库存提醒"
      state={state}
      count={items.length}
    >
      <p className="mt-1 text-xs text-app-muted">当前库存 · 按{periodLabel}销量估算</p>
      <ul role="list" className="mt-2">
        {items.map((item) => (
          <InventoryItem key={item.sku} item={item} periodLabel={periodLabel} />
        ))}
      </ul>
    </ProductPanelFrame>
  );
}

function InventoryItem({
  item,
  periodLabel,
}: {
  item: DashboardInventoryAlert;
  periodLabel: string;
}) {
  return (
    <li className="inventory-row">
      <div className="min-w-0 break-words [overflow-wrap:anywhere] xl:flex xl:flex-wrap xl:items-baseline xl:gap-x-3">
        <h3 className="text-sm font-bold">{item.name}</h3>
        <p className="mt-1 text-xs text-app-muted xl:mt-0">SKU：{item.sku}</p>
      </div>
      <div className="inventory-stock break-all text-xs tabular-nums">
        <p className="font-semibold">剩余 {count.format(item.inventory)} 件</p>
        <p className="mt-1 text-app-muted">
          {periodLabel}销量：
          {item.recentSold === null ? "暂无数据" : `${count.format(item.recentSold)} 件`}
        </p>
      </div>
      <p className="break-all text-xs font-medium text-warning">{forecastText(item.forecast)}</p>
    </li>
  );
}

function forecastText(forecast: DashboardStockForecast): string {
  switch (forecast.status) {
    case "out_of_stock":
      return "已售罄";
    case "no_sales":
      return "暂无销量，无法估算";
    case "insufficient_data":
      return "数据不足，无法估算";
    case "estimated":
      return forecast.days < 0.1
        ? "预计不足 0.1 天售罄"
        : `预计约 ${days.format(forecast.days)} 天售罄`;
  }
}

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
      <ul role="list" className="mt-3 grid gap-3 lg:grid-cols-2 lg:gap-2">
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
    <li className="min-w-0 rounded-2xl border border-app-line p-3 lg:p-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 break-words [overflow-wrap:anywhere]">
          <h3 className="text-sm font-bold">{item.name}</h3>
          <p className="mt-1 text-xs text-app-muted">SKU：{item.sku}</p>
        </div>
        <span
          aria-hidden="true"
          className="grid size-7 shrink-0 place-items-center rounded-lg bg-amber-100 text-amber-800"
        >
          !
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 break-all text-xs tabular-nums lg:mt-1">
        <p>剩余 {count.format(item.inventory)} 件</p>
        <p className="text-app-muted">
          {periodLabel}销量：
          {item.recentSold === null ? "暂无数据" : `${count.format(item.recentSold)} 件`}
        </p>
      </div>
      <p className="mt-2 break-all text-xs font-bold text-amber-800 lg:mt-1">
        {forecastText(item.forecast)}
      </p>
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

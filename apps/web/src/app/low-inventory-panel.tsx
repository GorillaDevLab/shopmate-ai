import type { DashboardInventoryAlert, DashboardStockForecast } from "@shopmate/contracts";
import { ProductPanelFrame, type ProductPanelState } from "./product-panel-frame";

const count = new Intl.NumberFormat("zh-CN");
const days = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });

export function LowInventoryPanel({
  items,
  state = "ready",
}: {
  items: readonly DashboardInventoryAlert[];
  state?: ProductPanelState;
}) {
  return (
    <ProductPanelFrame
      title="库存提醒"
      emptyText="暂无低库存提醒"
      state={state}
      count={items.length}
    >
      <ul role="list" className="mt-4 grid gap-3 lg:grid-cols-2 lg:gap-2">
        {items.map((item) => (
          <InventoryItem key={item.sku} item={item} />
        ))}
      </ul>
    </ProductPanelFrame>
  );
}

function InventoryItem({ item }: { item: DashboardInventoryAlert }) {
  return (
    <li className="min-w-0 rounded-2xl border border-app-line p-3">
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
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 break-all text-xs tabular-nums">
        <p>剩余 {count.format(item.inventory)} 件</p>
        <p className="text-app-muted">
          近 7 天销量：
          {item.recentSold === null ? "暂无数据" : `${count.format(item.recentSold)} 件`}
        </p>
      </div>
      <p className="mt-2 break-all text-xs font-bold text-amber-800">
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

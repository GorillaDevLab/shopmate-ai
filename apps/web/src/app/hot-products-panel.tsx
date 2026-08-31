import type { DashboardHotProduct } from "@shopmate/contracts";
import { formatMoneyMinor } from "./metric-format";
import { ProductPanelFrame, type ProductPanelState } from "./product-panel-frame";

const count = new Intl.NumberFormat("zh-CN");

export function HotProductsPanel({
  items,
  state = "ready",
}: {
  items: readonly DashboardHotProduct[];
  state?: ProductPanelState;
}) {
  return (
    <ProductPanelFrame title="热销商品" emptyText="暂无热销商品" state={state} count={items.length}>
      <ol role="list" className="mt-2">
        {items.map((item) => (
          <HotProductItem key={item.productId} item={item} />
        ))}
      </ol>
    </ProductPanelFrame>
  );
}

function HotProductItem({ item }: { item: DashboardHotProduct }) {
  return (
    <li value={item.rank} className="product-row">
      <span className="rounded-md bg-brand-soft px-1 py-1.5 text-center text-xs font-semibold text-brand">
        第 {item.rank} 名
      </span>
      <div className="min-w-0 break-words [overflow-wrap:anywhere] lg:flex lg:flex-wrap lg:items-baseline lg:gap-x-4">
        <h3 className="text-sm font-bold">{item.name}</h3>
        <p className="mt-1 text-xs text-app-muted lg:mt-0">SKU：{item.skuCodes.join("、")}</p>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-xs sm:text-right">
        <div className="sm:flex sm:items-baseline sm:justify-end sm:gap-3">
          <dt className="text-app-muted">本期销量</dt>
          <dd className="mt-1 break-all font-semibold tabular-nums sm:mt-0 sm:text-sm">
            {item.sold === null ? "暂无数据" : `${count.format(item.sold)} 件`}
          </dd>
        </div>
        <div className="sm:flex sm:items-baseline sm:justify-end sm:gap-3">
          <dt className="text-app-muted">本期销售额</dt>
          <dd className="mt-1 break-all font-semibold tabular-nums sm:mt-0 sm:text-sm">
            {formatMoneyMinor(item.salesMinor)}
          </dd>
        </div>
      </dl>
    </li>
  );
}

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
      <ol role="list" className="mt-5 grid gap-3 lg:grid-cols-3">
        {items.map((item) => (
          <HotProductItem key={item.productId} item={item} />
        ))}
      </ol>
    </ProductPanelFrame>
  );
}

function HotProductItem({ item }: { item: DashboardHotProduct }) {
  return (
    <li value={item.rank} className="min-w-0 rounded-2xl bg-app-bg p-4">
      <div className="flex items-start gap-3">
        <span className="shrink-0 rounded-xl bg-[#dce9f4] px-2 py-2 text-xs font-bold">
          第 {item.rank} 名
        </span>
        <div className="min-w-0 break-words [overflow-wrap:anywhere]">
          <h3 className="text-sm font-bold">{item.name}</h3>
          <p className="mt-1 text-xs text-app-muted">SKU：{item.skuCodes.join("、")}</p>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <div>
          <dt className="text-app-muted">本期销量</dt>
          <dd className="mt-1 break-all font-bold tabular-nums">
            {item.sold === null ? "暂无数据" : `${count.format(item.sold)} 件`}
          </dd>
        </div>
        <div>
          <dt className="text-app-muted">本期销售额</dt>
          <dd className="mt-1 break-all font-bold tabular-nums">
            {formatMoneyMinor(item.salesMinor)}
          </dd>
        </div>
      </dl>
    </li>
  );
}

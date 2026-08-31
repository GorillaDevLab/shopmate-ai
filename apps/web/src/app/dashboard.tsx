import { inventoryAlerts, metrics, products, trend, type DashboardState } from "./dashboard-data";
import { MetricGrid } from "./metric-card";
import { HotProductsPanel } from "./hot-products-panel";
import { LowInventoryPanel } from "./low-inventory-panel";

export type { DashboardState } from "./dashboard-data";

export function Dashboard({ state = "ready" }: { state?: DashboardState }) {
  return (
    <main className="min-h-dvh bg-app-bg px-4 py-5 text-app-text sm:px-8 sm:py-7">
      <div className="mx-auto w-full max-w-6xl">
        <DashboardHeader />
        <section id="main-content" className="mt-10 sm:mt-14">
          <DashboardIntro />
          <MetricGrid metrics={metrics} state={state} />
          {state === "ready" ? <ReadyDashboard /> : <StatePanel state={state} />}
        </section>
        <footer className="mt-12 border-t border-app-line pt-5 text-sm text-app-muted">
          中文界面 · 移动端优先 · 隐私友好
        </footer>
      </div>
    </main>
  );
}

function DashboardHeader() {
  return (
    <header className="flex items-center justify-between gap-4">
      <a
        className="inline-flex min-h-11 items-center gap-3 rounded-full focus-ring"
        href="#main-content"
      >
        <span className="grid size-10 place-items-center rounded-2xl bg-brand text-lg font-black text-white shadow-brand">
          S
        </span>
        <span className="text-base font-bold tracking-tight">ShopMate AI</span>
      </a>
      <div className="hidden items-center gap-3 text-right sm:flex">
        <div>
          <p className="text-sm font-semibold">商家经营看板</p>
          <p className="text-xs text-app-muted">当前为模拟数据，尚未连接分析服务</p>
        </div>
        <span className="grid size-10 place-items-center rounded-full bg-app-text text-sm font-bold text-white">
          店
        </span>
      </div>
    </header>
  );
}

function DashboardIntro() {
  return (
    <div className="mb-7 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="mb-2 text-sm font-bold tracking-[0.16em] text-brand uppercase">经营总览</p>
        <h1 className="text-3xl font-black tracking-[-0.04em] sm:text-5xl">今天的经营，一眼看清</h1>
      </div>
      <span className="w-fit rounded-full border border-app-line bg-app-surface px-3 py-1.5 text-xs font-semibold text-app-muted">
        演示数据预览
      </span>
    </div>
  );
}

function ReadyDashboard() {
  return (
    <>
      <div className="mt-5 grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
        <SalesTrend />
        <LowInventoryPanel items={inventoryAlerts} />
      </div>
      <div className="mt-5">
        <HotProductsPanel items={products} />
      </div>
    </>
  );
}

function SalesTrend() {
  return (
    <section className="rounded-3xl border border-app-line bg-app-surface p-5 sm:p-6">
      <PanelHeading eyebrow="本周表现" title="销售趋势" detail="近 7 天" />
      <div
        className="mt-6 flex h-44 items-end gap-2 sm:gap-4"
        role="img"
        aria-label="近七日销售趋势图（演示数据）"
      >
        {trend.map((point, index) => (
          <div key={point.label} className="flex h-full min-w-0 flex-1 flex-col items-center gap-2">
            <div className="flex min-h-0 w-full flex-1 items-end">
              <div
                className={`w-full rounded-t-xl ${index === 6 ? "bg-brand" : "bg-[#dcd9fb]"}`}
                style={{ height: `${point.heightPercent}%` }}
              />
            </div>
            <span className="text-[11px] text-app-subtle">{point.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function PanelHeading({
  eyebrow,
  title,
  detail,
}: {
  eyebrow: string;
  title: string;
  detail: string;
}) {
  return (
    <div className="flex items-start justify-between">
      <div>
        <p className="text-xs font-bold tracking-[0.14em] text-app-subtle uppercase">{eyebrow}</p>
        <h2 className="mt-2 text-xl font-black">{title}</h2>
      </div>
      <span className="rounded-full bg-[#eef0ff] px-3 py-1 text-xs font-bold text-brand">
        {detail}
      </span>
    </div>
  );
}

function StatePanel({ state }: { state: Exclude<DashboardState, "ready"> }) {
  const copy = {
    loading: ["正在整理你的经营数据…", "很快就能看到今天的经营概览。"],
    empty: ["还没有经营数据", "导入第一批商品后，这里会自动生成经营概览。"],
    error: ["数据暂时加载失败", "请检查 API 服务后再试一次。"],
  }[state];
  return (
    <div
      className="mt-5 rounded-3xl border border-dashed border-app-line bg-app-surface px-6 py-20 text-center"
      role="status"
      aria-live="polite"
    >
      <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-[#eef0ff] text-xl text-brand">
        ✦
      </div>
      <h2 className="mt-5 text-xl font-black">{copy[0]}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-app-muted">{copy[1]}</p>
      {state === "error" && (
        <button className="mt-6 min-h-11 rounded-2xl bg-brand px-5 text-sm font-bold text-white transition hover:bg-brand-strong">
          重新加载
        </button>
      )}
    </div>
  );
}

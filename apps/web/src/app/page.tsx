export default function Home() {
  return (
    <main className="relative isolate min-h-dvh overflow-hidden bg-app-bg px-5 py-6 text-app-text sm:px-8 sm:py-8">
      <div className="glow glow-primary" aria-hidden="true" />
      <div className="glow glow-secondary" aria-hidden="true" />

      <div className="relative mx-auto flex min-h-[calc(100dvh-3rem)] w-full max-w-6xl flex-col">
        <header className="flex items-center justify-between">
          <a className="inline-flex min-h-11 items-center gap-3 rounded-full focus-ring" href="#main-content">
            <span className="grid size-10 place-items-center rounded-2xl bg-brand text-lg font-black text-white shadow-brand">
              S
            </span>
            <span className="text-base font-bold tracking-tight">ShopMate AI</span>
          </a>
          <span className="rounded-full border border-app-line bg-app-surface/80 px-3 py-1.5 text-xs font-semibold text-app-muted backdrop-blur">
            基础框架已就绪
          </span>
        </header>

        <section id="main-content" className="flex flex-1 items-center py-14 sm:py-20">
          <div className="max-w-3xl">
            <p className="mb-5 text-sm font-bold tracking-[0.18em] text-brand uppercase">你的 AI 购物搭档</p>
            <h1
              aria-label="让每一次购物决策更简单"
              className="text-balance text-4xl font-black leading-[1.08] tracking-[-0.045em] sm:text-6xl lg:text-7xl"
            >
              让每一次购物决策
              <span className="block text-brand">更简单</span>
            </h1>
            <p className="mt-6 max-w-2xl text-pretty text-base leading-7 text-app-muted sm:text-lg sm:leading-8">
              集中整理商品信息、价格变化与真实需求，让 AI 帮你看懂差异，把时间留给真正重要的选择。
            </p>
          </div>
        </section>

        <footer className="border-t border-app-line pt-5 text-sm text-app-subtle">
          中文界面 · 移动端优先 · 隐私友好
        </footer>
      </div>
    </main>
  );
}

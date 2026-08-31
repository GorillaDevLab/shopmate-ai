import Link from "next/link";

import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <main className="min-h-dvh bg-app-bg px-4 py-8 text-app-text sm:grid sm:place-items-center">
      <section className="mx-auto w-full max-w-md">
        <div className="mb-6 flex items-center justify-between">
          <Link
            className="inline-flex min-h-11 items-center gap-3 rounded-full focus-ring"
            href="/"
          >
            <span className="grid size-9 place-items-center rounded-xl bg-brand text-lg font-bold text-white">
              S
            </span>
            <span className="text-base font-bold tracking-tight">ShopMate AI</span>
          </Link>
          <Link className="text-sm font-semibold text-brand hover:underline" href="/">
            返回看板
          </Link>
        </div>
        <div className="dashboard-panel p-6 sm:p-8">
          <p className="text-xs font-semibold tracking-[0.12em] text-app-muted">商家经营工具</p>
          <h1 className="mt-2 text-2xl font-black tracking-tight">登录你的经营看板</h1>
          <p className="mt-2 text-sm leading-6 text-app-muted">
            使用商家账号查看销售、库存和趋势数据。
          </p>
          <LoginForm />
        </div>
        <p className="mt-5 text-center text-xs text-app-muted">
          会话仅通过安全 Cookie 保存，不会在页面中展示密钥。
        </p>
      </section>
    </main>
  );
}

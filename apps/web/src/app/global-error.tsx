"use client";

type GlobalErrorProps = Readonly<{
  error: unknown;
  reset: () => void;
  retry: () => void;
}>;

export function ErrorContent({ retry }: GlobalErrorProps) {
  return (
    <main className="grid min-h-dvh place-items-center bg-app-bg px-5 py-10 text-app-text">
      <section className="w-full max-w-md rounded-[2rem] border border-app-line bg-app-surface p-7 text-center shadow-xl shadow-slate-900/5 sm:p-10">
        <span aria-hidden="true" className="mx-auto grid size-14 place-items-center rounded-2xl bg-red-50 text-2xl">
          !
        </span>
        <h1 className="mt-6 text-2xl font-black tracking-tight">页面暂时出了点问题</h1>
        <p className="mt-3 text-sm leading-6 text-app-muted">
          别担心，你的数据没有丢失。请重新尝试，或稍后再回来看看。
        </p>
        <button
          className="mt-7 min-h-11 w-full rounded-2xl bg-brand px-5 py-3 text-sm font-bold text-white shadow-brand transition hover:bg-brand-strong active:translate-y-px"
          onClick={retry}
          type="button"
        >
          重新尝试
        </button>
      </section>
    </main>
  );
}

export default function GlobalError(props: GlobalErrorProps) {
  return (
    <html lang="zh-CN">
      <body>
        <ErrorContent {...props} />
      </body>
    </html>
  );
}

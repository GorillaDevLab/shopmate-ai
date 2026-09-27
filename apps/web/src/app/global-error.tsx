"use client";

type GlobalErrorProps = Readonly<{
  error: unknown;
  reset: () => void;
  retry: () => void;
}>;

export function ErrorContent({ retry }: GlobalErrorProps) {
  return (
    <main className="grid min-h-dvh place-items-center bg-app-bg px-5 py-10 text-app-text">
      <section className="w-full max-w-md rounded-xl border border-app-line bg-app-surface p-4 text-center shadow-sm md:p-6">
        <span
          aria-hidden="true"
          className="mx-auto grid size-12 place-items-center rounded-xl bg-red-50 text-xl text-danger"
        >
          !
        </span>
        <h1 className="mt-5 text-xl font-semibold tracking-tight md:text-2xl">
          页面暂时出了点问题
        </h1>
        <p className="mt-3 text-sm leading-6 text-app-muted">
          别担心，你的数据没有丢失。请重新尝试，或稍后再回来看看。
        </p>
        <button className="btn-primary mt-6 min-h-11 w-full px-5" onClick={retry} type="button">
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

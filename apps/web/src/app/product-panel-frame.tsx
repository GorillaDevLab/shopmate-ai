import type { ReactNode } from "react";

export type ProductPanelState = "ready" | "loading" | "empty" | "error";
type FrameProps = {
  title: string;
  emptyText: string;
  state: ProductPanelState;
  count: number;
  children: ReactNode;
};

export function ProductPanelFrame({ title, emptyText, state, count, children }: FrameProps) {
  const effectiveState = state === "ready" && count === 0 ? "empty" : state;
  return (
    <section aria-label={title} aria-busy={state === "loading"} className="dashboard-panel">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{title}</h2>
        {effectiveState === "ready" && (
          <span className="rounded-md bg-brand-soft px-2 py-1 text-xs font-semibold text-brand">
            {count} 项
          </span>
        )}
      </div>
      {effectiveState === "ready" ? (
        children
      ) : (
        <ProductPanelFeedback title={title} emptyText={emptyText} state={effectiveState} />
      )}
    </section>
  );
}

function ProductPanelFeedback({
  title,
  emptyText,
  state,
}: {
  title: string;
  emptyText: string;
  state: Exclude<ProductPanelState, "ready">;
}) {
  const text =
    state === "loading" ? `${title}加载中` : state === "error" ? `${title}加载失败` : emptyText;
  return (
    <div role="status" aria-live="polite" className="mt-5 min-h-40 text-sm text-app-muted">
      <p>{text}</p>
      {state === "error" && <p className="mt-2">请稍后重试。</p>}
      {state === "loading" && (
        <div aria-hidden="true" className="mt-4 space-y-3 motion-safe:animate-pulse">
          {[1, 2, 3].map((key) => (
            <div key={key} className="h-12 rounded-xl bg-app-line" />
          ))}
        </div>
      )}
    </div>
  );
}

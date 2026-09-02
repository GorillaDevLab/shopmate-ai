"use client";

import { DASHBOARD_COMPONENT_REGISTRY, type DashboardLayoutComponent } from "@shopmate/contracts";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

type DashboardWidgetGalleryProps = {
  open: boolean;
  cardCount: number;
  onAdd: (component: DashboardLayoutComponent) => void;
  onClose: () => void;
};

const components = Object.keys(DASHBOARD_COMPONENT_REGISTRY) as DashboardLayoutComponent[];

const previewCopy: Record<DashboardLayoutComponent, string> = {
  metric: "突出显示销售额、订单、销量或客单价。",
  salesTrend: "查看当前统计周期的每日销售变化。",
  inventoryAlerts: "集中查看库存偏低、需要补货的商品。",
  hotProducts: "展示当前周期表现最好的商品。",
};

export function DashboardWidgetGallery({
  open,
  cardCount,
  onAdd,
  onClose,
}: DashboardWidgetGalleryProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<DashboardLayoutComponent>("metric");
  useGalleryDialog(open, dialogRef);
  if (!open) return null;

  const isFull = cardCount >= 24;
  const label = DASHBOARD_COMPONENT_REGISTRY[selected].label;
  return (
    <dialog
      ref={dialogRef}
      className="widget-gallery"
      aria-labelledby="widget-gallery-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => handleEscape(event, onClose)}
    >
      <div className="widget-gallery-shell">
        <GalleryHeader onClose={onClose} />
        <div className="widget-gallery-body">
          <nav aria-label="可添加组件">
            {components.map((component) => (
              <button
                key={component}
                type="button"
                aria-pressed={selected === component}
                onClick={() => setSelected(component)}
              >
                <WidgetMark component={component} />
                <span>{DASHBOARD_COMPONENT_REGISTRY[component].label}</span>
              </button>
            ))}
          </nav>
          <section className="widget-gallery-preview" aria-live="polite">
            <div className="widget-gallery-preview-card" aria-hidden="true">
              <WidgetPreview component={selected} />
            </div>
            <div>
              <p className="widget-gallery-kicker">预览</p>
              <h3>{label}</h3>
              <p>{previewCopy[selected]}</p>
            </div>
            {isFull && <p className="widget-gallery-limit">看板最多包含 24 张卡片</p>}
            <button type="button" disabled={isFull} onClick={() => onAdd(selected)}>
              添加到看板
            </button>
          </section>
        </div>
      </div>
    </dialog>
  );
}

function GalleryHeader({ onClose }: { onClose: () => void }) {
  return (
    <header>
      <div>
        <p className="widget-gallery-kicker">组件库</p>
        <h2 id="widget-gallery-title">添加经营组件</h2>
      </div>
      <button type="button" aria-label="关闭组件库" onClick={onClose}>
        <span aria-hidden="true">×</span>
      </button>
    </header>
  );
}

function WidgetMark({ component }: { component: DashboardLayoutComponent }) {
  const paths: Record<DashboardLayoutComponent, string> = {
    metric: "M5 15V9m5 6V5m5 10v-3",
    salesTrend: "m4 14 4-5 4 3 5-7",
    inventoryAlerts: "M5 7h10v9H5zM7 4h6v3",
    hotProducts:
      "M10 3c3 3 4 5 2 7 2-1 4 1 3 4-1 3-3 4-5 4s-4-1-5-4c-1-3 1-6 3-8 0 2 1 3 2 4 1-2 1-4 0-7Z",
  };
  return (
    <span className="widget-gallery-mark" aria-hidden="true">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d={paths[component]} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function WidgetPreview({ component }: { component: DashboardLayoutComponent }) {
  if (component === "metric") return <strong>¥24,860</strong>;
  if (component === "salesTrend") return <span className="widget-preview-line" />;
  if (component === "inventoryAlerts") return <span>4 项需要关注</span>;
  return <span>本期热销排行</span>;
}

function useGalleryDialog(open: boolean, dialogRef: React.RefObject<HTMLDialogElement | null>) {
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;
    if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
      else dialog.removeAttribute("open");
    };
  }, [dialogRef, open]);
}

function handleEscape(event: KeyboardEvent<HTMLDialogElement>, onClose: () => void) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  onClose();
}

"use client";

import {
  DEFAULT_DASHBOARD_LAYOUT,
  type AnalyticsDashboardResponse,
  type DashboardLayoutCard,
  type DashboardLayoutSize,
} from "@shopmate/contracts";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { HotProductsPanel } from "./hot-products-panel";
import { LowInventoryPanel } from "./low-inventory-panel";
import { MetricCard } from "./metric-card";
import { SalesTrend } from "./sales-trend";
import {
  adjacentSize,
  animateCardReflow,
  captureCardRects,
  DASHBOARD_COLUMN_COUNT,
  MINIMUM_CARD_SPAN,
  previewSpan,
  sizeForSpan,
  spanForSize,
  type CardRectMap,
} from "./dashboard-layout-resize";

const sizeOptions = [
  { value: "1/3", label: "三分之一" },
  { value: "1/2", label: "二分之一" },
  { value: "2/3", label: "三分之二" },
  { value: "full", label: "全宽" },
] as const satisfies ReadonlyArray<{ value: DashboardLayoutSize; label: string }>;

const sizeClasses: Record<DashboardLayoutSize, string> = {
  "1/3": "md:col-span-4",
  "1/2": "md:col-span-6",
  "2/3": "md:col-span-8",
  full: "md:col-span-12",
};

const metricLabels = {
  sales: "销售额",
  orders: "订单",
  units: "销量",
  averageOrderValue: "客单价",
} as const;

type EditorProps = {
  data: AnalyticsDashboardResponse;
  periodLabel: string;
};

type ResizeSession = {
  cardId: string;
  pointerId: number;
  startX: number;
  startSpan: number;
  span: number;
};

type ResizePreview = Pick<ResizeSession, "cardId" | "span">;

export function DashboardLayoutEditor({ data, periodLabel }: EditorProps) {
  const [cards, setCards] = useState<DashboardLayoutCard[]>(() => [
    ...DEFAULT_DASHBOARD_LAYOUT.cards,
  ]);
  const [isEditing, setIsEditing] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [draggedId, setDraggedId] = useState<string>();
  const [resizePreview, setResizePreview] = useState<ResizePreview>();
  const [announcement, setAnnouncement] = useState("");
  const gridRef = useRef<HTMLElement>(null);
  const editToggleRef = useRef<HTMLButtonElement>(null);
  const editModeRef = useRef(false);
  const resizeSessionRef = useRef<ResizeSession | undefined>(undefined);
  const pendingRectsRef = useRef<CardRectMap | undefined>(undefined);

  const toggleEditing = useCallback(() => {
    const next = !editModeRef.current;
    editModeRef.current = next;
    if (!next) {
      resizeSessionRef.current = undefined;
      setResizePreview(undefined);
    }
    setIsEditing(next);
    setAnnouncement(next ? "已进入看板编辑模式" : "已退出看板编辑模式");
  }, []);
  useDashboardEditorShortcut(toggleEditing);

  useEffect(() => {
    if (announcement.includes("看板编辑模式")) editToggleRef.current?.focus();
  }, [announcement]);

  useLayoutEffect(() => {
    const before = pendingRectsRef.current;
    pendingRectsRef.current = undefined;
    if (before) animateCardReflow(gridRef.current, before);
  }, [cards, resizePreview]);

  const prepareReflow = (animate: boolean) => {
    pendingRectsRef.current = animate ? captureCardRects(gridRef.current) : undefined;
  };

  const moveCard = (cardId: string, targetIndex: number, animate = false) => {
    const currentIndex = cards.findIndex((card) => card.id === cardId);
    if (
      currentIndex < 0 ||
      currentIndex === targetIndex ||
      targetIndex < 0 ||
      targetIndex >= cards.length
    )
      return;
    const title = cardTitle(cards[currentIndex]);
    prepareReflow(animate);
    setCards(reorderCards(cards, currentIndex, targetIndex));
    setIsDirty(true);
    setAnnouncement(`${title}已移至第 ${targetIndex + 1} 位`);
  };

  const resizeCard = (cardId: string, size: DashboardLayoutSize) => {
    const card = cards.find((candidate) => candidate.id === cardId);
    if (!card || card.size === size) return;
    setCards((current) => current.map((item) => (item.id === cardId ? { ...item, size } : item)));
    setIsDirty(true);
    setAnnouncement(`${cardTitle(card)}宽度已调整为${sizeLabel(size)}`);
  };

  const startResize = (event: ReactPointerEvent<HTMLElement>, card: DashboardLayoutCard) => {
    if (event.button > 0 || resizeSessionRef.current) return;
    const span = spanForSize(card.size);
    resizeSessionRef.current = {
      cardId: card.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startSpan: span,
      span,
    };
    setResizePreview({ cardId: card.id, span });
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const updateResize = (event: ReactPointerEvent<HTMLElement>) => {
    const session = resizeSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const width = gridRef.current?.getBoundingClientRect().width ?? 0;
    const span = previewSpan(session.startSpan, session.startX, event.clientX, width);
    if (span === session.span) return;
    prepareReflow(true);
    session.span = span;
    setResizePreview({ cardId: session.cardId, span });
  };

  const finishResize = (event: ReactPointerEvent<HTMLElement>) => {
    const session = resizeSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    prepareReflow(true);
    resizeSessionRef.current = undefined;
    setResizePreview(undefined);
    resizeCard(session.cardId, sizeForSpan(session.span));
  };

  const cancelResize = () => {
    resizeSessionRef.current = undefined;
    pendingRectsRef.current = undefined;
    setResizePreview(undefined);
  };

  const resizeWithKeyboard = (
    event: ReactKeyboardEvent<HTMLElement>,
    card: DashboardLayoutCard,
  ) => {
    if (event.key === "Escape") {
      cancelResize();
      return;
    }
    const nextSize = keyboardResizeTarget(event.key, card.size);
    if (!nextSize) return;
    event.preventDefault();
    resizeCard(card.id, nextSize);
  };

  return (
    <>
      <EditorHeader
        toggleRef={editToggleRef}
        isEditing={isEditing}
        isDirty={isDirty}
        onToggle={toggleEditing}
      />
      <section
        ref={gridRef}
        id="dashboard-layout-grid"
        aria-label="经营看板卡片"
        className="dashboard-layout-grid grid grid-flow-dense grid-cols-1 items-start gap-4 md:grid-cols-12"
      >
        {cards.map((card, index) => (
          <DashboardCard
            key={card.id}
            card={card}
            index={index}
            count={cards.length}
            isEditing={isEditing}
            isDragging={draggedId === card.id}
            isResizing={resizePreview?.cardId === card.id}
            previewSpan={resizePreview?.cardId === card.id ? resizePreview.span : undefined}
            onMove={(offset, animate) => moveCard(card.id, index + offset, animate)}
            onDragStart={(event) => startDragging(event, card.id, setDraggedId)}
            onDragEnter={() => {
              if (draggedId && draggedId !== card.id) moveCard(draggedId, index, true);
            }}
            onDrop={() => setDraggedId(undefined)}
            onDragEnd={() => setDraggedId(undefined)}
            onResizeStart={(event) => startResize(event, card)}
            onResizeMove={updateResize}
            onResizeEnd={finishResize}
            onResizeCancel={cancelResize}
            onResizeKeyDown={(event) => resizeWithKeyboard(event, card)}
          >
            {renderCard(card, data, periodLabel)}
          </DashboardCard>
        ))}
      </section>
      <p className="sr-only" role="status" aria-label="布局编辑反馈" aria-live="polite">
        {announcement}
      </p>
    </>
  );
}

function EditorHeader({
  toggleRef,
  isEditing,
  isDirty,
  onToggle,
}: {
  toggleRef: RefObject<HTMLButtonElement | null>;
  isEditing: boolean;
  isDirty: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      role={isEditing ? "toolbar" : undefined}
      aria-label={isEditing ? "看板布局编辑工具" : undefined}
      className="mb-3 flex min-h-11 flex-wrap items-center justify-end gap-2"
    >
      {isDirty && (
        <span className="rounded-full bg-warning-soft px-3 py-1.5 text-xs font-semibold text-warning">
          草稿未保存
        </span>
      )}
      {isEditing && <span className="text-xs text-app-muted">拖动排序 · 拉动右下角调整尺寸</span>}
      <button
        ref={toggleRef}
        type="button"
        className="layout-edit-button"
        aria-pressed={isEditing}
        aria-expanded={isEditing}
        aria-controls="dashboard-layout-grid"
        onClick={onToggle}
      >
        {isEditing ? "退出编辑" : "编辑看板"}
        {!isEditing && <kbd aria-hidden="true">Ctrl/Cmd K</kbd>}
      </button>
    </div>
  );
}

type DashboardCardProps = {
  card: DashboardLayoutCard;
  index: number;
  count: number;
  isEditing: boolean;
  isDragging: boolean;
  isResizing: boolean;
  previewSpan?: number;
  onMove: (offset: number, animate: boolean) => void;
  onDragStart: (event: DragEvent<HTMLSpanElement>) => void;
  onDragEnter: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLElement>) => void;
  onResizeMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onResizeEnd: (event: ReactPointerEvent<HTMLElement>) => void;
  onResizeCancel: () => void;
  onResizeKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  children: ReactNode;
};

function DashboardCard(props: DashboardCardProps) {
  const { card, index, count, isEditing, isDragging, isResizing, previewSpan, children } = props;
  const title = cardTitle(card);
  const currentSpan = previewSpan ?? spanForSize(card.size);
  const previewStyle =
    previewSpan === undefined
      ? undefined
      : ({ "--dashboard-card-span": previewSpan } as CSSProperties);
  return (
    <div
      data-dashboard-card-id={card.id}
      data-size={card.size}
      data-preview-span={previewSpan}
      style={previewStyle}
      className={`dashboard-layout-card min-w-0 ${sizeClasses[card.size]} ${isEditing ? "is-editing" : ""} ${isDragging ? "is-dragging" : ""} ${isResizing ? "is-resizing has-size-preview" : ""}`}
      onDragOver={(event) => {
        if (isEditing) event.preventDefault();
      }}
      onDragEnter={() => {
        if (isEditing) props.onDragEnter();
      }}
      onDrop={(event) => {
        event.preventDefault();
        props.onDrop();
      }}
    >
      {isEditing && (
        <CardControls
          title={title}
          size={card.size}
          span={currentSpan}
          first={index === 0}
          last={index === count - 1}
          onMove={props.onMove}
          onDragStart={props.onDragStart}
          onDragEnd={props.onDragEnd}
        />
      )}
      {children}
      {isEditing && (
        <ResizeHandle
          title={title}
          span={currentSpan}
          onPointerDown={props.onResizeStart}
          onPointerMove={props.onResizeMove}
          onPointerUp={props.onResizeEnd}
          onPointerCancel={props.onResizeCancel}
          onKeyDown={props.onResizeKeyDown}
        />
      )}
    </div>
  );
}

type CardControlsProps = {
  title: string;
  size: DashboardLayoutSize;
  span: number;
  first: boolean;
  last: boolean;
  onMove: (offset: number, animate: boolean) => void;
  onDragStart: (event: DragEvent<HTMLSpanElement>) => void;
  onDragEnd: () => void;
};

function CardControls(props: CardControlsProps) {
  return (
    <div className="dashboard-card-controls" aria-label={`${props.title}布局设置`}>
      <span
        aria-hidden="true"
        data-drag-handle={props.title}
        title={`拖动${props.title}`}
        draggable
        className="dashboard-drag-handle"
        onDragStart={props.onDragStart}
        onDragEnd={props.onDragEnd}
      >
        ⠿
      </span>
      <button
        type="button"
        aria-label={`${props.title}上移`}
        disabled={props.first}
        onClick={(event) => props.onMove(-1, event.detail > 0)}
      >
        ↑
      </button>
      <button
        type="button"
        aria-label={`${props.title}下移`}
        disabled={props.last}
        onClick={(event) => props.onMove(1, event.detail > 0)}
      >
        ↓
      </button>
      <span className="dashboard-size-readout" aria-hidden="true">
        {sizeReadout(props.size, props.span)}
      </span>
    </div>
  );
}

function ResizeHandle({
  title,
  span,
  ...events
}: {
  title: string;
  span: number;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}) {
  return (
    <span
      role="slider"
      tabIndex={0}
      aria-label={`调整${title}卡片宽度`}
      aria-valuemin={MINIMUM_CARD_SPAN}
      aria-valuemax={DASHBOARD_COLUMN_COUNT}
      aria-valuenow={span}
      aria-valuetext={sizeLabel(sizeForSpan(span))}
      className="dashboard-resize-handle"
      title={`拖动调整${title}宽度`}
      {...events}
    >
      <span aria-hidden="true" />
    </span>
  );
}

function renderCard(
  card: DashboardLayoutCard,
  data: AnalyticsDashboardResponse,
  periodLabel: string,
): ReactNode {
  switch (card.component) {
    case "metric":
      return (
        <MetricCard
          metric={
            data.metrics.find((metric) => metric.key === card.config.metric) ?? {
              key: card.config.metric,
              value: null,
              changeRatio: null,
            }
          }
          periodLabel={periodLabel}
        />
      );
    case "salesTrend":
      return <SalesTrend points={data.trend} periodLabel={periodLabel} />;
    case "inventoryAlerts":
      return (
        <LowInventoryPanel
          items={data.inventoryAlerts.slice(0, card.config.limit)}
          periodLabel={periodLabel}
        />
      );
    case "hotProducts":
      return <HotProductsPanel items={data.products.slice(0, card.config.limit)} />;
  }
}

function useDashboardEditorShortcut(onToggle: () => void) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        isEditableTarget(event.target) ||
        document.querySelector("dialog[open]") ||
        event.key.toLowerCase() !== "k" ||
        (!event.ctrlKey && !event.metaKey)
      )
        return;
      event.preventDefault();
      onToggle();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onToggle]);
}

function startDragging(
  event: DragEvent<HTMLSpanElement>,
  cardId: string,
  setDraggedId: (cardId: string) => void,
) {
  event.dataTransfer?.setData("text/plain", cardId);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  setDraggedId(cardId);
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest("input, textarea, select, [contenteditable='true']"))
  );
}

function reorderCards(
  cards: DashboardLayoutCard[],
  sourceIndex: number,
  targetIndex: number,
): DashboardLayoutCard[] {
  const next = [...cards];
  const [moved] = next.splice(sourceIndex, 1);
  if (!moved) return cards;
  next.splice(targetIndex, 0, moved);
  return next;
}

function cardTitle(card: DashboardLayoutCard): string {
  switch (card.component) {
    case "metric":
      return metricLabels[card.config.metric];
    case "salesTrend":
      return "销售趋势";
    case "inventoryAlerts":
      return "库存提醒";
    case "hotProducts":
      return "热销商品";
  }
}

function sizeLabel(size: DashboardLayoutSize): string {
  return sizeOptions.find((option) => option.value === size)?.label ?? size;
}

function sizeReadout(size: DashboardLayoutSize, span: number): string {
  return span === spanForSize(size) ? sizeLabel(size) : `${span} / ${DASHBOARD_COLUMN_COUNT}`;
}

function keyboardResizeTarget(
  key: string,
  current: DashboardLayoutSize,
): DashboardLayoutSize | undefined {
  if (key === "ArrowLeft" || key === "ArrowDown") return adjacentSize(current, -1);
  if (key === "ArrowRight" || key === "ArrowUp") return adjacentSize(current, 1);
  if (key === "Home") return "1/3";
  if (key === "End") return "full";
  return undefined;
}

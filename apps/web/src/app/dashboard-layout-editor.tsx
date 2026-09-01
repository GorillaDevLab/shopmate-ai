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
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { HotProductsPanel } from "./hot-products-panel";
import { LowInventoryPanel } from "./low-inventory-panel";
import { MetricCard } from "./metric-card";
import { SalesTrend } from "./sales-trend";

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

export function DashboardLayoutEditor({ data, periodLabel }: EditorProps) {
  const [cards, setCards] = useState<DashboardLayoutCard[]>(() => [
    ...DEFAULT_DASHBOARD_LAYOUT.cards,
  ]);
  const [isEditing, setIsEditing] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [draggedId, setDraggedId] = useState<string>();
  const [announcement, setAnnouncement] = useState("");
  const editToggleRef = useRef<HTMLButtonElement>(null);
  const editModeRef = useRef(false);

  const toggleEditing = useCallback(() => {
    const next = !editModeRef.current;
    editModeRef.current = next;
    setIsEditing(next);
    setAnnouncement(next ? "已进入看板编辑模式" : "已退出看板编辑模式");
  }, []);
  useDashboardEditorShortcut(toggleEditing);

  useEffect(() => {
    if (announcement.includes("看板编辑模式")) editToggleRef.current?.focus();
  }, [announcement]);

  const moveCard = (cardId: string, targetIndex: number) => {
    const currentIndex = cards.findIndex((card) => card.id === cardId);
    if (
      currentIndex < 0 ||
      currentIndex === targetIndex ||
      targetIndex < 0 ||
      targetIndex >= cards.length
    )
      return;
    const title = cardTitle(cards[currentIndex]);
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

  return (
    <>
      <EditorHeader
        toggleRef={editToggleRef}
        isEditing={isEditing}
        isDirty={isDirty}
        onToggle={toggleEditing}
      />
      <section
        id="dashboard-layout-grid"
        aria-label="经营看板卡片"
        className="grid grid-cols-1 items-start gap-4 md:grid-cols-12"
      >
        {cards.map((card, index) => (
          <DashboardCard
            key={card.id}
            card={card}
            index={index}
            count={cards.length}
            isEditing={isEditing}
            isDragging={draggedId === card.id}
            onMove={(offset) => moveCard(card.id, index + offset)}
            onResize={(size) => resizeCard(card.id, size)}
            onDragStart={(event) => startDragging(event, card.id, setDraggedId)}
            onDrop={() => {
              if (draggedId) moveCard(draggedId, index);
              setDraggedId(undefined);
            }}
            onDragEnd={() => setDraggedId(undefined)}
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
      {isEditing && (
        <span className="text-xs text-app-muted">拖动卡片，或使用卡片上的排序按钮</span>
      )}
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
  onMove: (offset: number) => void;
  onResize: (size: DashboardLayoutSize) => void;
  onDragStart: (event: DragEvent<HTMLSpanElement>) => void;
  onDrop: () => void;
  onDragEnd: () => void;
  children: ReactNode;
};

function DashboardCard(props: DashboardCardProps) {
  const { card, index, count, isEditing, isDragging, children } = props;
  const title = cardTitle(card);
  return (
    <div
      data-dashboard-card-id={card.id}
      data-size={card.size}
      className={`dashboard-layout-card min-w-0 ${sizeClasses[card.size]} ${isEditing ? "is-editing" : ""} ${isDragging ? "is-dragging" : ""}`}
      onDragOver={(event) => {
        if (isEditing) event.preventDefault();
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
          first={index === 0}
          last={index === count - 1}
          onMove={props.onMove}
          onResize={props.onResize}
          onDragStart={props.onDragStart}
          onDragEnd={props.onDragEnd}
        />
      )}
      {children}
    </div>
  );
}

type CardControlsProps = {
  title: string;
  size: DashboardLayoutSize;
  first: boolean;
  last: boolean;
  onMove: (offset: number) => void;
  onResize: (size: DashboardLayoutSize) => void;
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
        onClick={() => props.onMove(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        aria-label={`${props.title}下移`}
        disabled={props.last}
        onClick={() => props.onMove(1)}
      >
        ↓
      </button>
      <label className="ml-auto flex items-center gap-2 text-xs font-semibold text-app-muted">
        <span>宽度</span>
        <select
          aria-label={`${props.title}卡片宽度`}
          value={props.size}
          onChange={(event) => props.onResize(event.target.value as DashboardLayoutSize)}
        >
          {sizeOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </div>
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

"use client";

import type {
  AnalyticsDashboardResponse,
  DashboardLayoutCard,
  DashboardLayoutSize,
} from "@shopmate/contracts";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SetStateAction,
} from "react";

import {
  DashboardLayoutApiError,
  fetchDashboardLayout,
  saveDashboardLayout,
} from "./dashboard-layout-api";
import {
  createDashboardCard,
  initialLayoutEditorState,
  isLayoutDirty,
  layoutEditorReducer,
  type LayoutEditorAction,
  type LayoutEditorMode,
  type LayoutEditorState,
} from "./dashboard-layout-state";
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
import { DashboardWidgetGallery } from "./dashboard-widget-gallery";
import { HotProductsPanel } from "./hot-products-panel";
import { LowInventoryPanel } from "./low-inventory-panel";
import { MetricCard } from "./metric-card";
import { SalesTrend } from "./sales-trend";

const sizeOptions = [
  { value: "1/3", label: "小" },
  { value: "1/2", label: "中" },
  { value: "2/3", label: "大" },
  { value: "full", label: "整行" },
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
  onEditingChange?: (isEditing: boolean) => void;
};

type ResizeSession = {
  cardId: string;
  pointerId: number;
  startX: number;
  startSpan: number;
  span: number;
};

type ResizePreview = Pick<ResizeSession, "cardId" | "span">;

export function DashboardLayoutEditor(props: EditorProps) {
  const persistence = useLayoutPersistence(props.onEditingChange);
  if (persistence.state.loadStatus !== "ready") {
    return <LayoutLoadState state={persistence.state} onRetry={persistence.reload} />;
  }
  return <ReadyLayoutEditor {...props} persistence={persistence} />;
}

type Persistence = ReturnType<typeof useLayoutPersistence>;

function ReadyLayoutEditor({
  data,
  periodLabel,
  persistence,
}: EditorProps & { persistence: Persistence }) {
  const { state, dispatch } = persistence;
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const gridRef = useRef<HTMLElement>(null);
  const interactions = useCardInteractions(state, dispatch, gridRef);
  const isDirty = isLayoutDirty(state);
  const isEditing = state.mode === "edit";

  useEditorFocus(state.mode);
  useDashboardEditorShortcut(() => toggleEditorMode(state.mode, dispatch));
  useUndoExpiry(state, dispatch);
  const announce = interactions.announce;
  useEffect(() => {
    announce(state.mode === "edit" ? "已进入看板编辑模式" : "已退出看板编辑模式");
  }, [announce, state.mode]);

  return (
    <>
      <EditorHeader
        state={state}
        isDirty={isDirty}
        layoutMenuOpen={layoutMenuOpen}
        onLayoutMenuChange={setLayoutMenuOpen}
        onAdd={() => setGalleryOpen(true)}
        onModeChange={(mode) => dispatch({ type: "modeChanged", mode })}
        onSave={persistence.save}
        onDiscard={() => discardChanges(state, dispatch)}
        onRestore={() => restoreDefaults(dispatch)}
      />
      <LayoutMessage state={state} onRetrySave={persistence.save} onReload={persistence.reload} />
      <DashboardGrid
        data={data}
        periodLabel={periodLabel}
        state={state}
        gridRef={gridRef}
        interactions={interactions}
      />
      <DashboardWidgetGallery
        open={galleryOpen}
        cardCount={state.draft.cards.length}
        onClose={() => setGalleryOpen(false)}
        onAdd={(component) => {
          dispatch({
            type: "cardAdded",
            card: createDashboardCard(component, state.draft.cards),
          });
          setGalleryOpen(false);
          interactions.announce("组件已添加到看板末尾");
        }}
      />
      <UndoToast state={state} dispatch={dispatch} />
      <p className="sr-only" role="status" aria-label="布局编辑反馈" aria-live="polite">
        {interactions.announcement}
      </p>
      {isEditing && <span className="sr-only">当前处于编辑模式</span>}
    </>
  );
}

function DashboardGrid({
  data,
  periodLabel,
  state,
  gridRef,
  interactions,
}: {
  data: AnalyticsDashboardResponse;
  periodLabel: string;
  state: LayoutEditorState;
  gridRef: MutableRefObject<HTMLElement | null>;
  interactions: ReturnType<typeof useCardInteractions>;
}) {
  const isEditing = state.mode === "edit";
  return (
    <section
      ref={gridRef}
      id="dashboard-layout-grid"
      aria-label="经营看板卡片"
      className="dashboard-layout-grid grid grid-flow-dense grid-cols-1 items-start gap-4 md:grid-cols-12"
    >
      {state.draft.cards.map((card, index) => (
        <DashboardCard
          key={card.id}
          card={card}
          index={index}
          count={state.draft.cards.length}
          isEditing={isEditing}
          isDragging={interactions.draggedId === card.id}
          isResizing={interactions.resizePreview?.cardId === card.id}
          previewSpan={
            interactions.resizePreview?.cardId === card.id
              ? interactions.resizePreview.span
              : undefined
          }
          interactions={interactions}
        >
          {renderCard(card, data, periodLabel)}
        </DashboardCard>
      ))}
    </section>
  );
}

function useLayoutPersistence(onEditingChange?: (isEditing: boolean) => void) {
  const [state, dispatch] = useReducer(layoutEditorReducer, initialLayoutEditorState);
  const controllerRef = useRef<AbortController | undefined>(undefined);

  const reload = useCallback(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    dispatch({ type: "loadStarted" });
    void fetchDashboardLayout(controller.signal).then(
      (response) => dispatch({ type: "loaded", response }),
      (error: unknown) => handleLoadFailure(error, dispatch),
    );
  }, []);

  useEffect(() => {
    reload();
    return () => controllerRef.current?.abort();
  }, [reload]);
  useEffect(() => onEditingChange?.(state.mode !== "view"), [onEditingChange, state.mode]);
  useUnsavedChangesWarning(isLayoutDirty(state));

  const save = useCallback(async () => {
    if (state.saveStatus === "saving") return;
    if (!isLayoutDirty(state)) {
      dispatch({ type: "modeChanged", mode: "view" });
      return;
    }
    dispatch({ type: "saveStarted" });
    await persistDraft(state, dispatch);
  }, [state]);

  return { state, dispatch, reload, save };
}

async function persistDraft(state: LayoutEditorState, dispatch: Dispatch<LayoutEditorAction>) {
  try {
    const response = await saveDashboardLayout({
      layout: state.draft,
      expectedRevision: state.revision,
    });
    dispatch({ type: "saved", response });
  } catch (error: unknown) {
    const conflict = error instanceof DashboardLayoutApiError && error.status === 409;
    dispatch({
      type: "saveFailed",
      kind: conflict ? "conflict" : "error",
      message: error instanceof Error ? error.message : "保存失败，请重试",
    });
  }
}

function handleLoadFailure(error: unknown, dispatch: Dispatch<LayoutEditorAction>) {
  if (error instanceof DOMException && error.name === "AbortError") return;
  dispatch({
    type: "loadFailed",
    message: error instanceof Error ? error.message : "布局加载失败，请重试",
  });
}

function useUnsavedChangesWarning(isDirty: boolean) {
  useEffect(() => {
    if (!isDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isDirty]);
}

function useCardInteractions(
  state: LayoutEditorState,
  dispatch: Dispatch<LayoutEditorAction>,
  gridRef: MutableRefObject<HTMLElement | null>,
) {
  const [draggedId, setDraggedId] = useState<string>();
  const [resizePreview, setResizePreview] = useState<ResizePreview>();
  const [announcement, setAnnouncement] = useState("");
  const resizeSessionRef = useRef<ResizeSession | undefined>(undefined);
  const pendingRectsRef = useRef<CardRectMap | undefined>(undefined);

  useLayoutEffect(() => {
    const before = pendingRectsRef.current;
    pendingRectsRef.current = undefined;
    if (before) animateCardReflow(gridRef.current, before);
  }, [gridRef, state.draft.cards, resizePreview]);

  const changeCards = (cards: DashboardLayoutCard[], animate = false) => {
    pendingRectsRef.current = animate ? captureCardRects(gridRef.current) : undefined;
    dispatch({ type: "cardsChanged", cards });
  };
  const moveCard = (cardId: string, targetIndex: number, animate = false) => {
    const cards = state.draft.cards;
    const currentIndex = cards.findIndex((card) => card.id === cardId);
    if (currentIndex < 0 || currentIndex === targetIndex || targetIndex < 0 || targetIndex >= cards.length)
      return;
    changeCards(reorderCards(cards, currentIndex, targetIndex), animate);
    setAnnouncement(`${cardTitle(cards[currentIndex])}已移至第 ${targetIndex + 1} 位`);
  };
  const resizeCard = (cardId: string, size: DashboardLayoutSize) => {
    const card = state.draft.cards.find((candidate) => candidate.id === cardId);
    if (!card || card.size === size) return;
    changeCards(
      state.draft.cards.map((item) => (item.id === cardId ? { ...item, size } : item)),
    );
    setAnnouncement(`${cardTitle(card)}宽度已调整为${sizeLabel(size)}`);
  };
  const removeCard = (card: DashboardLayoutCard) => {
    pendingRectsRef.current = captureCardRects(gridRef.current);
    dispatch({ type: "cardRemoved", cardId: card.id });
    setAnnouncement(`${cardTitle(card)}已移除`);
  };
  return {
    draggedId,
    setDraggedId,
    resizePreview,
    setResizePreview,
    announcement,
    changeCards,
    moveCard,
    resizeCard,
    removeCard,
    startResize: (event: ReactPointerEvent<HTMLElement>, card: DashboardLayoutCard) =>
      startResize(event, card, resizeSessionRef, setResizePreview),
    updateResize: (event: ReactPointerEvent<HTMLElement>) =>
      updateResize(
        event,
        gridRef,
        resizeSessionRef,
        pendingRectsRef,
        setResizePreview,
      ),
    finishResize: (event: ReactPointerEvent<HTMLElement>) =>
      finishResize(
        event,
        gridRef,
        resizeSessionRef,
        pendingRectsRef,
        setResizePreview,
        resizeCard,
      ),
    cancelResize: () =>
      cancelResize(resizeSessionRef, pendingRectsRef, setResizePreview),
    announce: setAnnouncement,
  };
}

function EditorHeader(props: {
  state: LayoutEditorState;
  isDirty: boolean;
  layoutMenuOpen: boolean;
  onLayoutMenuChange: (open: boolean) => void;
  onAdd: () => void;
  onModeChange: (mode: LayoutEditorMode) => void;
  onSave: () => void;
  onDiscard: () => void;
  onRestore: () => void;
}) {
  if (props.state.mode === "edit") return <EditToolbar {...props} />;
  if (props.state.mode === "preview") return <PreviewToolbar {...props} />;
  return (
    <div className="layout-view-actions">
      <SaveStatus state={props.state} isDirty={props.isDirty} />
      <button
        data-layout-edit-button
        type="button"
        className="layout-edit-button"
        aria-pressed="false"
        aria-controls="dashboard-layout-grid"
        onClick={() => props.onModeChange("edit")}
      >
        编辑看板 <kbd aria-hidden="true">Ctrl/Cmd K</kbd>
      </button>
    </div>
  );
}

function EditToolbar(props: Parameters<typeof EditorHeader>[0]) {
  return (
    <div role="toolbar" aria-label="看板布局编辑工具" className="layout-editor-toolbar">
      <SaveStatus state={props.state} isDirty={props.isDirty} />
      <button type="button" onClick={props.onAdd}>添加组件</button>
      <button type="button" onClick={() => props.onModeChange("preview")}>预览</button>
      <LayoutMoreMenu {...props} />
      <button
        data-layout-save-button
        type="button"
        className="layout-save-button"
        disabled={props.state.saveStatus === "saving"}
        onClick={props.onSave}
      >
        {props.state.saveStatus === "saving" ? "正在保存…" : "完成并保存"}
      </button>
    </div>
  );
}

function PreviewToolbar(props: Parameters<typeof EditorHeader>[0]) {
  return (
    <div role="toolbar" aria-label="看板预览工具" className="layout-editor-toolbar">
      <span className="layout-preview-label">预览草稿</span>
      <button type="button" onClick={() => props.onModeChange("edit")}>返回编辑</button>
      <button type="button" className="layout-save-button" onClick={props.onSave}>
        完成并保存
      </button>
    </div>
  );
}

function LayoutMoreMenu(props: Parameters<typeof EditorHeader>[0]) {
  return (
    <div className="layout-menu-anchor">
      <button
        type="button"
        aria-label="更多布局操作"
        aria-haspopup="menu"
        aria-expanded={props.layoutMenuOpen}
        onClick={() => props.onLayoutMenuChange(!props.layoutMenuOpen)}
      >
        <span aria-hidden="true">•••</span>
      </button>
      {props.layoutMenuOpen && (
        <div role="menu" aria-label="更多布局操作" className="layout-card-more-menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              props.onLayoutMenuChange(false);
              props.onDiscard();
            }}
          >
            放弃修改
          </button>
          <button
            type="button"
            role="menuitem"
            className="is-danger"
            onClick={() => {
              props.onLayoutMenuChange(false);
              props.onRestore();
            }}
          >
            恢复默认
          </button>
        </div>
      )}
    </div>
  );
}

function SaveStatus({ state, isDirty }: { state: LayoutEditorState; isDirty: boolean }) {
  const copy = state.saveStatus === "saved" ? "已保存" : isDirty ? "草稿未保存" : "布局已同步";
  return (
    <span className="layout-save-status" role="status" aria-label="布局保存状态">
      {copy}
    </span>
  );
}

function LayoutMessage({
  state,
  onRetrySave,
  onReload,
}: {
  state: LayoutEditorState;
  onRetrySave: () => void;
  onReload: () => void;
}) {
  if (state.saveStatus !== "error" && state.saveStatus !== "conflict") return null;
  return (
    <div className="layout-error-banner" role="alert">
      <span>{state.message}</span>
      <button type="button" onClick={onRetrySave}>重试保存</button>
      {state.saveStatus === "conflict" && (
        <button type="button" onClick={() => reloadAfterConfirmation(onReload)}>
          重新加载服务器版本
        </button>
      )}
    </div>
  );
}

function LayoutLoadState({ state, onRetry }: { state: LayoutEditorState; onRetry: () => void }) {
  if (state.loadStatus === "loading") {
    return <div className="layout-loading" role="status">正在恢复你的看板布局…</div>;
  }
  return (
    <div className="dashboard-panel layout-load-error" role="alert">
      <strong>布局暂时无法加载</strong>
      <p>{state.message}</p>
      <div>
        <button type="button" onClick={onRetry}>重新加载布局</button>
        {state.message?.includes("登录") && <a href="/login">重新登录</a>}
      </div>
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
  interactions: ReturnType<typeof useCardInteractions>;
  children: ReactNode;
};

function DashboardCard(props: DashboardCardProps) {
  const { card, isEditing, isDragging, isResizing, previewSpan, children } = props;
  const title = cardTitle(card);
  const currentSpan = previewSpan ?? spanForSize(card.size);
  const style = previewSpan === undefined
    ? undefined
    : ({ "--dashboard-card-span": previewSpan } as CSSProperties);
  return (
    <div
      data-dashboard-card-id={card.id}
      data-size={card.size}
      data-preview-span={previewSpan}
      style={style}
      className={`dashboard-layout-card min-w-0 ${sizeClasses[card.size]} ${isEditing ? "is-editing" : ""} ${isDragging ? "is-dragging" : ""} ${isResizing ? "is-resizing has-size-preview" : ""}`}
      onDragOver={(event) => isEditing && event.preventDefault()}
      onDragEnter={() => handleDragEnter(props)}
      onDrop={(event) => {
        event.preventDefault();
        props.interactions.setDraggedId(undefined);
      }}
    >
      {isEditing && <CardControls {...props} title={title} span={currentSpan} />}
      {children}
      {isEditing && <CardResizeHandle {...props} title={title} span={currentSpan} />}
    </div>
  );
}

function CardControls(props: DashboardCardProps & { title: string; span: number }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="dashboard-card-controls" aria-label={`${props.title}布局设置`}>
      <span
        aria-hidden="true"
        data-drag-handle={props.title}
        title={`拖动${props.title}`}
        draggable
        className="dashboard-drag-handle"
        onDragStart={(event) => startDragging(event, props.card.id, props.interactions.setDraggedId)}
        onDragEnd={() => props.interactions.setDraggedId(undefined)}
      >
        ⠿
      </span>
      <MoveButtons {...props} />
      <span className="dashboard-size-readout" aria-hidden="true">
        {sizeReadout(props.card.size, props.span)}
      </span>
      <CardMoreMenu {...props} open={menuOpen} onOpenChange={setMenuOpen} />
    </div>
  );
}

function MoveButtons(props: DashboardCardProps & { title: string }) {
  return (
    <>
      <button
        type="button"
        aria-label={`${props.title}上移`}
        disabled={props.index === 0}
        onClick={(event) => props.interactions.moveCard(props.card.id, props.index - 1, event.detail > 0)}
      >
        ↑
      </button>
      <button
        type="button"
        aria-label={`${props.title}下移`}
        disabled={props.index === props.count - 1}
        onClick={(event) => props.interactions.moveCard(props.card.id, props.index + 1, event.detail > 0)}
      >
        ↓
      </button>
    </>
  );
}

function CardMoreMenu(
  props: DashboardCardProps & { title: string; open: boolean; onOpenChange: (open: boolean) => void },
) {
  return (
    <div className="layout-menu-anchor ml-auto">
      <button
        type="button"
        aria-label={`${props.title}更多操作`}
        aria-haspopup="menu"
        aria-expanded={props.open}
        onClick={() => props.onOpenChange(!props.open)}
      >
        <span aria-hidden="true">•••</span>
      </button>
      {props.open && (
        <div role="menu" aria-label={`${props.title}更多操作`} className="layout-card-more-menu">
          <p>调整大小</p>
          {sizeOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={props.card.size === option.value}
              onClick={() => {
                props.interactions.resizeCard(props.card.id, option.value);
                props.onOpenChange(false);
              }}
            >
              {option.label}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="is-danger"
            onClick={() => {
              props.interactions.removeCard(props.card);
              props.onOpenChange(false);
            }}
            data-remove-card-id={props.card.id}
          >
            删除
          </button>
        </div>
      )}
    </div>
  );
}

function CardResizeHandle(props: DashboardCardProps & { title: string; span: number }) {
  return (
    <span
      role="slider"
      tabIndex={0}
      aria-label={`调整${props.title}卡片宽度`}
      aria-valuemin={MINIMUM_CARD_SPAN}
      aria-valuemax={DASHBOARD_COLUMN_COUNT}
      aria-valuenow={props.span}
      aria-valuetext={sizeLabel(sizeForSpan(props.span))}
      className="dashboard-resize-handle"
      title={`拖动调整${props.title}宽度`}
      onPointerDown={(event) => props.interactions.startResize(event, props.card)}
      onPointerMove={props.interactions.updateResize}
      onPointerUp={props.interactions.finishResize}
      onPointerCancel={props.interactions.cancelResize}
      onKeyDown={(event) => resizeWithKeyboard(event, props.card, props.interactions)}
    >
      <span aria-hidden="true" />
    </span>
  );
}

function UndoToast({ state, dispatch }: { state: LayoutEditorState; dispatch: Dispatch<LayoutEditorAction> }) {
  if (!state.removedCard) return null;
  const title = cardTitle(state.removedCard.card);
  return (
    <div className="layout-undo-toast" role="status">
      <span>已移除 {title}</span>
      <button type="button" aria-label={`撤销删除${title}`} onClick={() => dispatch({ type: "removeUndone" })}>
        撤销
      </button>
    </div>
  );
}

function useUndoExpiry(state: LayoutEditorState, dispatch: Dispatch<LayoutEditorAction>) {
  useEffect(() => {
    if (!state.removedCard) return;
    const timer = window.setTimeout(() => dispatch({ type: "removeExpired" }), 4_000);
    return () => window.clearTimeout(timer);
  }, [dispatch, state.removedCard]);
}

function useEditorFocus(mode: LayoutEditorMode) {
  const previousModeRef = useRef(mode);

  useEffect(() => {
    const selector = mode === "edit" ? "[data-layout-save-button]" : "[data-layout-edit-button]";
    if (mode === "edit" || previousModeRef.current !== "view") {
      document.querySelector<HTMLButtonElement>(selector)?.focus();
    }
    previousModeRef.current = mode;
  }, [mode]);
}

function toggleEditorMode(mode: LayoutEditorMode, dispatch: Dispatch<LayoutEditorAction>) {
  dispatch({ type: "modeChanged", mode: mode === "view" ? "edit" : "view" });
}

function discardChanges(state: LayoutEditorState, dispatch: Dispatch<LayoutEditorAction>) {
  if (!isLayoutDirty(state) || window.confirm("放弃所有未保存的布局修改？")) {
    dispatch({ type: "discarded" });
  }
}

function restoreDefaults(dispatch: Dispatch<LayoutEditorAction>) {
  if (window.confirm("将当前草稿恢复为默认布局？此操作仍需保存。")) {
    dispatch({ type: "defaultsRestored" });
  }
}

function reloadAfterConfirmation(onReload: () => void) {
  if (window.confirm("重新加载会放弃当前草稿，是否继续？")) onReload();
}

function handleDragEnter(props: DashboardCardProps) {
  if (!props.isEditing) return;
  const draggedId = props.interactions.draggedId;
  if (draggedId && draggedId !== props.card.id) {
    props.interactions.moveCard(draggedId, props.index, true);
  }
}

function startResize(
  event: ReactPointerEvent<HTMLElement>,
  card: DashboardLayoutCard,
  sessionRef: MutableRefObject<ResizeSession | undefined>,
  setPreview: Dispatch<SetStateAction<ResizePreview | undefined>>,
) {
  if (event.button > 0 || sessionRef.current) return;
  const span = spanForSize(card.size);
  sessionRef.current = {
    cardId: card.id,
    pointerId: event.pointerId,
    startX: event.clientX,
    startSpan: span,
    span,
  };
  setPreview({ cardId: card.id, span });
  event.currentTarget.setPointerCapture?.(event.pointerId);
}

function updateResize(
  event: ReactPointerEvent<HTMLElement>,
  gridRef: MutableRefObject<HTMLElement | null>,
  sessionRef: MutableRefObject<ResizeSession | undefined>,
  pendingRectsRef: MutableRefObject<CardRectMap | undefined>,
  setPreview: Dispatch<SetStateAction<ResizePreview | undefined>>,
) {
  const session = sessionRef.current;
  if (!session || session.pointerId !== event.pointerId) return;
  const width = gridRef.current?.getBoundingClientRect().width ?? 0;
  const span = previewSpan(session.startSpan, session.startX, event.clientX, width);
  if (span === session.span) return;
  pendingRectsRef.current = captureCardRects(gridRef.current);
  session.span = span;
  setPreview({ cardId: session.cardId, span });
}

function finishResize(
  event: ReactPointerEvent<HTMLElement>,
  gridRef: MutableRefObject<HTMLElement | null>,
  sessionRef: MutableRefObject<ResizeSession | undefined>,
  pendingRectsRef: MutableRefObject<CardRectMap | undefined>,
  setPreview: Dispatch<SetStateAction<ResizePreview | undefined>>,
  resizeCard: (cardId: string, size: DashboardLayoutSize) => void,
) {
  const session = sessionRef.current;
  if (!session || session.pointerId !== event.pointerId) return;
  event.currentTarget.releasePointerCapture?.(event.pointerId);
  pendingRectsRef.current = captureCardRects(gridRef.current);
  sessionRef.current = undefined;
  setPreview(undefined);
  resizeCard(session.cardId, sizeForSpan(session.span));
}

function cancelResize(
  sessionRef: MutableRefObject<ResizeSession | undefined>,
  pendingRectsRef: MutableRefObject<CardRectMap | undefined>,
  setPreview: Dispatch<SetStateAction<ResizePreview | undefined>>,
) {
  sessionRef.current = undefined;
  pendingRectsRef.current = undefined;
  setPreview(undefined);
}

function resizeWithKeyboard(
  event: ReactKeyboardEvent<HTMLElement>,
  card: DashboardLayoutCard,
  interactions: ReturnType<typeof useCardInteractions>,
) {
  if (event.key === "Escape") return interactions.cancelResize();
  const nextSize = keyboardResizeTarget(event.key, card.size);
  if (!nextSize) return;
  event.preventDefault();
  interactions.resizeCard(card.id, nextSize);
}

function renderCard(
  card: DashboardLayoutCard,
  data: AnalyticsDashboardResponse,
  periodLabel: string,
): ReactNode {
  if (card.component === "metric") {
    const metric = data.metrics.find((candidate) => candidate.key === card.config.metric) ?? {
      key: card.config.metric,
      value: null,
      changeRatio: null,
    };
    return <MetricCard metric={metric} periodLabel={periodLabel} />;
  }
  if (card.component === "salesTrend") {
    return <SalesTrend points={data.trend} periodLabel={periodLabel} />;
  }
  if (card.component === "inventoryAlerts") {
    return <LowInventoryPanel items={data.inventoryAlerts.slice(0, card.config.limit)} periodLabel={periodLabel} />;
  }
  return <HotProductsPanel items={data.products.slice(0, card.config.limit)} />;
}

function useDashboardEditorShortcut(onToggle: () => void) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreShortcut(event)) return;
      event.preventDefault();
      onToggle();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onToggle]);
}

function shouldIgnoreShortcut(event: KeyboardEvent): boolean {
  return (
    event.repeat ||
    isEditableTarget(event.target) ||
    Boolean(document.querySelector("dialog[open]")) ||
    event.key.toLowerCase() !== "k" ||
    (!event.ctrlKey && !event.metaKey)
  );
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
  cards: readonly DashboardLayoutCard[],
  sourceIndex: number,
  targetIndex: number,
): DashboardLayoutCard[] {
  const next = [...cards];
  const [moved] = next.splice(sourceIndex, 1);
  if (!moved) return [...cards];
  next.splice(targetIndex, 0, moved);
  return next;
}

function cardTitle(card: DashboardLayoutCard): string {
  if (card.component === "metric") return metricLabels[card.config.metric];
  if (card.component === "salesTrend") return "销售趋势";
  if (card.component === "inventoryAlerts") return "库存提醒";
  return "热销商品";
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

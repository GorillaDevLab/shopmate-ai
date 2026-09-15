import {
  DASHBOARD_COMPONENT_REGISTRY,
  DEFAULT_DASHBOARD_LAYOUT,
  type DashboardLayout,
  type DashboardLayoutCard,
  type DashboardLayoutComponent,
  type DashboardLayoutReadResponse,
  type DashboardInsightQuery,
} from "@shopmate/contracts";

export type LayoutEditorMode = "view" | "edit" | "preview";
export type LayoutLoadStatus = "loading" | "ready" | "error";
export type LayoutSaveStatus = "idle" | "saving" | "saved" | "error" | "conflict";

export type LayoutEditorState = {
  baseline: DashboardLayout;
  draft: DashboardLayout;
  revision: number;
  mode: LayoutEditorMode;
  loadStatus: LayoutLoadStatus;
  saveStatus: LayoutSaveStatus;
  message?: string;
  removedCard?: RemovedCardSnapshot;
  addedCard?: RemovedCardSnapshot;
};

type RemovedCardSnapshot = {
  card: DashboardLayoutCard;
  index: number;
};

export type LayoutEditorAction =
  | { type: "loadStarted" }
  | { type: "loaded"; response: DashboardLayoutReadResponse }
  | { type: "loadFailed"; message: string }
  | { type: "modeChanged"; mode: LayoutEditorMode }
  | { type: "cardsChanged"; cards: DashboardLayoutCard[] }
  | { type: "cardAdded"; card: DashboardLayoutCard }
  | { type: "cardRemoved"; cardId: string }
  | { type: "removeUndone" }
  | { type: "removeExpired" }
  | { type: "addUndone" }
  | { type: "addExpired" }
  | { type: "discarded" }
  | { type: "defaultsRestored" }
  | { type: "saveStarted" }
  | { type: "saved"; response: DashboardLayoutReadResponse }
  | { type: "saveFailed"; kind: "error" | "conflict"; message: string }
  | { type: "messageCleared" };

export const initialLayoutEditorState: LayoutEditorState = {
  baseline: cloneLayout(DEFAULT_DASHBOARD_LAYOUT),
  draft: cloneLayout(DEFAULT_DASHBOARD_LAYOUT),
  revision: 0,
  mode: "view",
  loadStatus: "loading",
  saveStatus: "idle",
};

export function isLayoutDirty(state: LayoutEditorState): boolean {
  return JSON.stringify(state.draft) !== JSON.stringify(state.baseline);
}

export function layoutEditorReducer(
  state: LayoutEditorState,
  action: LayoutEditorAction,
): LayoutEditorState {
  if (action.type === "loadStarted") {
    return { ...state, loadStatus: "loading", message: undefined };
  }
  if (action.type === "loaded") return applyLoadedLayout(state, action.response);
  if (action.type === "loadFailed") {
    return { ...state, loadStatus: "error", message: action.message };
  }
  if (action.type === "modeChanged") return { ...state, mode: action.mode };
  if (action.type === "cardsChanged") return withCards(state, action.cards);
  if (action.type === "cardAdded") {
    const index = state.draft.cards.length;
    return {
      ...withCards(state, [...state.draft.cards, action.card]),
      addedCard: { card: action.card, index },
    };
  }
  if (action.type === "cardRemoved") return removeCard(state, action.cardId);
  if (action.type === "removeUndone") return undoRemove(state);
  if (action.type === "removeExpired") return { ...state, removedCard: undefined };
  if (action.type === "addUndone") return undoAdd(state);
  if (action.type === "addExpired") return { ...state, addedCard: undefined };
  if (action.type === "discarded") return discardDraft(state);
  if (action.type === "defaultsRestored") return restoreDefaults(state);
  if (action.type === "saveStarted") {
    return { ...state, saveStatus: "saving", message: undefined };
  }
  if (action.type === "saved") return applySavedLayout(state, action.response);
  if (action.type === "saveFailed") {
    return { ...state, saveStatus: action.kind, message: action.message };
  }
  return { ...state, saveStatus: "idle", message: undefined };
}

export function createDashboardCard(
  component: Exclude<DashboardLayoutComponent, "pieChart" | "report">,
  cards: readonly DashboardLayoutCard[],
  createSuffix = createCardSuffix,
): DashboardLayoutCard {
  const id = uniqueId(component, cards, createSuffix());
  const size = DASHBOARD_COMPONENT_REGISTRY[component].defaultSize;
  if (component === "metric") {
    return { id, component, size, config: { metric: "sales" } };
  }
  if (component === "salesTrend") {
    return { id, component, size, config: { range: "7d" } };
  }
  if (component === "inventoryAlerts") {
    return { id, component, size, config: { limit: 4 } };
  }
  return { id, component, size, config: { limit: 3 } };
}

export function createInsightDashboardCard(
  component: "pieChart" | "report",
  title: string,
  query: DashboardInsightQuery,
  cards: readonly DashboardLayoutCard[],
  createSuffix = createCardSuffix,
): DashboardLayoutCard {
  const id = uniqueId(component, cards, createSuffix());
  const size = DASHBOARD_COMPONENT_REGISTRY[component].defaultSize;
  if (component === "pieChart") return { id, component, size, config: { title, query } };
  return { id, component, size, config: { title, query } };
}

function createCardSuffix(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  // Public HTTP origins lack randomUUID, but still expose secure random bytes.
  // These are card identifiers, never authentication tokens.
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new Error("当前浏览器不支持创建卡片，请升级浏览器或使用 HTTPS 访问。");
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function applyLoadedLayout(
  state: LayoutEditorState,
  response: DashboardLayoutReadResponse,
): LayoutEditorState {
  const layout = cloneLayout(response.layout);
  return {
    ...state,
    baseline: layout,
    draft: cloneLayout(layout),
    revision: response.revision,
    loadStatus: "ready",
    saveStatus: "idle",
    message: undefined,
    removedCard: undefined,
    addedCard: undefined,
  };
}

function applySavedLayout(
  state: LayoutEditorState,
  response: DashboardLayoutReadResponse,
): LayoutEditorState {
  const layout = cloneLayout(response.layout);
  return {
    ...state,
    baseline: layout,
    draft: cloneLayout(layout),
    revision: response.revision,
    mode: "view",
    saveStatus: "saved",
    message: "已保存",
    removedCard: undefined,
    addedCard: undefined,
  };
}

function withCards(
  state: LayoutEditorState,
  cards: readonly DashboardLayoutCard[],
): LayoutEditorState {
  return {
    ...state,
    draft: { ...state.draft, cards: [...cards] },
    saveStatus: "idle",
    message: undefined,
  };
}

function removeCard(state: LayoutEditorState, cardId: string): LayoutEditorState {
  const index = state.draft.cards.findIndex((card) => card.id === cardId);
  const card = state.draft.cards[index];
  if (!card) return state;
  return {
    ...withCards(
      state,
      state.draft.cards.filter((candidate) => candidate.id !== cardId),
    ),
    removedCard: { card, index },
    addedCard: undefined,
  };
}

function undoRemove(state: LayoutEditorState): LayoutEditorState {
  if (!state.removedCard) return state;
  const cards = [...state.draft.cards];
  cards.splice(Math.min(state.removedCard.index, cards.length), 0, state.removedCard.card);
  return { ...withCards(state, cards), removedCard: undefined };
}

function undoAdd(state: LayoutEditorState): LayoutEditorState {
  if (!state.addedCard) return state;
  const id = state.addedCard.card.id;
  const cards = state.draft.cards.filter((card) => card.id !== id);
  return { ...withCards(state, cards), addedCard: undefined };
}

function discardDraft(state: LayoutEditorState): LayoutEditorState {
  return {
    ...state,
    draft: cloneLayout(state.baseline),
    mode: "view",
    saveStatus: "idle",
    message: undefined,
    removedCard: undefined,
    addedCard: undefined,
  };
}

function restoreDefaults(state: LayoutEditorState): LayoutEditorState {
  return {
    ...state,
    draft: cloneLayout(DEFAULT_DASHBOARD_LAYOUT),
    saveStatus: "idle",
    message: undefined,
    removedCard: undefined,
    addedCard: undefined,
  };
}

function uniqueId(
  component: DashboardLayoutComponent,
  cards: readonly DashboardLayoutCard[],
  suffix: string,
): string {
  const safeSuffix = suffix.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || "card";
  const base = `${component}-${safeSuffix}`.slice(0, 64);
  const existing = new Set(cards.map(({ id }) => id));
  if (!existing.has(base)) return base;
  for (let index = 2; index <= cards.length + 2; index += 1) {
    const candidate = `${base.slice(0, 60)}-${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error("无法生成唯一卡片 ID");
}

function cloneLayout(layout: DashboardLayout): DashboardLayout {
  return { ...layout, cards: layout.cards.map(cloneCard) };
}

function cloneCard(card: DashboardLayoutCard): DashboardLayoutCard {
  if (card.component === "metric") {
    return { ...card, config: { ...card.config } };
  }
  if (card.component === "salesTrend") {
    return { ...card, config: { ...card.config } };
  }
  if (card.component === "inventoryAlerts") {
    return { ...card, config: { ...card.config } };
  }
  if (card.component === "hotProducts") {
    return { ...card, config: { ...card.config } };
  }
  if (card.component === "pieChart") {
    return { ...card, config: { ...card.config, query: { ...card.config.query } } };
  }
  return { ...card, config: { ...card.config, query: { ...card.config.query } } };
}

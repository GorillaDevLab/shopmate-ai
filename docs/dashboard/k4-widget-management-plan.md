# K4 Dashboard Widget Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the K3 dashboard editor to the K2 layout API and add controlled widget creation, deletion with undo, read-only preview, explicit save, discard, and default-layout recovery without losing drafts on failure.

**Architecture:** A pure reducer owns the server baseline, local draft, revision, mode, and operation status. A small authenticated API client validates every request and response with shared Zod contracts. The existing K3 editor continues to render and manipulate cards, while a focused Widget Gallery and editor chrome provide K4 workflows.

**Tech Stack:** Next.js 16, React 19, TypeScript 5, Tailwind CSS 4, Zod contracts from `@shopmate/contracts`, Vitest, Testing Library, Playwright.

## Global Constraints

- Scope is Issue #117 only; K5 AI DSL, K6 monitoring, and K7 full E2E coverage are excluded.
- Do not add Zustand, a drag library, or a motion library in K4.
- Never send `userId` or `merchantId` from the browser; authentication uses `credentials: "include"`.
- Validate GET responses and PUT requests with the shared dashboard layout schemas.
- A failed or conflicted save must preserve the local draft.
- Restoring defaults changes the draft only and still requires explicit save.
- The dashboard supports a maximum of 24 cards.
- All interactive targets remain at least 44px on touch screens.
- Reduced-motion mode uses short opacity transitions and disables scale-heavy motion.

---

### Task 1: Authenticated dashboard layout API client

**Files:**
- Create: `apps/web/src/app/dashboard-layout-api.ts`
- Create: `apps/web/src/app/dashboard-layout-api.test.ts`

**Interfaces:**
- Consumes: `DashboardLayoutReadResponseSchema`, `DashboardLayoutSaveRequestSchema`, `DashboardLayoutSaveRequest` from `@shopmate/contracts`.
- Produces: `fetchDashboardLayout(signal?): Promise<DashboardLayoutReadResponse>`, `saveDashboardLayout(request, signal?): Promise<DashboardLayoutReadResponse>`, and `DashboardLayoutApiError` with `status` and `retryable`.

- [ ] **Step 1: Write failing GET, PUT, validation, and error tests**

```ts
import { DEFAULT_DASHBOARD_LAYOUT } from "@shopmate/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DashboardLayoutApiError,
  fetchDashboardLayout,
  saveDashboardLayout,
} from "./dashboard-layout-api";

describe("dashboard layout API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the authenticated user's layout", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(defaultResponse())));
    await expect(fetchDashboardLayout()).resolves.toEqual(defaultResponse());
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/dashboard/layout",
      expect.objectContaining({ credentials: "include", cache: "no-store" }),
    );
  });

  it("saves a validated draft with the expected revision", async () => {
    const response = { ...defaultResponse(), revision: 1, updatedAt: "2026-09-02T00:00:00.000Z" };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(response)));
    await expect(
      saveDashboardLayout({ layout: DEFAULT_DASHBOARD_LAYOUT, expectedRevision: 0 }),
    ).resolves.toEqual(response);
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/dashboard/layout",
      expect.objectContaining({
        method: "PUT",
        credentials: "include",
        body: JSON.stringify({ layout: DEFAULT_DASHBOARD_LAYOUT, expectedRevision: 0 }),
      }),
    );
  });

  it("rejects malformed responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ revision: 0 })));
    await expect(fetchDashboardLayout()).rejects.toMatchObject({ status: 502 });
  });

  it("classifies revision conflicts without leaking server details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "raw database detail" }, 409)));
    await expect(
      saveDashboardLayout({ layout: DEFAULT_DASHBOARD_LAYOUT, expectedRevision: 0 }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<DashboardLayoutApiError>>({
        status: 409,
        retryable: true,
        message: "布局已在其他设备更新，你的草稿仍然保留",
      }),
    );
  });
});

function defaultResponse() {
  return { layout: DEFAULT_DASHBOARD_LAYOUT, revision: 0 as const, updatedAt: null };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
```

- [ ] **Step 2: Run the focused test and confirm the missing module failure**

Run: `pnpm --filter @shopmate/web test -- dashboard-layout-api.test.ts`

Expected: FAIL because `dashboard-layout-api.ts` does not exist.

- [ ] **Step 3: Implement the validated client**

```ts
import {
  DashboardLayoutReadResponseSchema,
  DashboardLayoutSaveRequestSchema,
  type DashboardLayoutReadResponse,
  type DashboardLayoutSaveRequest,
} from "@shopmate/contracts";

export class DashboardLayoutApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DashboardLayoutApiError";
  }
}

export function fetchDashboardLayout(signal?: AbortSignal) {
  return requestLayout({ method: "GET", signal });
}

export function saveDashboardLayout(request: DashboardLayoutSaveRequest, signal?: AbortSignal) {
  const parsed = DashboardLayoutSaveRequestSchema.safeParse(request);
  if (!parsed.success) throw new DashboardLayoutApiError("看板布局格式无效", 400, false);
  return requestLayout({ method: "PUT", body: JSON.stringify(parsed.data), signal });
}

async function requestLayout(init: { method: "GET" | "PUT"; body?: string; signal?: AbortSignal }) {
  let response: Response;
  try {
    response = await fetch("/api/v1/dashboard/layout", {
      ...init,
      credentials: "include",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new DashboardLayoutApiError("无法连接布局服务，请检查网络后重试", 0, true);
  }
  if (!response.ok) throwHttpError(response.status);
  const payload = await response.json().catch(() => undefined);
  const parsed = DashboardLayoutReadResponseSchema.safeParse(payload);
  if (!parsed.success) throw new DashboardLayoutApiError("布局服务响应格式异常", 502, true);
  return parsed.data satisfies DashboardLayoutReadResponse;
}

function throwHttpError(status: number): never {
  if (status === 401) throw new DashboardLayoutApiError("登录已失效，请重新登录", 401, false);
  if (status === 409)
    throw new DashboardLayoutApiError("布局已在其他设备更新，你的草稿仍然保留", 409, true);
  if (status === 400) throw new DashboardLayoutApiError("看板布局格式无效", 400, false);
  throw new DashboardLayoutApiError("布局服务暂时不可用，请稍后重试", status, true);
}
```

- [ ] **Step 4: Run focused verification**

Run: `pnpm --filter @shopmate/web test -- dashboard-layout-api.test.ts && pnpm --filter @shopmate/web typecheck && pnpm --filter @shopmate/web lint`

Expected: API tests, TypeScript, and lint all PASS.

- [ ] **Step 5: Commit the API client**

```bash
git add apps/web/src/app/dashboard-layout-api.ts apps/web/src/app/dashboard-layout-api.test.ts
git commit -m "feat: add dashboard layout API client"
```

### Task 2: Pure draft reducer and controlled card factory

**Files:**
- Create: `apps/web/src/app/dashboard-layout-state.ts`
- Create: `apps/web/src/app/dashboard-layout-state.test.ts`

**Interfaces:**
- Consumes: `DashboardLayout`, `DashboardLayoutCard`, `DashboardLayoutReadResponse`, `DEFAULT_DASHBOARD_LAYOUT`.
- Produces: `LayoutEditorState`, `LayoutEditorAction`, `layoutEditorReducer`, `initialLayoutEditorState`, `isLayoutDirty`, and `createDashboardCard`.

- [ ] **Step 1: Write reducer tests for load, edit, delete/undo, discard, defaults, save, and conflict**

```ts
import { DEFAULT_DASHBOARD_LAYOUT } from "@shopmate/contracts";
import { describe, expect, it } from "vitest";

import {
  createDashboardCard,
  initialLayoutEditorState,
  isLayoutDirty,
  layoutEditorReducer,
} from "./dashboard-layout-state";

describe("dashboard layout state", () => {
  it("loads a server baseline and derives dirty state", () => {
    const loaded = layoutEditorReducer(initialLayoutEditorState, {
      type: "loaded",
      response: { layout: DEFAULT_DASHBOARD_LAYOUT, revision: 0, updatedAt: null },
    });
    const changed = layoutEditorReducer(loaded, {
      type: "cardsChanged",
      cards: loaded.draft.cards.slice(1),
    });
    expect(isLayoutDirty(loaded)).toBe(false);
    expect(isLayoutDirty(changed)).toBe(true);
  });

  it("restores a removed card at its original index", () => {
    const ready = layoutEditorReducer(initialLayoutEditorState, {
      type: "loaded",
      response: { layout: DEFAULT_DASHBOARD_LAYOUT, revision: 0, updatedAt: null },
    });
    const removed = layoutEditorReducer(ready, { type: "cardRemoved", cardId: "metric-orders" });
    const restored = layoutEditorReducer(removed, { type: "removeUndone" });
    expect(restored.draft.cards).toEqual(DEFAULT_DASHBOARD_LAYOUT.cards);
  });

  it("keeps the draft after a revision conflict", () => {
    const ready = layoutEditorReducer(initialLayoutEditorState, {
      type: "loaded",
      response: { layout: DEFAULT_DASHBOARD_LAYOUT, revision: 0, updatedAt: null },
    });
    const changed = layoutEditorReducer(ready, {
      type: "cardsChanged",
      cards: ready.draft.cards.slice(1),
    });
    const conflicted = layoutEditorReducer(changed, {
      type: "saveFailed",
      kind: "conflict",
      message: "布局已在其他设备更新，你的草稿仍然保留",
    });
    expect(conflicted.draft).toEqual(changed.draft);
    expect(conflicted.saveStatus).toBe("conflict");
  });

  it("creates unique cards with safe defaults", () => {
    const card = createDashboardCard("salesTrend", DEFAULT_DASHBOARD_LAYOUT.cards, () => "fixed");
    expect(card).toEqual({
      id: "salesTrend-fixed",
      component: "salesTrend",
      size: "2/3",
      config: { range: "7d" },
    });
  });
});
```

- [ ] **Step 2: Run the reducer test and confirm it fails**

Run: `pnpm --filter @shopmate/web test -- dashboard-layout-state.test.ts`

Expected: FAIL because the reducer module does not exist.

- [ ] **Step 3: Implement the state machine and factory**

```ts
import {
  DEFAULT_DASHBOARD_LAYOUT,
  type DashboardLayout,
  type DashboardLayoutCard,
  type DashboardLayoutComponent,
  type DashboardLayoutReadResponse,
} from "@shopmate/contracts";

export type LayoutEditorMode = "view" | "edit" | "preview";
export type LayoutEditorState = {
  baseline: DashboardLayout;
  draft: DashboardLayout;
  revision: number;
  mode: LayoutEditorMode;
  loadStatus: "loading" | "ready" | "error";
  saveStatus: "idle" | "saving" | "saved" | "error" | "conflict";
  message?: string;
  removedCard?: { card: DashboardLayoutCard; index: number };
};

export type LayoutEditorAction =
  | { type: "loaded"; response: DashboardLayoutReadResponse }
  | { type: "loadFailed"; message: string }
  | { type: "modeChanged"; mode: LayoutEditorMode }
  | { type: "cardsChanged"; cards: DashboardLayoutCard[] }
  | { type: "cardAdded"; card: DashboardLayoutCard }
  | { type: "cardRemoved"; cardId: string }
  | { type: "removeUndone" }
  | { type: "removeExpired" }
  | { type: "discarded" }
  | { type: "defaultsRestored" }
  | { type: "saveStarted" }
  | { type: "saved"; response: DashboardLayoutReadResponse }
  | { type: "saveFailed"; kind: "error" | "conflict"; message: string };

export const initialLayoutEditorState: LayoutEditorState = {
  baseline: DEFAULT_DASHBOARD_LAYOUT,
  draft: DEFAULT_DASHBOARD_LAYOUT,
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
  switch (action.type) {
    case "loaded":
      return {
        ...state,
        baseline: action.response.layout,
        draft: action.response.layout,
        revision: action.response.revision,
        loadStatus: "ready",
        saveStatus: "idle",
        message: undefined,
        removedCard: undefined,
      };
    case "cardsChanged":
      return { ...state, draft: { ...state.draft, cards: action.cards }, saveStatus: "idle" };
    case "cardAdded":
      return {
        ...state,
        draft: { ...state.draft, cards: [...state.draft.cards, action.card] },
        saveStatus: "idle",
      };
    case "cardRemoved": {
      const index = state.draft.cards.findIndex((card) => card.id === action.cardId);
      const card = state.draft.cards[index];
      if (!card) return state;
      return {
        ...state,
        draft: { ...state.draft, cards: state.draft.cards.filter(({ id }) => id !== action.cardId) },
        removedCard: { card, index },
        saveStatus: "idle",
      };
    }
    case "removeUndone": {
      if (!state.removedCard) return state;
      const cards = [...state.draft.cards];
      cards.splice(state.removedCard.index, 0, state.removedCard.card);
      return { ...state, draft: { ...state.draft, cards }, removedCard: undefined };
    }
    case "removeExpired":
      return { ...state, removedCard: undefined };
    case "discarded":
      return { ...state, draft: state.baseline, mode: "view", saveStatus: "idle", removedCard: undefined };
    case "defaultsRestored":
      return { ...state, draft: DEFAULT_DASHBOARD_LAYOUT, saveStatus: "idle", removedCard: undefined };
    case "saveStarted":
      return { ...state, saveStatus: "saving", message: undefined };
    case "saved":
      return {
        ...state,
        baseline: action.response.layout,
        draft: action.response.layout,
        revision: action.response.revision,
        mode: "view",
        saveStatus: "saved",
        removedCard: undefined,
      };
    case "saveFailed":
      return { ...state, saveStatus: action.kind, message: action.message };
    case "loadFailed":
      return { ...state, loadStatus: "error", message: action.message };
    case "modeChanged":
      return { ...state, mode: action.mode };
  }
}

export function createDashboardCard(
  component: DashboardLayoutComponent,
  cards: readonly DashboardLayoutCard[],
  createSuffix = () => crypto.randomUUID(),
): DashboardLayoutCard {
  const id = uniqueId(component, cards, createSuffix());
  if (component === "metric")
    return { id, component, size: "1/3", config: { metric: "sales" } };
  if (component === "salesTrend")
    return { id, component, size: "2/3", config: { range: "7d" } };
  if (component === "inventoryAlerts")
    return { id, component, size: "1/3", config: { limit: 4 } };
  return { id, component, size: "full", config: { limit: 3 } };
}

function uniqueId(
  component: DashboardLayoutComponent,
  cards: readonly DashboardLayoutCard[],
  suffix: string,
): string {
  const safeSuffix = suffix.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || "card";
  const base = `${component}-${safeSuffix}`.slice(0, 64);
  if (!cards.some(({ id }) => id === base)) return base;
  return `${base.slice(0, 61)}-${cards.length}`;
}
```

- [ ] **Step 4: Add the remaining reducer cases and test them**

Add focused tests asserting:

```ts
expect(layoutEditorReducer(changed, { type: "discarded" }).draft).toEqual(changed.baseline);
expect(layoutEditorReducer(changed, { type: "defaultsRestored" }).draft).toEqual(
  DEFAULT_DASHBOARD_LAYOUT,
);
expect(layoutEditorReducer(changed, { type: "saveStarted" }).saveStatus).toBe("saving");
expect(
  layoutEditorReducer(changed, {
    type: "saved",
    response: { layout: changed.draft, revision: 2, updatedAt: "2026-09-02T00:00:00.000Z" },
  }),
).toMatchObject({ baseline: changed.draft, revision: 2, mode: "view", saveStatus: "saved" });
```

Run: `pnpm --filter @shopmate/web test -- dashboard-layout-state.test.ts && pnpm --filter @shopmate/web typecheck && pnpm --filter @shopmate/web lint`

Expected: reducer tests, TypeScript, and lint all PASS.

- [ ] **Step 5: Commit the reducer**

```bash
git add apps/web/src/app/dashboard-layout-state.ts apps/web/src/app/dashboard-layout-state.test.ts
git commit -m "feat: model dashboard layout drafts"
```

### Task 3: Controlled Widget Gallery

**Files:**
- Create: `apps/web/src/app/dashboard-widget-gallery.tsx`
- Create: `apps/web/src/app/dashboard-widget-gallery.test.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**
- Consumes: `DashboardLayoutComponent`, `DASHBOARD_COMPONENT_REGISTRY`.
- Produces: `DashboardWidgetGallery({ open, cardCount, onAdd, onClose })`.

- [ ] **Step 1: Write interaction and limit tests**

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DashboardWidgetGallery } from "./dashboard-widget-gallery";

describe("DashboardWidgetGallery", () => {
  it("previews a controlled widget and confirms the selection", () => {
    const onAdd = vi.fn();
    render(<DashboardWidgetGallery open cardCount={7} onAdd={onAdd} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "销售趋势" }));
    expect(screen.getByRole("heading", { name: "销售趋势" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加到看板" }));
    expect(onAdd).toHaveBeenCalledWith("salesTrend");
  });

  it("at 24 cards disables adding and explains the limit", () => {
    render(<DashboardWidgetGallery open cardCount={24} onAdd={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "添加到看板" })).toBeDisabled();
    expect(screen.getByText("看板最多包含 24 张卡片")).toBeInTheDocument();
  });

  it("closes with Escape", () => {
    const onClose = vi.fn();
    render(<DashboardWidgetGallery open cardCount={7} onAdd={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `pnpm --filter @shopmate/web test -- dashboard-widget-gallery.test.tsx`

Expected: FAIL because the gallery module does not exist.

- [ ] **Step 3: Implement the gallery with a native dialog and controlled choices**

```tsx
"use client";

import {
  DASHBOARD_COMPONENT_REGISTRY,
  type DashboardLayoutComponent,
} from "@shopmate/contracts";
import { useEffect, useRef, useState } from "react";

type Props = {
  open: boolean;
  cardCount: number;
  onAdd: (component: DashboardLayoutComponent) => void;
  onClose: () => void;
};

const components = Object.keys(DASHBOARD_COMPONENT_REGISTRY) as DashboardLayoutComponent[];

export function DashboardWidgetGallery({ open, cardCount, onAdd, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<DashboardLayoutComponent>("metric");
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  const full = cardCount >= 24;
  return (
    <dialog
      ref={dialogRef}
      className="widget-gallery"
      aria-labelledby="widget-gallery-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div className="widget-gallery-shell">
        <header>
          <div>
            <p className="eyebrow">组件库</p>
            <h2 id="widget-gallery-title">添加经营组件</h2>
          </div>
          <button type="button" aria-label="关闭组件库" onClick={onClose}>×</button>
        </header>
        <div className="widget-gallery-body">
          <nav aria-label="可添加组件">
            {components.map((component) => (
              <button
                key={component}
                type="button"
                aria-pressed={selected === component}
                onClick={() => setSelected(component)}
              >
                {DASHBOARD_COMPONENT_REGISTRY[component].label}
              </button>
            ))}
          </nav>
          <section aria-live="polite">
            <h3>{DASHBOARD_COMPONENT_REGISTRY[selected].label}</h3>
            <p>{previewCopy(selected)}</p>
            {full && <p role="status">看板最多包含 24 张卡片</p>}
            <button type="button" disabled={full} onClick={() => onAdd(selected)}>
              添加到看板
            </button>
          </section>
        </div>
      </div>
    </dialog>
  );
}

function previewCopy(component: DashboardLayoutComponent): string {
  if (component === "metric") return "突出显示一个核心经营指标。";
  if (component === "salesTrend") return "查看当前统计周期的每日销售变化。";
  if (component === "inventoryAlerts") return "集中查看需要补货的商品。";
  return "展示当前周期表现最好的商品。";
}
```

- [ ] **Step 4: Add responsive gallery styles**

Append the following token-based styles to `globals.css`:

```css
.widget-gallery {
  width: min(720px, calc(100vw - 32px));
  max-width: none;
  margin: auto;
  overflow: hidden;
  border: 1px solid var(--app-line);
  border-radius: 24px;
  background: var(--app-surface);
  color: var(--app-text);
  box-shadow: 0 28px 80px color-mix(in srgb, var(--app-text) 16%, transparent);
}
.widget-gallery::backdrop {
  background: color-mix(in srgb, var(--app-text) 22%, transparent);
  backdrop-filter: blur(3px);
}
.widget-gallery-shell > header {
  display: flex;
  min-height: 76px;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid var(--app-line);
  padding: 14px 18px;
}
.widget-gallery-shell > header button {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border-radius: 12px;
}
.widget-gallery-body {
  display: grid;
  grid-template-columns: minmax(180px, 0.7fr) minmax(0, 1.3fr);
  min-height: 360px;
}
.widget-gallery-body nav {
  display: grid;
  align-content: start;
  gap: 6px;
  border-right: 1px solid var(--app-line);
  padding: 14px;
}
.widget-gallery-body nav button {
  min-height: 44px;
  border-radius: 12px;
  padding: 0 12px;
  text-align: left;
}
.widget-gallery-body nav button[aria-pressed="true"] {
  background: var(--brand-soft);
  color: var(--brand-strong);
  font-weight: 700;
}
.widget-gallery-body > section {
  display: grid;
  align-content: center;
  justify-items: start;
  gap: 14px;
  padding: 28px;
}
.widget-gallery-body > section > button {
  min-height: 44px;
  border-radius: 12px;
  background: var(--brand);
  padding: 0 18px;
  color: white;
  font-weight: 700;
}
@media (max-width: 639px) {
  .widget-gallery {
    inset: auto 0 0;
    width: 100%;
    margin: 0;
    border-width: 1px 0 0;
    border-radius: 24px 24px 0 0;
    padding-bottom: env(safe-area-inset-bottom);
  }
  .widget-gallery-body {
    grid-template-columns: 1fr;
  }
  .widget-gallery-body nav {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    border-right: 0;
    border-bottom: 1px solid var(--app-line);
  }
}
```

Run: `pnpm --filter @shopmate/web test -- dashboard-widget-gallery.test.tsx && pnpm --filter @shopmate/web typecheck && pnpm --filter @shopmate/web lint`

Expected: gallery tests, TypeScript, and lint all PASS.

- [ ] **Step 5: Commit the gallery**

```bash
git add apps/web/src/app/dashboard-widget-gallery.tsx apps/web/src/app/dashboard-widget-gallery.test.tsx apps/web/src/app/globals.css
git commit -m "feat: add dashboard widget gallery"
```

### Task 4: Integrate drafts, preview, save, discard, restore, delete, and undo

**Files:**
- Modify: `apps/web/src/app/dashboard-layout-editor.tsx`
- Modify: `apps/web/src/app/dashboard-layout-editor.test.tsx`
- Modify: `apps/web/src/app/dashboard.tsx`

**Interfaces:**
- Consumes: API client from Task 1, reducer/factory from Task 2, Gallery from Task 3.
- Produces: a K4-complete `DashboardLayoutEditor` that loads and saves authenticated layouts.

- [ ] **Step 1: Replace test setup with a valid layout GET mock**

Add this helper and call it before each editor render:

```ts
function mockLayoutApi() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/v1/dashboard/layout" && init?.method === "PUT") {
      const request = JSON.parse(String(init.body)) as { layout: unknown };
      return jsonResponse({
        layout: request.layout,
        revision: 1,
        updatedAt: "2026-09-02T00:00:00.000Z",
      });
    }
    if (input === "/api/v1/dashboard/layout") {
      return jsonResponse({ layout: DEFAULT_DASHBOARD_LAYOUT, revision: 0, updatedAt: null });
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
}
```

Add `beforeEach(mockLayoutApi)` and `afterEach(() => vi.restoreAllMocks())`, then update existing tests to await the loaded layout before entering edit mode.

- [ ] **Step 2: Write failing K4 user-flow tests**

```tsx
it("adds a widget, previews the draft, and saves it", async () => {
  render(<DashboardLayoutEditor data={dashboardResponsePreview} periodLabel="近 7 天" />);
  await screen.findByRole("button", { name: "编辑看板" });
  fireEvent.click(screen.getByRole("button", { name: "编辑看板" }));
  fireEvent.click(screen.getByRole("button", { name: "添加组件" }));
  fireEvent.click(screen.getByRole("button", { name: "销售趋势" }));
  fireEvent.click(screen.getByRole("button", { name: "添加到看板" }));
  fireEvent.click(screen.getByRole("button", { name: "预览" }));
  expect(screen.queryByRole("button", { name: /删除/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "返回编辑" }));
  fireEvent.click(screen.getByRole("button", { name: "完成并保存" }));
  await waitFor(() => expect(screen.getByText("已保存")).toBeInTheDocument());
  expect(fetch).toHaveBeenCalledWith(
    "/api/v1/dashboard/layout",
    expect.objectContaining({ method: "PUT", credentials: "include" }),
  );
});

it("deletes and restores a card with Undo", async () => {
  render(<DashboardLayoutEditor data={dashboardResponsePreview} periodLabel="近 7 天" />);
  await screen.findByRole("button", { name: "编辑看板" });
  fireEvent.click(screen.getByRole("button", { name: "编辑看板" }));
  fireEvent.click(within(card("metric-orders")).getByRole("button", { name: "订单更多操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
  expect(cardOrder()).not.toContain("metric-orders");
  fireEvent.click(screen.getByRole("button", { name: "撤销删除订单" }));
  expect(cardOrder()).toContain("metric-orders");
});

it("keeps the draft when save conflicts", async () => {
  mockLayoutApiWithPutStatus(409);
  render(<DashboardLayoutEditor data={dashboardResponsePreview} periodLabel="近 7 天" />);
  await screen.findByRole("button", { name: "编辑看板" });
  fireEvent.click(screen.getByRole("button", { name: "编辑看板" }));
  fireEvent.click(screen.getByRole("button", { name: "销售额下移" }));
  const changedOrder = cardOrder();
  fireEvent.click(screen.getByRole("button", { name: "完成并保存" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("其他设备");
  expect(cardOrder()).toEqual(changedOrder);
});
```

- [ ] **Step 3: Run the editor test and confirm new flows fail**

Run: `pnpm --filter @shopmate/web test -- dashboard-layout-editor.test.tsx`

Expected: FAIL because K4 controls and API orchestration are absent.

- [ ] **Step 4: Initialize reducer state from the authenticated API**

Replace local `cards`, `isEditing`, and `isDirty` state with:

```ts
const [state, dispatch] = useReducer(layoutEditorReducer, initialLayoutEditorState);
const [galleryOpen, setGalleryOpen] = useState(false);
const [menuCardId, setMenuCardId] = useState<string>();
const isEditing = state.mode === "edit";
const cards = state.draft.cards;
const isDirty = isLayoutDirty(state);

useEffect(() => {
  const controller = new AbortController();
  void fetchDashboardLayout(controller.signal).then(
    (response) => dispatch({ type: "loaded", response }),
    (error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      dispatch({
        type: "loadFailed",
        message: error instanceof Error ? error.message : "布局加载失败，请重试",
      });
    },
  );
  return () => controller.abort();
}, []);
```

Every existing reorder and resize operation must dispatch `cardsChanged` with a new card array. Do not mutate `state.draft.cards`.

- [ ] **Step 5: Implement explicit save and failure preservation**

```ts
const saveDraft = async () => {
  if (!isDirty || state.saveStatus === "saving") {
    dispatch({ type: "modeChanged", mode: "view" });
    return;
  }
  dispatch({ type: "saveStarted" });
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
};
```

Render `role="alert"` for conflict/error, `role="status"` for saving/saved, and a login link for 401 load errors.

- [ ] **Step 6: Implement Gallery, card More Menu, delete/undo, preview, discard, and defaults**

Wire the Gallery as follows:

```tsx
<DashboardWidgetGallery
  open={galleryOpen}
  cardCount={cards.length}
  onClose={() => setGalleryOpen(false)}
  onAdd={(component) => {
    dispatch({ type: "cardAdded", card: createDashboardCard(component, cards) });
    setGalleryOpen(false);
  }}
/>
```

Use a focused `CardMoreMenu` with `role="menu"`, preset size actions, and `删除`. On delete dispatch `cardRemoved`; start a 4-second effect that dispatches `removeExpired`. The toast button dispatches `removeUndone`. Preview dispatches `modeChanged: "preview"`; Return dispatches `"edit"`; discard dispatches `discarded`; confirmed reset dispatches `defaultsRestored`.

Register unload protection only while dirty:

```ts
useEffect(() => {
  if (!isDirty) return;
  const warn = (event: BeforeUnloadEvent) => event.preventDefault();
  window.addEventListener("beforeunload", warn);
  return () => window.removeEventListener("beforeunload", warn);
}, [isDirty]);
```

- [ ] **Step 7: Keep Dashboard overlays mutually exclusive**

Extend the existing `onEditingChange` callback so entering edit or preview mode closes the AI assistant. Opening the assistant should leave view mode unchanged; do not discard a layout draft automatically.

- [ ] **Step 8: Run K4 editor verification**

Run: `pnpm --filter @shopmate/web test -- dashboard-layout-editor.test.tsx dashboard-widget-gallery.test.tsx dashboard-layout-state.test.ts dashboard-layout-api.test.ts && pnpm --filter @shopmate/web typecheck && pnpm --filter @shopmate/web lint`

Expected: all K4 tests, TypeScript, and lint PASS.

- [ ] **Step 9: Commit the integrated workflows**

```bash
git add apps/web/src/app/dashboard-layout-editor.tsx apps/web/src/app/dashboard-layout-editor.test.tsx apps/web/src/app/dashboard.tsx
git commit -m "feat: manage dashboard layout drafts"
```

### Task 5: Responsive, accessible K4 polish

**Files:**
- Modify: `apps/web/src/app/globals.css`
- Modify: `apps/web/src/app/responsive-a11y.test.tsx`
- Modify: `apps/web/src/app/dashboard-layout-editor.test.tsx`

**Interfaces:**
- Consumes: K4 classes and accessible labels from Tasks 3–4.
- Produces: desktop modal, 375px bottom sheet, accessible menus/dialogs/status, and reduced-motion behavior.

- [ ] **Step 1: Add failing responsive and accessibility assertions**

```tsx
expect(screen.getByRole("dialog", { name: "添加经营组件" })).toHaveClass("widget-gallery");
expect(screen.getByRole("button", { name: "关闭组件库" })).toHaveAccessibleName();
expect(screen.getByRole("button", { name: "完成并保存" })).toHaveClass("layout-save-button");
expect(screen.getByRole("status", { name: "布局保存状态" })).toBeInTheDocument();
```

Add a source-level reduced-motion assertion that `globals.css` contains rules for `.widget-gallery`, `.layout-undo-toast`, and `.dashboard-layout-card` inside `@media (prefers-reduced-motion: reduce)`.

- [ ] **Step 2: Run accessibility tests and confirm they fail**

Run: `pnpm --filter @shopmate/web test -- responsive-a11y.test.tsx dashboard-layout-editor.test.tsx`

Expected: FAIL until K4 class names and reduced-motion styles exist.

- [ ] **Step 3: Add final CSS states**

Implement these named states using existing theme tokens:

```css
.layout-editor-toolbar {
  display: flex;
  min-height: 52px;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 4px 0 8px;
}
.layout-editor-toolbar button {
  min-height: 44px;
  border-radius: 12px;
  padding: 0 14px;
}
.layout-save-button {
  background: var(--brand);
  color: white;
  font-weight: 750;
}
.layout-save-button:disabled {
  cursor: default;
  opacity: 0.48;
}
.layout-card-more-menu {
  position: absolute;
  z-index: 12;
  top: 50px;
  right: 8px;
  min-width: 180px;
  overflow: hidden;
  border: 1px solid var(--app-line);
  border-radius: 14px;
  background: var(--app-surface);
  padding: 6px;
  box-shadow: 0 18px 48px color-mix(in srgb, var(--app-text) 14%, transparent);
  transform-origin: top right;
}
.layout-card-more-menu [role="menuitem"] {
  display: flex;
  width: 100%;
  min-height: 44px;
  align-items: center;
  border-radius: 10px;
  padding: 0 10px;
}
.layout-undo-toast {
  position: fixed;
  z-index: 55;
  right: 20px;
  bottom: max(20px, calc(env(safe-area-inset-bottom) + 12px));
  display: flex;
  min-height: 48px;
  align-items: center;
  gap: 14px;
  border: 1px solid var(--app-line);
  border-radius: 999px;
  background: var(--app-text);
  padding: 0 8px 0 16px;
  color: var(--app-surface);
  box-shadow: 0 16px 44px color-mix(in srgb, var(--app-text) 20%, transparent);
}
.layout-undo-toast button {
  min-height: 40px;
  border-radius: 999px;
  padding: 0 12px;
  color: var(--brand-soft);
  font-weight: 750;
}

@media (max-width: 639px) {
  .layout-editor-toolbar {
    position: sticky;
    z-index: 20;
    top: 0;
    overflow-x: auto;
    justify-content: flex-start;
    background: var(--app-bg);
  }
  .layout-undo-toast {
    right: 12px;
    bottom: max(12px, calc(env(safe-area-inset-bottom) + 8px));
    left: 12px;
    justify-content: space-between;
  }
}

@media (prefers-reduced-motion: reduce) {
  .widget-gallery,
  .layout-undo-toast,
  .dashboard-layout-card {
    transition-duration: 120ms;
    transform: none;
  }
}
```

Use explicit declarations rather than `transition: all`. Ensure menus and toasts do not cover the fixed AI assistant; when edit mode is active the assistant remains hidden.

- [ ] **Step 4: Run the complete Web verification gate**

Run:

```bash
pnpm --filter @shopmate/web test
pnpm --filter @shopmate/web typecheck
pnpm --filter @shopmate/web lint
pnpm --filter @shopmate/web build
pnpm secret:scan
```

Expected: all tests PASS, TypeScript and lint report no errors, Next build succeeds, and secret scan finds no committed secret.

- [ ] **Step 5: Commit the polish**

```bash
git add apps/web/src/app/globals.css apps/web/src/app/responsive-a11y.test.tsx apps/web/src/app/dashboard-layout-editor.test.tsx
git commit -m "style: polish dashboard widget management"
```

### Task 6: Browser acceptance and delivery audit

**Files:**
- Modify only files required to correct defects found during acceptance.

**Interfaces:**
- Consumes: completed K4 implementation.
- Produces: visual evidence and a clean delivery branch.

- [ ] **Step 1: Start API and Web using the repository development command**

Run: `pnpm dev`

Expected: Web listens on port 3000 and API listens on port 3001 without `EADDRINUSE`.

- [ ] **Step 2: Verify desktop acceptance with Playwright**

At a desktop viewport, verify:

1. The saved server layout loads without a content jump.
2. Edit mode supports existing drag and resize.
3. Add Widget opens the Gallery and inserts a controlled card.
4. Preview hides all editing controls.
5. Delete shows Undo and Undo restores the original position.
6. Save returns to view mode and shows “已保存”.
7. Refresh restores the saved layout.
8. A simulated 409 keeps the visible draft and shows a conflict alert.

- [ ] **Step 3: Verify 375px acceptance**

At `375x812`, verify the Gallery is a safe-area bottom sheet, cards remain single-column, all primary actions are reachable, scrolling does not conflict with dialogs, and no horizontal overflow is present.

- [ ] **Step 4: Inspect render and request behavior**

Confirm one GET occurs on editor mount, no PUT occurs during reorder/resize/add/delete/preview, and one PUT occurs only after explicit save. Confirm changing cards does not trigger the analytics request again.

- [ ] **Step 5: Re-run the final gate after visual fixes**

Run:

```bash
pnpm --filter @shopmate/web test
pnpm --filter @shopmate/web typecheck
pnpm --filter @shopmate/web lint
pnpm --filter @shopmate/web build
pnpm secret:scan
git diff --check
git status --short
```

Expected: every command succeeds; `git status --short` contains only intentional tracked changes, or is clean after the final fix commit.

- [ ] **Step 6: Commit acceptance fixes if needed**

```bash
git add apps/web/src/app
git commit -m "fix: harden dashboard widget workflows"
```

Do not create an empty commit when acceptance requires no correction.

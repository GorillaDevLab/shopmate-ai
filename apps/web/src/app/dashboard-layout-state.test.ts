import { DEFAULT_DASHBOARD_LAYOUT, type DashboardInsightQuery } from "@shopmate/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createDashboardCard,
  createInsightDashboardCard,
  initialLayoutEditorState,
  isLayoutDirty,
  layoutEditorReducer,
} from "./dashboard-layout-state";

const defaultResponse = {
  layout: DEFAULT_DASHBOARD_LAYOUT,
  revision: 0 as const,
  updatedAt: null,
};

describe("dashboard layout state", () => {
  it("缺少随机数能力时给出可读错误", () => {
    vi.stubGlobal("crypto", undefined);
    try {
      expect(() => createDashboardCard("metric", [])).toThrow("当前浏览器不支持创建卡片");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("安全环境优先使用原生 randomUUID", () => {
    const randomUUID = vi.fn(() => "native-id");
    vi.stubGlobal("crypto", { randomUUID });
    try {
      expect(createDashboardCard("metric", []).id).toBe("metric-native-id");
      expect(randomUUID).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("HTTP 环境没有 randomUUID 也能新增卡片", () => {
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    vi.stubGlobal("crypto", { getRandomValues });
    try {
      const first = createDashboardCard("metric", []);
      const second = createDashboardCard("metric", [first]);
      expect(first.id).toMatch(/^metric-[a-f0-9-]+$/);
      expect(second.id).not.toBe(first.id);
      const query = {
        dataset: "sales",
        metric: "revenue",
        aggregation: "sum",
        groupBy: "product",
        dateRange: { start: "2026-08-01", end: "2026-08-31" },
        filters: [],
        order: "desc",
        limit: 8,
        visualization: "pie",
      } as DashboardInsightQuery;
      expect(createInsightDashboardCard("pieChart", "销售占比", query, []).id).toMatch(
        /^pieChart-/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("加载服务器基线并从布局差异推导草稿状态", () => {
    const loaded = layoutEditorReducer(initialLayoutEditorState, {
      type: "loaded",
      response: defaultResponse,
    });
    const changed = layoutEditorReducer(loaded, {
      type: "cardsChanged",
      cards: loaded.draft.cards.slice(1),
    });

    expect(loaded).toMatchObject({ loadStatus: "ready", revision: 0 });
    expect(isLayoutDirty(loaded)).toBe(false);
    expect(isLayoutDirty(changed)).toBe(true);
  });

  it("把删除的卡片恢复到原始索引", () => {
    const ready = readyState();
    const removed = layoutEditorReducer(ready, {
      type: "cardRemoved",
      cardId: "metric-orders",
    });
    const restored = layoutEditorReducer(removed, { type: "removeUndone" });

    expect(removed.draft.cards.map(({ id }) => id)).not.toContain("metric-orders");
    expect(restored.draft.cards).toEqual(DEFAULT_DASHBOARD_LAYOUT.cards);
    expect(restored.removedCard).toBeUndefined();
  });

  it("放弃修改回到服务器基线并退出编辑", () => {
    const changed = changedState();
    const discarded = layoutEditorReducer(changed, { type: "discarded" });

    expect(discarded.draft).toEqual(changed.baseline);
    expect(discarded.mode).toBe("view");
    expect(isLayoutDirty(discarded)).toBe(false);
  });

  it("恢复默认只更新草稿并保持可保存状态", () => {
    const custom = layoutEditorReducer(readyState(), {
      type: "cardsChanged",
      cards: DEFAULT_DASHBOARD_LAYOUT.cards.slice(0, 2),
    });
    const savedCustom = layoutEditorReducer(custom, {
      type: "saved",
      response: {
        layout: custom.draft,
        revision: 2,
        updatedAt: "2026-09-02T00:00:00.000Z",
      },
    });
    const editing = layoutEditorReducer(savedCustom, { type: "modeChanged", mode: "edit" });
    const restored = layoutEditorReducer(editing, { type: "defaultsRestored" });

    expect(restored.draft).toEqual(DEFAULT_DASHBOARD_LAYOUT);
    expect(restored.baseline).toEqual(custom.draft);
    expect(restored.mode).toBe("edit");
    expect(isLayoutDirty(restored)).toBe(true);
  });

  it("保存成功提升 revision 并把草稿设为新基线", () => {
    const changed = changedState();
    const saving = layoutEditorReducer(changed, { type: "saveStarted" });
    const saved = layoutEditorReducer(saving, {
      type: "saved",
      response: {
        layout: changed.draft,
        revision: 2,
        updatedAt: "2026-09-02T00:00:00.000Z",
      },
    });

    expect(saving.saveStatus).toBe("saving");
    expect(saved).toMatchObject({ revision: 2, mode: "view", saveStatus: "saved" });
    expect(saved.baseline).toEqual(changed.draft);
    expect(isLayoutDirty(saved)).toBe(false);
  });

  it("保存冲突和普通错误都保留草稿", () => {
    const changed = changedState();
    for (const kind of ["conflict", "error"] as const) {
      const failed = layoutEditorReducer(changed, {
        type: "saveFailed",
        kind,
        message: "保存失败",
      });
      expect(failed.draft).toEqual(changed.draft);
      expect(failed.saveStatus).toBe(kind);
      expect(failed.message).toBe("保存失败");
    }
  });

  it("为每类组件创建通过合约约束的唯一默认卡片", () => {
    const components = ["metric", "salesTrend", "inventoryAlerts", "hotProducts"] as const;
    const cards = components.map((component, index) =>
      createDashboardCard(component, DEFAULT_DASHBOARD_LAYOUT.cards, () => `fixed-${index}`),
    );

    expect(cards).toEqual([
      { id: "metric-fixed-0", component: "metric", size: "1x1", config: { metric: "sales" } },
      {
        id: "salesTrend-fixed-1",
        component: "salesTrend",
        size: "2x1",
        config: { range: "7d" },
      },
      {
        id: "inventoryAlerts-fixed-2",
        component: "inventoryAlerts",
        size: "2x1",
        config: { limit: 4 },
      },
      {
        id: "hotProducts-fixed-3",
        component: "hotProducts",
        size: "2x1",
        config: { limit: 3 },
      },
    ]);
  });

  it("即使随机后缀重复也不会生成重复 ID", () => {
    const first = createDashboardCard("metric", DEFAULT_DASHBOARD_LAYOUT.cards, () => "same");
    const second = createDashboardCard(
      "metric",
      [...DEFAULT_DASHBOARD_LAYOUT.cards, first],
      () => "same",
    );
    expect(second.id).not.toBe(first.id);
    expect(second.id).toMatch(/^metric-same-\d+$/);
  });

  it("AI 组件加入草稿后可以撤销", () => {
    const query = {
      dataset: "sales",
      metric: "revenue",
      aggregation: "sum",
      groupBy: "product",
      dateRange: { start: "2026-08-01", end: "2026-08-31" },
      filters: [],
      order: "desc",
      limit: 8,
      visualization: "pie",
    } as DashboardInsightQuery;
    const card = createInsightDashboardCard("pieChart", "商品销售占比", query, [], () => "one");
    const added = layoutEditorReducer(readyState(), { type: "cardAdded", card });
    const undone = layoutEditorReducer(added, { type: "addUndone" });
    expect(added.addedCard?.card.id).toBe("pieChart-one");
    expect(card.size).toBe("1x1");
    expect(undone.draft.cards).toEqual(DEFAULT_DASHBOARD_LAYOUT.cards);
  });
});

function readyState() {
  return layoutEditorReducer(initialLayoutEditorState, {
    type: "loaded",
    response: defaultResponse,
  });
}

function changedState() {
  const ready = layoutEditorReducer(readyState(), { type: "modeChanged", mode: "edit" });
  return layoutEditorReducer(ready, {
    type: "cardsChanged",
    cards: ready.draft.cards.slice(1),
  });
}

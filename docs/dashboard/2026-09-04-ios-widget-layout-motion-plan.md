# iOS 风格小组件布局与流动换位 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将看板升级为 `1x1`、`2x1`、`2x2` 二维小组件网格，并为鼠标/触摸换位和尺寸调整提供可中断的 iOS 风格 FLIP 动效。

**Architecture:** Contracts 提供版本 3 Schema、组件尺寸注册表和版本 1/2 迁移；前端以注册表驱动创建、菜单和校验，以 CSS Grid 表达二维占位。独立的 WAAPI 动效模块捕获可见矩形并使用 translate/scale FLIP 重定向快速连续操作，不新增动画依赖。

**Tech Stack:** TypeScript、Zod、React 19、Next.js 16、CSS Container Queries、Web Animations API、Vitest、Testing Library、Playwright、pnpm

## Global Constraints

- 尺寸只允许 `1x1`、`2x1`、`2x2`。
- 375px 起移动端使用 2 列，768px 及以上使用 4 列。
- 不新增数据库表，不删除或覆盖已有用户布局；版本 1/2 必须可迁移。
- 不新增 Motion 等运行时动画依赖。
- 位移动画使用 `260ms cubic-bezier(0.32, 0.72, 0, 1)`，只动画 `transform` 与 `opacity`。
- 键盘排序保持即时；`prefers-reduced-motion: reduce` 跳过位置和尺寸动画。
- 每类组件只接受设计文档列出的尺寸组合。
- 所有编辑控件在 375px 下可操作且具有可访问名称。

---

### Task 1: 布局 Schema v3 与旧数据迁移

**Files:**
- Modify: `packages/contracts/src/dashboard/dashboard-layout.schema.ts`
- Modify: `packages/contracts/src/dashboard/dashboard-layout.spec.ts`
- Modify: `apps/api/src/dashboard-layout/dashboard-layout.service.spec.ts`
- Modify: `apps/web/src/app/dashboard-layout-state.ts`
- Modify: `apps/web/src/app/dashboard-layout-state.test.ts`

**Interfaces:**
- Produces: `DashboardLayoutSize = "1x1" | "2x1" | "2x2"`。
- Produces: `DASHBOARD_COMPONENT_REGISTRY[component].allowedSizes` 与 `.defaultSize`。
- Produces: `parseDashboardLayout(value: unknown): DashboardLayout`，返回版本 3。
- Consumes: 版本 1/2 的旧尺寸 `"1/3" | "1/2" | "2/3" | "full"`。

- [x] **Step 1: 写版本 3、组件约束与迁移失败测试**

在 `dashboard-layout.spec.ts` 覆盖：

```ts
expect(DEFAULT_DASHBOARD_LAYOUT.version).toBe(3);
expect(DEFAULT_DASHBOARD_LAYOUT.cards.map(({ size }) => size)).toEqual([
  "1x1", "1x1", "1x1", "1x1", "2x1", "2x1", "2x1",
]);
expect(
  DashboardLayoutSchema.safeParse({
    version: 3,
    cards: [{ id: "trend", component: "salesTrend", size: "1x1", config: { range: "7d" } }],
  }).success,
).toBe(false);
expect(
  parseDashboardLayout({
    version: 2,
    cards: [
      { id: "metric", component: "metric", size: "1/3", config: { metric: "sales" } },
      { id: "trend", component: "salesTrend", size: "2/3", config: { range: "7d" } },
      { id: "products", component: "hotProducts", size: "full", config: { limit: 3 } },
    ],
  }),
).toEqual({
  version: 3,
  cards: [
    { id: "metric", component: "metric", size: "1x1", config: { metric: "sales" } },
    { id: "trend", component: "salesTrend", size: "2x1", config: { range: "7d" } },
    { id: "products", component: "hotProducts", size: "2x1", config: { limit: 3 } },
  ],
});
```

同时更新状态测试，期望新建卡片使用注册表默认值：指标和 AI 饼图为 `1x1`，其余组件为 `2x1`。

- [x] **Step 2: 运行聚焦测试并确认 RED**

Run:

```bash
pnpm --filter @shopmate/contracts exec vitest run src/dashboard/dashboard-layout.spec.ts
pnpm --filter @shopmate/web exec vitest run src/app/dashboard-layout-state.test.ts
```

Expected: FAIL；当前版本仍为 2，旧尺寸仍为分数值，组件尺寸组合未限制。

- [x] **Step 3: 实现版本 3 注册表和严格约束**

在 Schema 中定义：

```ts
export const DashboardLayoutVersionSchema = z.literal(3, {
  error: "不支持的看板布局版本",
});
export const DashboardLayoutSizeSchema = z.enum(["1x1", "2x1", "2x2"], {
  error: "卡片尺寸必须是 1x1、2x1 或 2x2",
});

export const DASHBOARD_COMPONENT_REGISTRY = {
  metric: { label: "经营指标", defaultSize: "1x1", allowedSizes: ["1x1", "2x1"] },
  salesTrend: { label: "销售趋势", defaultSize: "2x1", allowedSizes: ["2x1", "2x2"] },
  inventoryAlerts: { label: "库存提醒", defaultSize: "2x1", allowedSizes: ["2x1", "2x2"] },
  hotProducts: { label: "热销商品", defaultSize: "2x1", allowedSizes: ["2x1", "2x2"] },
  pieChart: {
    label: "AI 饼图",
    defaultSize: "1x1",
    allowedSizes: ["1x1", "2x1", "2x2"],
  },
  report: { label: "AI 经营报告", defaultSize: "2x1", allowedSizes: ["2x1", "2x2"] },
} as const satisfies Record<
  DashboardLayoutComponent,
  {
    label: string;
    defaultSize: DashboardLayoutSize;
    allowedSizes: readonly DashboardLayoutSize[];
  }
>;
```

在 `DashboardLayoutCardSchema.superRefine` 中以注册表拒绝不支持的组合，错误 path 为 `["size"]`、文案为 `该组件不支持尺寸 ${card.size}`。

- [x] **Step 4: 实现版本 1/2 迁移**

定义只在解析旧记录时使用的旧尺寸 Schema，并通过以下函数迁移：

```ts
type LegacyDashboardLayoutSize = "1/3" | "1/2" | "2/3" | "full";

function migrateSize(
  component: DashboardLayoutComponent,
  size: LegacyDashboardLayoutSize,
): DashboardLayoutSize {
  const allowed = DASHBOARD_COMPONENT_REGISTRY[component].allowedSizes;
  return size === "1/3" && allowed.some((candidate) => candidate === "1x1")
    ? "1x1"
    : "2x1";
}
```

`parseDashboardLayout` 依次尝试当前版本、版本 2、版本 1，旧卡片仅替换 `size` 并返回 `version: 3`。

- [x] **Step 5: 让前端新建卡片只读取注册表默认值**

在 `dashboard-layout-state.ts` 中为每个组件保留原有 config，但尺寸统一读取：

```ts
const size = DASHBOARD_COMPONENT_REGISTRY[component].defaultSize;
```

`createInsightDashboardCard` 同样根据 `pieChart` 或 `report` 读取对应默认值，不再硬编码 `1/2`。

- [x] **Step 6: 运行 Task 1 测试并提交**

Run:

```bash
pnpm --filter @shopmate/contracts test
pnpm --filter @shopmate/web exec vitest run src/app/dashboard-layout-state.test.ts
pnpm --filter @shopmate/api exec vitest run src/dashboard-layout/dashboard-layout.service.spec.ts
```

Expected: 全部 PASS。

Commit:

```bash
git add packages/contracts/src/dashboard apps/api/src/dashboard-layout/dashboard-layout.service.spec.ts apps/web/src/app/dashboard-layout-state.ts apps/web/src/app/dashboard-layout-state.test.ts
git commit -m "feat: add versioned widget footprint schema"
```

---

### Task 2: 二维网格、组件尺寸菜单与拖动缩放

**Files:**
- Create: `apps/web/src/app/dashboard-layout-resize.test.ts`
- Modify: `apps/web/src/app/dashboard-layout-resize.ts`
- Modify: `apps/web/src/app/dashboard-layout-editor.tsx`
- Modify: `apps/web/src/app/dashboard-layout-editor.test.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**
- Consumes: `DashboardLayoutSize` 与 `DASHBOARD_COMPONENT_REGISTRY`。
- Produces: `WidgetFootprint { columns: 1 | 2; rows: 1 | 2 }`。
- Produces: `footprintForSize(size)`、`adjacentAllowedSize(size, direction, allowed)`、`previewWidgetSize(...)`。
- Produces: 卡片 CSS 变量 `--widget-columns` 与 `--widget-rows`。

- [x] **Step 1: 写二维尺寸纯函数失败测试**

创建 `dashboard-layout-resize.test.ts`：

```ts
expect(footprintForSize("1x1")).toEqual({ columns: 1, rows: 1 });
expect(footprintForSize("2x1")).toEqual({ columns: 2, rows: 1 });
expect(footprintForSize("2x2")).toEqual({ columns: 2, rows: 2 });
expect(adjacentAllowedSize("2x1", 1, ["2x1", "2x2"])).toBe("2x2");
expect(
  previewWidgetSize({
    startSize: "1x1",
    deltaX: 180,
    deltaY: 180,
    unitSize: 160,
    allowedSizes: ["1x1", "2x1"],
  }),
).toBe("2x1");
expect(
  previewWidgetSize({
    startSize: "2x1",
    deltaX: 0,
    deltaY: 180,
    unitSize: 160,
    allowedSizes: ["2x1", "2x2"],
  }),
).toBe("2x2");
```

- [x] **Step 2: 写编辑器尺寸与控件失败测试**

更新编辑器测试，验证：

```ts
expect(card("metric-sales")).toHaveAttribute("data-size", "1x1");
openCardMenu("销售额");
expect(screen.getByRole("menuitemradio", { name: "1 × 1" })).toBeInTheDocument();
expect(screen.getByRole("menuitemradio", { name: "2 × 1" })).toBeInTheDocument();
expect(screen.queryByRole("menuitemradio", { name: "2 × 2" })).not.toBeInTheDocument();
expect(screen.queryByText("整行")).not.toBeInTheDocument();
expect(screen.getByRole("menuitem", { name: "下移" })).toBeInTheDocument();
```

将缩放手柄名称改为“调整销售额卡片尺寸”，指针事件同时提供 `clientX` 与 `clientY`，预览属性改为 `data-preview-size="2x1"` 或 `data-preview-size="2x2"`。

- [x] **Step 3: 运行聚焦测试并确认 RED**

Run:

```bash
pnpm --filter @shopmate/web exec vitest run src/app/dashboard-layout-resize.test.ts src/app/dashboard-layout-editor.test.tsx
```

Expected: FAIL；二维 footprint 函数不存在，编辑器仍显示旧尺寸与顶部移动按钮。

- [x] **Step 4: 实现二维尺寸函数**

在 `dashboard-layout-resize.ts` 中定义：

```ts
const footprints: Record<DashboardLayoutSize, WidgetFootprint> = {
  "1x1": { columns: 1, rows: 1 },
  "2x1": { columns: 2, rows: 1 },
  "2x2": { columns: 2, rows: 2 },
};

export function footprintForSize(size: DashboardLayoutSize): WidgetFootprint {
  return footprints[size];
}
```

`previewWidgetSize` 把指针 delta 换算为目标 columns/rows，并在 `allowedSizes` 中选择平方距离最小的 footprint；距离相同时保持当前尺寸，防止边界抖动。

- [x] **Step 5: 改造编辑器尺寸状态与菜单**

将 `ResizeSession` 改为保存 `startY`、`startSize`、`size`，将 `ResizePreview` 改为 `{ cardId, size }`。卡片渲染时由 footprint 写入：

```ts
const footprint = footprintForSize(previewSize ?? card.size);
const style = {
  "--widget-columns": footprint.columns,
  "--widget-rows": footprint.rows,
} as CSSProperties;
```

顶部控件只保留拖动把手、尺寸徽标和更多菜单；`CardMoreMenu` 从 `DASHBOARD_COMPONENT_REGISTRY[card.component].allowedSizes` 渲染尺寸，并在菜单内提供“上移”“下移”“删除”。鼠标点击移动传入 `event.detail > 0`，键盘激活传入 `false`。

- [x] **Step 6: 实现二维 CSS Grid**

在 `globals.css` 中加入：

```css
.dashboard-layout-shell {
  container-type: inline-size;
}

.dashboard-layout-grid {
  --widget-gap: 1rem;
  --widget-unit: calc((100cqw - var(--widget-gap)) / 2);
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-auto-rows: var(--widget-unit);
  grid-auto-flow: dense;
  gap: var(--widget-gap);
}

.dashboard-layout-card {
  grid-column: span var(--widget-columns);
  grid-row: span var(--widget-rows);
  min-height: 0;
}

@media (min-width: 768px) {
  .dashboard-layout-grid {
    --widget-unit: calc(
      (100cqw - var(--widget-gap) - var(--widget-gap) - var(--widget-gap)) / 4
    );
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
```

`ReadyLayoutEditor` 使用 `.dashboard-layout-shell` 包住工具栏、消息和 Grid，使 `cqw` 相对看板可用宽度计算。卡片内部 panel 使用 `height: 100%` 与受控 overflow；紧凑顶部控件不得扩大网格行高。

- [x] **Step 7: 运行 Task 2 验证并提交**

Run:

```bash
pnpm --filter @shopmate/web exec vitest run src/app/dashboard-layout-resize.test.ts src/app/dashboard-layout-editor.test.tsx src/app/responsive-a11y.test.tsx
pnpm --filter @shopmate/web typecheck
```

Expected: 全部 PASS，TypeScript 无错误。

Commit:

```bash
git add apps/web/src/app/dashboard-layout-resize.ts apps/web/src/app/dashboard-layout-resize.test.ts apps/web/src/app/dashboard-layout-editor.tsx apps/web/src/app/dashboard-layout-editor.test.tsx apps/web/src/app/globals.css
git commit -m "feat: add responsive widget footprint grid"
```

---

### Task 3: 可中断 FLIP 动效与端到端验收

**Files:**
- Create: `apps/web/src/app/dashboard-layout-motion.ts`
- Create: `apps/web/src/app/dashboard-layout-motion.test.ts`
- Modify: `apps/web/src/app/dashboard-layout-resize.ts`
- Modify: `apps/web/src/app/dashboard-layout-editor.tsx`
- Modify: `apps/web/src/app/dashboard-layout-editor.test.tsx`
- Modify: `apps/web/src/app/globals.css`
- Modify: `tests/e2e/custom-workspace.spec.ts`

**Interfaces:**
- Produces: `captureCardRects(container): CardRectMap`。
- Produces: `animateCardReflow(container, before): void`。
- Consumes: `[data-dashboard-card-id]`、`Element.getAnimations()`、`Element.animate()` 与 reduced-motion media query。

- [x] **Step 1: 写 FLIP 失败测试**

创建 motion 测试，使用可控 DOMRect 和 WAAPI spy 验证：

```ts
expect(callOrder).toEqual(["cancel", "measure", "animate"]);
expect(animate).toHaveBeenCalledWith(
  [
    {
      opacity: 0.96,
      transform: "translate3d(-240px, -120px, 0) scale(0.5, 0.5)",
      transformOrigin: "top left",
    },
    {
      opacity: 1,
      transform: "translate3d(0, 0, 0) scale(1, 1)",
      transformOrigin: "top left",
    },
  ],
  {
    duration: 260,
    easing: "cubic-bezier(0.32, 0.72, 0, 1)",
  },
);
```

再覆盖：位置未变化不调用 animate、缺少 WAAPI 不抛错、reduced-motion 不调用 animate、旧矩形不存在时跳过。

- [x] **Step 2: 运行 motion 测试并确认 RED**

Run:

```bash
pnpm --filter @shopmate/web exec vitest run src/app/dashboard-layout-motion.test.ts
```

Expected: FAIL；独立 motion 模块尚不存在。

- [x] **Step 3: 实现独立 WAAPI FLIP 模块**

核心顺序必须是：保存旧可见矩形 → React 更新 → 取消旧动画 → 读取无 transform 目标矩形 → 计算 delta/scale → 启动新动画。

```ts
const IOS_LAYOUT_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
const IOS_LAYOUT_DURATION_MS = 260;

function animateCardFromPreviousPosition(card: HTMLElement, previous: DOMRect): void {
  card.getAnimations().forEach((animation) => animation.cancel());
  const current = card.getBoundingClientRect();
  const deltaX = previous.left - current.left;
  const deltaY = previous.top - current.top;
  const scaleX = current.width > 0 ? previous.width / current.width : 1;
  const scaleY = current.height > 0 ? previous.height / current.height : 1;
  if (deltaX === 0 && deltaY === 0 && scaleX === 1 && scaleY === 1) return;
  card.animate(
    [
      {
        opacity: 0.96,
        transform: `translate3d(${deltaX}px, ${deltaY}px, 0) scale(${scaleX}, ${scaleY})`,
        transformOrigin: "top left",
      },
      {
        opacity: 1,
        transform: "translate3d(0, 0, 0) scale(1, 1)",
        transformOrigin: "top left",
      },
    ],
    { duration: IOS_LAYOUT_DURATION_MS, easing: IOS_LAYOUT_EASING },
  );
}
```

将矩形捕获和重排动画从 `dashboard-layout-resize.ts` 移到该模块，编辑器只依赖 motion 模块公开接口。

- [x] **Step 4: 连接所有可视化布局变更**

排序、菜单尺寸切换、指针缩放完成、删除和撤销前均调用 `captureCardRects`；键盘上移/下移与键盘尺寸调整传入 `animate = false`。拖动状态的 scale 和 shadow 移到 `.dashboard-layout-card.is-dragging > .dashboard-panel`，外层 transform 专供 FLIP。

- [x] **Step 5: 添加 375px 与桌面端到端断言**

在 `custom-workspace.spec.ts` 中登录并进入编辑模式后验证：

```ts
await page.setViewportSize({ width: 375, height: 812 });
await expect(page.locator('[data-dashboard-card-id="metric-sales"]')).toHaveAttribute(
  "data-size",
  "1x1",
);
expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
await expect(page.getByRole("button", { name: "销售额更多操作" })).toBeVisible();
```

桌面 1440px 下验证四张 `1x1` 指标卡的 top 相同、left 依次增加；销售趋势与库存提醒均为 `2x1` 且不会横跨四列。

- [ ] **Step 6: 运行完整验证**

本地结果：`pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm build` 和
`pnpm secret:scan` 已通过。Playwright 测试已添加，但本机未配置可认证的
`DATABASE_URL`，因此 E2E 在 Seed 阶段停止，尚未执行浏览器断言。

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm secret:scan
pnpm test:e2e -- tests/e2e/custom-workspace.spec.ts
```

Expected: 所有命令退出码为 0；Playwright 在 375px 与桌面断言均通过。

- [x] **Step 7: 提交动效和验收测试**

```bash
git add apps/web/src/app/dashboard-layout-motion.ts apps/web/src/app/dashboard-layout-motion.test.ts apps/web/src/app/dashboard-layout-resize.ts apps/web/src/app/dashboard-layout-editor.tsx apps/web/src/app/dashboard-layout-editor.test.tsx apps/web/src/app/globals.css tests/e2e/custom-workspace.spec.ts docs/dashboard/2026-09-04-ios-widget-layout-motion-plan.md
git commit -m "feat: animate widget layout reflow"
```

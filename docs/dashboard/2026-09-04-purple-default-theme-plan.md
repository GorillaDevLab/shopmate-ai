# 经典紫色默认主题 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让首次访问或主题存储不可用的用户默认看到经典紫色，同时保留浏览器中已有的有效主题选择。

**Architecture:** 继续以 `<html data-theme>` 作为单一运行时主题状态。服务端先输出紫色避免首次绘制闪烁，内联初始化脚本仅恢复白名单中的 `purple` 或 `terracotta`；无值、无效值和读取失败统一回退紫色。

**Tech Stack:** Next.js、React、TypeScript、Vitest、Testing Library、pnpm

## Global Constraints

- 仅 `purple` 和 `terracotta` 是有效主题值。
- 不覆盖用户已经保存的 `terracotta` 或 `purple`。
- 不删除暖灰陶土选项。
- 不改变经营数据、用户布局或后端模型。
- 375px 移动端行为和现有存储错误提示保持不变。

---

### Task 1: 将默认主题切换为经典紫色

**Files:**
- Modify: `apps/web/src/app/theme.test.ts`
- Modify: `apps/web/src/app/theme-settings.test.tsx`
- Modify: `apps/web/src/app/page.test.tsx`
- Modify: `apps/web/src/app/theme.ts`
- Modify: `apps/web/src/app/layout.tsx`

**Interfaces:**
- Consumes: `localStorage['shopmate-theme']` 和 `<html data-theme>`。
- Produces: `themeValue(value: unknown): Theme`；无效输入返回 `purple`，有效 `terracotta`/`purple` 原样返回。

- [x] **Step 1: 写首屏主题的失败测试**

将 `apps/web/src/app/theme.test.ts` 的期望改为：

```ts
expect(document.documentElement.dataset.theme).toBe(
  value === "terracotta" ? "terracotta" : "purple",
);
```

并将存储读取失败断言改为：

```ts
expect(document.documentElement.dataset.theme).toBe("purple");
```

- [x] **Step 2: 写设置面板默认选项的失败测试**

在 `apps/web/src/app/theme-settings.test.tsx` 中把双向切换用例改为从经典紫色开始：

```ts
it("默认经典紫色，可双向切换并保存，关闭不撤销选择", () => {
  render(<Dashboard />);
  openSettings();
  expect(screen.getByRole("radio", { name: "经典紫色" })).toBeChecked();
  fireEvent.click(screen.getByRole("radio", { name: "暖灰陶土" }));
  expect(document.documentElement).toHaveAttribute("data-theme", "terracotta");
  expect(localStorage.getItem("shopmate-theme")).toBe("terracotta");
  fireEvent.click(screen.getByRole("button", { name: "关闭外观设置" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  openSettings();
  expect(screen.getByRole("radio", { name: "暖灰陶土" })).toBeChecked();
  fireEvent.click(screen.getByRole("radio", { name: "经典紫色" }));
  expect(document.documentElement).toHaveAttribute("data-theme", "purple");
  expect(localStorage.getItem("shopmate-theme")).toBe("purple");
});
```

- [x] **Step 3: 运行聚焦测试并确认 RED**

Run:

```bash
pnpm --filter @shopmate/web exec vitest run src/app/theme.test.ts src/app/theme-settings.test.tsx src/app/page.test.tsx
```

Expected: FAIL；无存储与读取失败仍得到 `terracotta`，设置面板仍默认选中暖灰陶土，服务端 HTML 仍输出陶土主题。

- [x] **Step 4: 实现最小生产代码**

在 `apps/web/src/app/theme.ts` 中保留有效陶土主题，否则回退紫色：

```ts
export function themeValue(value: unknown): Theme {
  return value === "terracotta" ? "terracotta" : "purple";
}
```

将内联脚本的主题赋值改为：

```ts
root.dataset.theme = value === 'terracotta' ? 'terracotta' : 'purple';
```

将脚本 `catch` 中的回退改为：

```ts
root.dataset.theme = 'purple';
```

将 `apps/web/src/app/layout.tsx` 的服务端属性改为：

```tsx
<html lang="zh-CN" data-theme="purple" suppressHydrationWarning>
```

- [x] **Step 5: 运行聚焦测试并确认 GREEN**

Run:

```bash
pnpm --filter @shopmate/web exec vitest run src/app/theme.test.ts src/app/theme-settings.test.tsx src/app/page.test.tsx
```

Expected: 三个测试文件全部 PASS，且没有警告或未捕获错误。

- [x] **Step 6: 运行完整质量检查**

Run:

```bash
pnpm --filter @shopmate/web test
pnpm --filter @shopmate/web typecheck
pnpm --filter @shopmate/web lint
pnpm --filter @shopmate/web build
pnpm secret:scan
```

Expected: 所有命令退出码为 0。

- [x] **Step 7: 提交实现**

```bash
git add apps/web/src/app/theme.test.ts apps/web/src/app/theme-settings.test.tsx apps/web/src/app/page.test.tsx apps/web/src/app/theme.ts apps/web/src/app/layout.tsx docs/dashboard/2026-09-04-purple-default-theme-plan.md
git commit -m "feat: make purple the default dashboard theme"
```

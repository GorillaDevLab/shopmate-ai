# Calm / Vivid Appearance Implementation Plan

> **For agentic workers:** Use executing-plans for this tightly coupled, same-checkout implementation. Steps use checkbox syntax to track progress.

**Goal:** Add persistent 冷静 / 灵动 modes and editable homepage, default widget and per-widget materials.

**Architecture:** A validated versioned local model owns configuration; a dashboard-scoped provider owns mode, persistence and studio state. A shared CSS material surface consumes safe variables without changing chart or layout contracts.

**Tech Stack:** React, TypeScript, CSS, Vitest, existing Next.js application.

## Global Constraints

- Default cold/calm, literal labels 冷静 / 灵动.
- No real AI, database, credentials or live business endpoint calls in testing.
- Current-browser storage only; unknown versions/corrupt settings fall back to calm.
- Six-digit hex colors only; opacity 20–100, glow 0–100, speed 0.25–2, boolean motion, at most 100 per-card overrides.
- Existing purple/terracotta base theme is independent. Do not change backend schemas.
- 375px minimum QA; readable content, decorative layers ignore pointer events; reduced-motion and hidden pages pause animation.

## Task 1: Validated configuration and shared state

Files: create appearance-model.ts, appearance-model.test.ts, appearance-provider.tsx; modify layout.tsx.

Interfaces: Appearance {version:1,mode:'calm'|'vivid',page:Material,widgets:Material,cards:Record<string,Material>}; Material {primary,secondary,shade:string,opacity,glow,speed:number,motion:boolean}. Export DEFAULT_APPEARANCE, MATERIAL_PRESETS, parseAppearance(unknown), readAppearance(), writeAppearance(settings), materialVariables(material). Provider exposes settings, error, setMode, save, cards, setCards, openStudio.

- [ ] RED: tests default/corrupt input, invalid colors/numbers/version, cardinality bound, round-trip and failed storage. Run `pnpm --filter @shopmate/web exec vitest run src/app/appearance-model.test.ts`.
- [ ] GREEN: implement explicit whitelist validation and safe storage. `parseAppearance(JSON.parse(raw))` returns a fresh safe object or default; write errors are visible.
- [ ] Add a prepaint mode bootstrap with validation parity tests and provider hydration. No external fetches.
- [ ] Run focused tests and TypeScript. Review boundaries before integrating.

## Task 2: Interactive controls and studio

Files: create appearance-controls.tsx, appearance-studio.tsx, appearance-fields.tsx, appearance-controls.test.tsx; modify theme-settings.tsx and dashboard.tsx.

Interfaces: useAppearance() returns provider state; studio edits a local draft and only calls save(draft) on explicit save. Target values page/widgets/card:<id>, inherited card material defaults to widgets. Global clearing and restoring all require window.confirm before draft mutation.

- [ ] RED: render dashboard/provider, expect 冷静 pressed, click 灵动, reopen studio, change color then cancel, assert storage unchanged; save and assert round-trip. Test reset confirmation and empty widget list.
- [ ] GREEN: build segmented control and one accessible modal drawer. Add named color inputs, three bounded ranges, motion checkbox, four presets and preview; keep footer reachable. Cancel/Escape preserve saved values.
- [ ] Test single-card override, inherit, global application and storage error retention.
- [ ] Run focused tests and review UI semantics.

## Task 3: Shared surfaces and visual verification

Files: create appearance.css; modify dashboard-layout-editor.tsx, globals.css; tests in appearance-controls.test.tsx and appearance-model.test.ts.

Interfaces: materialVariables returns custom properties --material-primary/secondary/shade/opacity/glow/duration/play. Background uses page material; cards use cards[id] ?? widgets. Provider registers actual cards once from the ready editor via stable setCards callback.

- [ ] Register cards using existing cardTitle and stable IDs; supply card variables without replacing layout/animation variables.
- [ ] Create vivid dark glass surfaces with saturated moving gradient highlights and solid readable content layer; calm disables all decorative effects.
- [ ] Add reduced-motion/visibility pause and unsupported backdrop-filter fallback.
- [ ] Run `pnpm --filter @shopmate/web test:unit`, `pnpm --filter @shopmate/web exec tsc --noEmit`, targeted ESLint and Prettier.
- [ ] Use browser interception for all business endpoints; inspect 1440px and 375px, save/reload, cancel/reset, single-card/global changes, scroll, reduced motion. Save screenshots to output/playwright.
- [ ] Review full diff against spec and commit only implementation/tests/docs. No deployment or PR creation unless requested.

## Progress

Implemented on feat/calm-vivid-appearance. Model, provider, shared surfaces and studio are complete. Full web unit suite: 218 tests in 37 files pass; TypeScript and formatting pass. ESLint hydration warning is documented at the browser-only restoration boundary. Desktop and 375px screenshots captured with intercepted business requests; mobile has no horizontal overflow and the reset controls scroll into view while save/cancel stay reachable. No real AI or database calls were made. Settings remain local to the current browser. Initial bootstrap restores mode; custom material variables are restored during hydration.

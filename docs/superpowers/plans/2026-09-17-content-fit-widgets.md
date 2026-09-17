# Content-fit widgets implementation plan

> Inline implementation on the selected feature branch. Use test-driven-development and verification-before-completion; tightly coupled editor/CSS changes are implemented together.

**Goal:** Natural card heights, ordered compact placement and readable responsive content.
**Architecture:** CSS Grid retains column spans; 1px rows with zero vertical gap are enabled after measured spans have been assigned. Each span is ceil(natural height + 16px gutter). Cards align to start, never stretch. A single grid observer batches updates into animation frames; unchanged spans are not rewritten. No React state for measurement and no network calls.
**Tech:** React, TypeScript, CSS, Vitest, mocked Playwright browser.

## Constraints
- 375px minimum, no content clipping, no paid AI or database calls.
- Keep stored layout schema and existing IDs; old 2x2 is a wide card alias.
- Preserve DOM order; no dense backfilling that reorders visual reading.
- Default natural-height CSS remains usable without ResizeObserver.

## Task 1 — content height measurement
Files: new dashboard-content-fit.ts and dashboard-content-fit.test.ts; integrate in dashboard-layout-editor.tsx.
- [ ] RED: expect contentRowSpan(143.2) === 160 and contentRowSpan(0) === 17; test finite inputs, updates, shrink and disconnect using actual DOM cards and simulated observer delivery.
- [ ] GREEN: export contentRowSpan(height:number):number using Math.ceil(Math.max(1, finite height) + 16). Export observeContentFit(grid:HTMLElement):()=>void. Observe grid and direct cards with ResizeObserver; childList mutation refreshes observed elements. Schedule one frame; measure card.offsetHeight; write gridRowEnd only when different; set data-content-fit. Cleanup disconnects and cancels frame.
- [ ] Integrate useLayoutEffect in DashboardGrid, with gridRef dependency; observer handles data/size/edit and mutation changes.
- [ ] Run focused Vitest; retain original CSS fallback until observer writes spans.

## Task 2 — natural surfaces and width controls
Files: globals.css, dashboard-layout-resize.ts/test.ts, dashboard-layout-editor.tsx/test.tsx.
- [ ] RED: resizing ignores vertical deltas; same-width aliases collapse; existing resize tests rewritten for approved width-only behavior.
- [ ] GREEN: expose distinct allowed column widths; labels 窄卡/宽卡. Old 2x2 maps to wide. Horizontal pointer and keyboard controls preserve persisted permitted values.
- [ ] CSS: grid-auto-flow:row; align-items:start; natural auto rows fallback. Enhanced grid uses grid-auto-rows:1px; row-gap:0; card margin-bottom:16px. Remove forced panel heights and insight min-height:100%. Card container-type:inline-size supports responsive child layout.
- [ ] Product rows use container queries, reserve unbroken numeric values, wrap SKU independently. Pie switches to stacked layout for narrow containers; graph maintains readable plot height.

## Task 3 — verification
- [ ] Full web tests, tsc, targeted eslint, prettier and production build.
- [ ] Mock browser at 375/768/1440: metrics, 3 products, 12 slices, switch graphs, content shrink, edit/preview and both modes. Assert card boundaries contain children, no overlap/overflow, internal blank area at most intended padding; save screenshots.
- [ ] Review diff, record limitations and evidence, commit implementation. Do not push or deploy without request.

## Verification record

Implemented natural-height grid fitting, width alias controls and container-responsive typography/layout. Latest full suite: 222 tests / 38 files pass. Targeted ESLint, TypeScript (including production build) and formatting pass. Mock browser checked 1440px, 768px and 375px, calm/vivid, edit/preview: no card overlap or content escaping card boundaries. Three-item products and twelve-item pie verified; narrow pie with large amounts also checked. Chart switch changed measured height from 676px to 862px and updated span to 878, without overflow. Added child tracking / pending frame cleanup regression test. Reviewer identified fixed mobile pie width; corrected it to min(100%,150px), and phone charts now span available width. All requests were intercepted; no AI or database calls. Large cards can leave necessary outside gaps to preserve user order; internal fixed-height whitespace is removed.

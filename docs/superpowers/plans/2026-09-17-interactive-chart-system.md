# Interactive chart implementation

> Execute using subagent-driven-development and TDD. Approved design: `docs/superpowers/specs/2026-09-17-interactive-chart-system-design.md`.

## Global Constraints

- No real AI requests, paid calls, production database changes, deployment, or arbitrary SQL. Test providers and browser endpoints are mocked.
- Preserve merchant isolation, permissions, strict DSL validation, the 366-day bound, category limit 12 and existing saved layouts.
- Chart switches reuse existing data without network calls. Persist presentation only through explicit layout save.
- Never label partial results as whole-shop totals, sum averages into shares, fabricate comparisons, or fill unknown missing dates with zero.
- All charts support keyboard/focus/touch, 375px layouts, loading/empty/error, calm/vivid modes and reduced motion; preserve content-fit layout.

## Task 1: Safe chart protocol and execution

Own `packages/contracts/src/ai/dashboard-insight.schema.ts`, relevant exports/tests, `packages/contracts/src/dashboard/dashboard-layout.schema.ts` and tests; `apps/api/src/ai/insights/**` and its tests only.

Add request kind `auto|pie|bar|line|area|report`; concrete query visualization excludes auto. Keep existing category result `kind:pie` with slices for compatibility, add `kind:series` with title, summary, unit and points `{date:ISO-date,value:finite nonnegative}` bounded to 366, unique ascending dates. Category results still max12. Date results must preserve every returned date chronologically and ignore category limit. Existing pie-by-date layouts can still execute in their legacy form, while new auto date queries produce series. For line/area (or bar grouped by date), return series; category bar returns pie shape. No fabricated missing days.

Server makes one planning LLM call. Auto choice resolved deterministically from validated query shape and question composition intent: date=line, categories=bar (additive composition intent=pie), ungrouped=report. Explicit incompatible chart choice produces clear Chinese 400 guidance. Validate executed queries too (line/area require date, new average pie prohibited); preserve legacy reads where necessary with documented compatibility. Do not add unsupported metric/dimension pairs. Ensure filtered revenue/date uses scoped store reader when appropriate and never silently ignores product filters. Keep auth scope and bounded readers.

Export `DashboardInsightKind`, `DashboardChartView` and a shared pure compatibility helper `getDashboardInsightViews(query)` for frontend (pie/bar for additive category, bar for averages, line/area/bar for dates, report for ungrouped). Optional `view` on pieChart config for compatible presentation; optional line/area view on salesTrend config. Retain pieChart component key, label AI 图表; retain layout version3 if additive fields suffice, validate incompatibility. Existing pie/report data stays readable. Query's original visualization unchanged by presentation toggles.

TDD first: contract auto/series/view tests; API one call auto/explicit validation, 30 chronological points not top12, scope/permissions/filter regressions, legacy pie/report tests. Run focused then complete contracts/API unit suites and typecheck using package scripts. Commit only owned changes. Report commands, RED/GREEN evidence, interfaces and concerns to `.superpowers/sdd/charts-task-1-report.md`.

## Task 2: Unified chart presentation

Own frontend presentation files in `apps/web/src/app/`: shared `dashboard-chart-model.ts`, `dashboard-chart-model.test.ts`, `dashboard-chart-interactive.tsx`/CSS as needed; `dashboard-pie-chart.tsx`, `dashboard-comparison-chart.tsx`, `sales-trend.tsx` and related tests/styles. Do not change API or contracts.

Implement real SVG donut with center displayed-total/selected item, top5+other exact aggregation and expand, sorted bars with stable key colors and additive shares, focus/hover transient detail and click pin selection with deselect/reset. Shared number formatting, labels and robust zero/single/large numeric behavior. Nonadditive bar has no sum/share. Keep legacy public props compatible, expose optional controlled view and change callback; legacy standalone uses local state. A generic series component accepts new points/unit and supports line/area/bar with chronological sparse ticks, tooltip/reference and keyboard selection; integrate existing SalesTrend wrapper preserving heading and amount tests. Honest data geometry, no invented series. CSS motion one-shot and reduced-motion safe, vivid/calm styling and375px containment. Reuse primitive presentations across preview and saved cards. TDD behavior and data math, focused tests then web unit suite. Commit owned files. Report `.superpowers/sdd/charts-task-2-report.md`.

## Task 3: Integrate AI recommendation and saved view

Own frontend `dashboard-insight-api.ts`, `dashboard-insight-card.tsx`, `dashboard-ai-assistant.tsx`, `dashboard-widget-gallery.tsx`, `dashboard-layout-editor.tsx`, `dashboard-layout-state.ts`, intent helper(s) and tests. Build on previous exported interfaces/components.

AI chart generation defaults auto, offer explicit compatible options and report. Single generate request; show chosen presentation/reason using deterministic safe query metadata, no second LLM call. Route series/category/report through unified components in gallery/chat/dashboard. View switches do not change query identity or call execute/generate. Saved-card changes enter/modify layout draft, explicit save persists config.view; cancel discards; re-open shows saved view. Legacy layouts render. Unsupported options disabled/absent with clear explanation. Loading/error/retry do not duplicate requests automatically. Preserve preview-confirm-add behavior.

TDD integration includes generated series, view switch no requests, dirty/save/discard, old layout fallback. Run all unit/type/lint/build checks and mocked browser at375/768/1440 both modes. No actual AI or DB. Record results in `.superpowers/sdd/charts-task-3-report.md`. Commit owned changes. Final whole-branch review and resolve findings before claiming completion.

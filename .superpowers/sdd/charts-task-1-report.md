# Task 1 report — safe chart protocol/backend

## Outcome

- Added request kinds `auto|pie|bar|line|area|report`; executable queries exclude `auto`.
- Added bounded series results (max 366, ISO dates, finite nonnegative values, unique strict ascending dates).
- Added deterministic server-side auto selection after one planning call: date → line, category → bar, additive composition wording → pie, ungrouped → report.
- Category bar continues to return the legacy `kind: pie` slice payload; date line/area/bar returns `kind: series` without applying the category limit or filling missing dates.
- Added stable incompatible-view HTTP 400: `INSIGHT_VIEW_INCOMPATIBLE`, safe Chinese message, and `allowedViews`.
- Preserved merchant permissions, bounded readers, strict DSL, v3 layouts, legacy date pie and average-pie execution. New average pie planning is rejected.
- Product-filtered date revenue is routed through `StoreSalesReader`, which scopes reads by authenticated merchant and applies item-level product filters.

## Shared interfaces

- `DashboardInsightKind`: `auto|pie|bar|line|area|report`
- `DashboardChartView`: `pie|bar|line|area|report`
- `getDashboardInsightViews(query)`: category additive `[pie,bar]`, average `[bar]`, date `[line,area,bar]`, ungrouped `[report]`
- `DashboardInsightResult` adds `{ kind: "series"; title; summary; unit; points: { date; value }[] }`
- `pieChart` keeps its component key, label becomes `AI 图表`, and config gains optional compatible `view`; `salesTrend` gains optional `line|area` view.

## TDD evidence

RED:

- Contracts focused run: 8 failures for missing kinds, series, helper, layout view/label.
- API focused run: 5 failures for auto selection, incompatible explicit view, date series, and filtered-date routing.
- Mock provider focused run: 1 failure because auto date still produced a product pie.

GREEN / verification:

- `pnpm --filter @shopmate/contracts test:unit` → 17 files, 206 tests passed.
- `pnpm --filter @shopmate/api test:unit` → 47 passed, 1 skipped; 328 passed, 1 skipped.
- `pnpm --filter @shopmate/contracts typecheck` → passed.
- `pnpm --filter @shopmate/api typecheck` → passed.
- `pnpm --filter @shopmate/contracts lint` → passed.
- `pnpm --filter @shopmate/api lint` → passed.
- Final focused contracts run → 31 passed; final focused API insights/provider run → 46 passed.
- `git diff --check` → passed (only Windows line-ending notices).

## Review / concerns

- No real AI, paid service, deployment, arbitrary SQL, or production database operation was used.
- No missing dates, zero values, averages, or shares are fabricated.
- Existing unrelated/untracked output and the concurrently modified plan document were left unstaged.
- Source unit suites only were run; no real integration suites or controller dev server were touched.

## Review fixes (2026-09-18)

- Added `allowLegacyGroupedReport` as an explicit validator compatibility option and enabled it only in the saved-query executor. New planning still rejects grouped reports; legacy store/platform reports continue through the scoped reader.
- `getDashboardInsightViews` now returns only `report` for the unsupported `products` dataset chart shape. Auto planning detects that mismatch before execution and returns the stable `INSIGHT_VIEW_INCOMPATIBLE` 400 with `allowedViews: ["report"]`; it does not invent product catalog aggregation semantics.
- Added explicit contract regressions for 367 points and duplicate dates. Both boundary assertions passed immediately because the existing series schema already enforced max 366 and strict ascending uniqueness.

TDD RED commands/results:

- `pnpm --filter @shopmate/contracts exec vitest run src/ai/dashboard-insight.spec.ts` → 1 expected failure: products helper advertised `pie,bar` instead of `report`; 19 passed.
- `pnpm --filter @shopmate/api exec vitest run src/ai/insights/dashboard-insight-validator.spec.ts src/ai/insights/dashboard-insight-executor.spec.ts src/ai/insights/dashboard-insight.service.spec.ts` → 3 expected failures: missing grouped-report option, legacy grouped report rejected, auto products returned 503; 24 passed.

GREEN / final verification commands/results:

- `pnpm --filter @shopmate/contracts test:unit -- src/ai/dashboard-insight.spec.ts` → 17 files, 207 passed.
- API focused command above → 3 files, 27 passed.
- `pnpm --filter @shopmate/contracts typecheck` and `pnpm --filter @shopmate/api typecheck` → passed.
- `pnpm --filter @shopmate/api test:unit` → 47 passed, 1 skipped; 332 passed, 1 skipped.
- `pnpm --filter @shopmate/contracts lint` and `pnpm --filter @shopmate/api lint` → passed.

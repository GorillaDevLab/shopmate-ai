# Dashboard themes implementation plan

> Execute in this session, with test-first checkpoints and final browser review.

**Goal:** Upgrade the dashboard with warm terracotta and classic purple themes, selected from appearance settings.

**Architecture:** CSS semantic tokens on `html[data-theme]`; a small settings client component owns only appearance state. A fixed pre-paint script restores a whitelisted local preference. Existing dashboard request and analytics contracts remain unchanged.

**Stack:** Next.js 16, React 19, Tailwind 4, Vitest/Testing Library, Playwright CLI. No additional runtime dependencies.

## Constraints

Chinese labels, 375px usability, native dialog focus/escape, storage failure fallback, real API data, all existing states and range behavior. No secrets or business data in theme storage. Respect reduced motion.

## Task 1 — Theme behavior

- [x] Add `apps/web/src/app/theme-settings.test.tsx`: render the existing Dashboard, open “外观设置”, select radio “经典紫色”, assert `document.documentElement.dataset.theme === 'purple'` and localStorage `shopmate-theme === 'purple'`; switch back, close/reopen, invalid storage and blocked storage cases.
- [x] Run `pnpm --filter @shopmate/web test -- theme-settings.test.tsx`; expect failure because the settings trigger does not exist.
- [x] Create `theme.ts` with `Theme = 'terracotta' | 'purple'`, fixed bootstrap source, whitelist reader and persistence failure message. Create `theme-settings.tsx` with labeled trigger, native dialog, preview radio group and close button. Restore theme before paint in `layout.tsx`; only suppress the known root attribute hydration difference.
- [x] Run focused tests; add bootstrap tests for persisted, absent, invalid and inaccessible storage. Assert native focus/Escape in browser (jsdom dialog methods require a minimal polyfill).

## Task 2 — Shared visual system

- [x] Update `globals.css`: warm defaults, purple overrides, neutral/brand/semantic tokens, panel and list styling, theme previews, focus and reduced-motion rules.
- [x] Update `dashboard.tsx`, `metric-card.tsx`, `dashboard-range.tsx`, `sales-trend.tsx`, `product-panel-frame.tsx`, `hot-products-panel.tsx`, `low-inventory-panel.tsx`: compact heading, segmented range indicator, quieter metrics, aligned ranking and inventory rows. Keep all values, states, aria labels, input bounds and business logic intact.
- [x] Extend `dashboard-client.test.tsx`: theme selection must not call `fetchDashboard` again or change the current range/metric values.
- [x] Run `pnpm --filter @shopmate/web test`, `lint`, `typecheck`; correct regressions without weakening existing assertions.

## Task 3 — Browser and delivery

- [x] Run existing `scripts/check-dashboard-layout.js` with Playwright CLI after authenticating locally, preserving secret redaction. Verify 7/30/custom and desktop height.
- [x] Add reusable `scripts/check-dashboard-themes.js` browser check: both themes, stored preference reload, Escape focus return, selected trend and request invariance, 375px dialog overflow. Capture both desktop themes and mobile settings outside repository.
- [x] Inspect screenshots for alignment and text contrast. Check all semantic foreground/background pairs meet 4.5:1 for ordinary text.
- [x] Run production web build without colliding with the development output. Review diff, secret scan and `git diff --check`; commit scoped changes with `feat: add dashboard appearance themes`.

Plan self-review: every approved requirement maps to one of the three tasks. No backend/schema changes or copied reference assets are required.

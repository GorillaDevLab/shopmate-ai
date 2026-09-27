# Temporary Mobile Debug Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the temporary mobile debug email workflow with a local, screenshot-friendly diagnostic panel that also survives React hydration failures.

**Architecture:** Keep the existing pre-hydration inline collector, remove server delivery from the user path, and render a small Shadow DOM panel with a local preference toggle. The panel reads only in-memory sanitized diagnostics and offers copy-or-screenshot guidance; a static bootstrap fallback handles early load errors.

**Tech Stack:** Next.js App Router, TypeScript, inline browser script, Shadow DOM, Vitest/jsdom.

## Global Constraints

- No email, AI, database, or external network request for diagnostics.
- Mobile-first; desktop fine-pointer viewports hide the entry by default.
- Do not expose storage values, URL query values, tokens, cookies, or request bodies.
- Every new behavior has a failing test before production code.

### Task 1: Define panel behavior with tests

**Files:**
- Modify: `apps/web/src/app/mobile-debug-script.test.ts`

- [ ] Add tests that expect a local panel, a captured error summary, copy fallback text, and a setting that hides the entry.
- [ ] Run the targeted Vitest file and confirm the new assertions fail because the current email panel has no local diagnostic view.

### Task 2: Implement the local diagnostic panel

**Files:**
- Modify: `apps/web/src/app/mobile-debug-script.ts`
- Modify: `apps/web/src/app/layout.tsx`

- [ ] Replace the send form with a local snapshot view and “复制诊断信息/请直接截图” behavior.
- [ ] Add a persisted `shopmate_debug_enabled` preference, defaulting to enabled while the public feature flag is enabled.
- [ ] Keep the early listeners, sanitization, Shadow DOM, safe-area positioning, dialog reparenting, and mobile-only visibility.
- [ ] Add an early load-failure message without requiring React or API access.
- [ ] Run the targeted test file and confirm it passes.

### Task 3: Remove server email dependency from the temporary path

**Files:**
- Modify: `apps/api/src/app.module.ts`
- Delete: `apps/api/src/debug-report/debug-report.module.ts`
- Delete: `apps/api/src/debug-report/debug-report.spec.ts`
- Modify: `.env.example`
- Modify: `docs/mobile-debug-report.md`

- [ ] Remove the debug-report API module and email-only environment variables.
- [ ] Rewrite the temporary feature documentation to describe local screenshot diagnostics and the public build flag only.
- [ ] Run API, contracts, and web tests plus TypeScript checks.

### Task 4: Production bootstrap verification

**Files:**
- Test only: `apps/web/.next-debug-build/` (ignored build output)

- [ ] Build the web app with `NEXT_PUBLIC_ENABLE_DEBUG_REPORT=true` into the existing ignored debug build directory.
- [ ] Execute the emitted inline script in jsdom and verify the button and panel render without network calls.
- [ ] Run a secret scan and inspect the final diff.

### Task 5: Commit the implementation

- [ ] Commit the implementation and documentation with `feat: add local mobile diagnostics screen`.

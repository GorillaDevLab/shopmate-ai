# Unified Assistant Workspace Implementation Plan

> For agentic workers: use executing-plans inline and test-driven-development. User approved implementation; do not pause between tasks.

**Goal:** One DeepSeek conversation across dashboard and chat workspace, with verified chart tools, real progress, cancellation and browser-local history.

**Architecture:** Versioned NDJSON POST stream wraps the existing authenticated agent. A root client provider owns execution and a strictly validated per-identity browser store. Both UI surfaces render shared conversation components.

**Tech Stack:** NestJS, Next.js, React, Zod, Vitest, existing chart presentation components.

## Global constraints

- No live AI, production database, migrations, model changes, arbitrary SQL or automatic paid retries.
- Preserve old JSON endpoints and product-copy features; history is untrusted input.
- Same-browser history only, identity verified before loading, clear on logout/401; 30 sessions / 100 messages / 2 MiB.
- iOS 16.2 and HTTP compatible; 375px mobile, reduced motion, composition-safe textarea.
- Spec: `docs/ai/2026-09-26-assistant-workspace-design.md`.

## Task 1: Protocol and unified chart tool

Files: `packages/contracts/src/ai/assistant-run.schema.ts`, its tests and index exports; `apps/api/src/ai/tools/business-query.tools.ts`; `agent/business-agent.ts`; `chat/ai-chat.service.ts`.

Interface: `AssistantRunRequestSchema = AiChatRequestSchema.extend({requestId: bounded ID})`; event union accepted/tool-started/tool-completed/composing/completed/failed. Completed contains existing reply plus optional validated insight preview and query context.

- [x] Add schema tests rejecting unknown tenant fields and malformed terminal messages; run contracts tests and observe failure.
- [x] Implement strict schema and export. Add `create_business_chart` tool using existing query executor (no separate planning model call).
- [x] Add mock-agent chart and progress/cancel regression tests, observe failures, wire lifecycle hooks and validated artifact output, run tests.

Commands: `pnpm --filter @shopmate/contracts test`; `pnpm --filter api exec vitest run src/ai/agent src/ai/tools/business-query.tools.spec.ts src/ai/chat/ai-chat.service.spec.ts`.

## Task 2: Transport, authentication, cancellation

Files: `apps/api/src/ai/chat/assistant-run.controller.ts`, test; DeepSeek provider; `llm-provider.ts`; auth controller; nginx example.

Interface: POST `/api/v1/ai/assistant/run` NDJSON; GET `/api/v1/auth/me`; propagate `signal` to provider and guard every tool boundary. Stream events are finite schema-validated records, no raw model tokens.

- [x] Tests: duplicate IDs do not execute twice; aborted caller never receives completion; errors are typed and credentials are not emitted.
- [x] Implement authenticated run controller, 180s deadline, bounded process-local duplicate protection, close handlers and stream headers.
- [x] Verify before/after headers failure handling and provider AbortSignal forwarding with fake SDK; API tests and tsc.

## Task 3: Shared browser workspace

Files: `apps/web/src/app/assistant/{model,transport,store,provider}.ts(x)` and tests; root layout, logout button.

Interfaces: `AssistantWorkspaceProvider`, `useAssistantWorkspace`; immutable session state with IDs, completed messages, per-session draft, request state. `runAssistant(request, signal, onEvent)` returns validated terminal reply and rejects truncated stream.

- [x] Test bounded storage, identity isolation, invalid schema, history pair trimming; test split NDJSON chunks and aborted/failed/truncated stream.
- [x] Implement transport and state; defer loading until `/auth/me` succeeds; no fallback resend.
- [x] Test create/select/rename/delete, cancellation races, cross-surface continuity, storage failure and logout clearing.

## Task 4: Chat UI and integration

Files: shared `assistant/{workspace,conversation,composer,history,artifact}.tsx`, CSS; `/chat/page.tsx`; `dashboard-ai-assistant.tsx`.

- [x] Component tests for IME, Enter/Shift+Enter, stop, history operations, collapse/reopen and shared state; observe failures.
- [x] Render full workspace and resizable drawer using shared provider; use existing Markdown and charts. Preserve product-copy via collapsible form.
- [x] Add current query badge, verified-at timestamps, independent text/table scrolling, scroll-to-latest, pending dashboard artifact handoff with explicit add confirmation.
- [x] Reuse existing purple theme variables: #F6F5FA background, #FFFFFF surface, #282536 text, #69627D muted, #624DE3 accent; inherit vivid mode overrides. System Chinese font stack, 14/16px text and 24px empty-state heading. Single quiet reading canvas, not a grid of chat cards.

## Task 5: Integration and release checks

- [x] Offline browser QA with network mocked: desktop/mobile, both themes, long prose/table/chart, resize, sidebar/fullscreen continuity and run stop.
- [x] Run contracts/API/web suites separately; typecheck, scoped lint, format, production build and compatibility guard.
- [x] Update deployment guide for streaming and rollback; review whole branch before reporting finished. Do not push/deploy without user request.

## Ledger

- Baseline: `905268e`; clean tracked tree; branch `feat/assistant-workspace`.
- Pre-flight: Task 1 event/reply types feed Tasks 2/3; Task 3 store feeds Task 4; preserve JSON chat contracts for existing clients.
- Ruling: inline execution in existing dedicated feature branch; keep local output/build scratch untouched.
- Ruling: use repository `docs/ai/` for durable plan/ledger because `docs/superpowers/` is intentionally ignored.

## Verification ledger — 2026-09-26

- Contracts: 19 files / 212 tests passed.
- API: 59 files / 403 tests passed; 4 files / 9 database/live tests skipped.
- Web: 49 files / 288 tests passed.
- Web and API TypeScript checks and scoped ESLint passed.
- Web production build passed using isolated `.next-assistant-build`; compatibility guard checked 27 client bundles without regex lookbehind or class static blocks.
- Mocked browser QA: 1440px full workspace and 520px drawer share the same existing conversation; 375px document and viewport widths both 375, no horizontal overflow; both themes rendered; history Escape restores opener focus.
- Browser stop regression: one mocked request, stopped message visible, late response absent. No live AI or production database requests.
- Regression red/green confirmed for preserved summary period, draft overwrite, malformed stream errors and stream-header failure lock release.
- Final independent reviewer was requested but failed before reviewing due account quota. This is explicitly unverified; manual source review and tests were completed, not presented as an independent approval.
- User global rule applied: each independent change has its own local commit. No push, PR or deployment performed.
- Existing unrelated scratch directories were preserved.

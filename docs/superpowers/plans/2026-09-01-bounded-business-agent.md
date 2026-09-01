# Bounded Business Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a bounded server-side agent loop that selects registered read tools for Chinese business questions and explains verified results in Chinese.

**Architecture:** `BusinessAgent` orchestrates an injected `LLMProvider` and `ToolRegistry`. It exposes only registered definitions, executes validated calls with the existing merchant-scoped context, appends safe tool messages, and terminates on a final answer or strict limits.

**Tech Stack:** TypeScript 6, NestJS-compatible services, Vitest, existing `@shopmate/contracts` LLM and read-tool contracts.

## Global Constraints

- No arbitrary SQL, write tools, database schema, HTTP endpoint, or frontend changes.
- All tool calls must pass through `ToolRegistry` and its permission and Schema validation.
- Default maximum tool rounds: 3; configurable range: 1–5.
- Maximum calls per round: 4; maximum total calls: 8.
- Business numbers in answers must be derived from validated tool results.
- All failure paths must terminate and return safe Chinese copy without internal exception details.

---

### Task 1: Bounded agent orchestration

**Files:**
- Create: `apps/api/src/ai/agent/business-agent.spec.ts`
- Create: `apps/api/src/ai/agent/business-agent.ts`

**Interfaces:**
- Consumes: `LLMProvider.generate(request)`, `ToolRegistry.listDefinitions()`, `ToolRegistry.invoke(name, input, context)`.
- Produces: `BusinessAgent.run({ question, context }): Promise<BusinessAgentResult>`.

- [ ] **Step 1: Write failing orchestration tests**

Cover a scripted sales tool call followed by a Chinese final answer, injection of the validated tool JSON, the exact Registry definitions passed to the Provider, and metadata in the returned result.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @shopmate/api test:unit -- src/ai/agent/business-agent.spec.ts`

Expected: FAIL because `business-agent.js` does not exist.

- [ ] **Step 3: Implement the minimal successful loop**

Add strict input validation, system/user messages, Registry definitions, tool invocation, tool-message serialization, and final Chinese answer validation.

- [ ] **Step 4: Verify GREEN**

Run the same targeted command and expect the successful-loop tests to pass.

- [ ] **Step 5: Add failing safety tests**

Cover unknown tools, duplicate calls, maximum rounds/calls, provider errors, invalid questions, and empty final content. Assert bounded Provider and handler call counts and safe Chinese results.

- [ ] **Step 6: Implement safety limits and safe error conversion**

Add constructor option validation, duplicate fingerprints, strict counters, `ToolRegistryError` mapping, and fixed limited responses.

- [ ] **Step 7: Verify targeted suite**

Run the targeted command and expect all Agent tests to pass.

### Task 2: Deterministic Mock Provider follow-up

**Files:**
- Modify: `apps/api/src/ai/providers/mock-llm.provider.spec.ts`
- Modify: `apps/api/src/ai/providers/mock-llm.provider.ts`

**Interfaces:**
- Consumes: the last `tool` message produced by `BusinessAgent`.
- Produces: a deterministic Chinese `stop` response that summarizes the verified tool result without another tool call.

- [ ] **Step 1: Write a failing follow-up test**

Send a request containing user, assistant tool-call, and tool-result messages; expect `finishReason: "stop"` and Chinese copy derived from that result.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @shopmate/api test:unit -- src/ai/providers/mock-llm.provider.spec.ts`

Expected: FAIL because the current Mock Provider repeats the same tool call.

- [ ] **Step 3: Implement the minimal deterministic explanation**

Detect the latest tool message before intent matching, parse its JSON defensively, and return either a verified-result explanation or a safe data-unavailable explanation.

- [ ] **Step 4: Verify GREEN and regressions**

Run both targeted spec files and expect all tests to pass.

### Task 3: Full verification and delivery

**Files:**
- Review all files changed in Tasks 1–2 and the two planning documents.

- [ ] **Step 1: Format touched files**

Run the repository Prettier command over the touched TypeScript and Markdown files.

- [ ] **Step 2: Run compile and lint gates**

Run `pnpm --filter @shopmate/api typecheck` and `pnpm --filter @shopmate/api lint`; both must exit 0.

- [ ] **Step 3: Run the full API test suite**

Run `pnpm --filter @shopmate/api test`; expect zero failed tests (the credential-gated live test may remain skipped).

- [ ] **Step 4: Run secret scan**

Run `pnpm secret:scan`; expect exit 0 and no verified secret findings.

- [ ] **Step 5: Commit and open PR**

Commit only H4 files with `feat: implement bounded business agent loop`, push `feat/h4-agent-tool-selection`, and open a PR to `main` closing #59.

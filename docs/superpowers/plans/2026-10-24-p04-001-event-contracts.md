# P04-001 Event Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development for the cohesive contract unit, then coordinator-owned root-export integration and final independent review.

**Goal:** Publish strict versioned event evidence, candidate identity and readonly baseline/detection/repository/query contracts for the approved P4 task pool.

**Architecture:** Evidence uses a discriminated union of the canonical H event types and whitelisted aggregate facts. Candidate/state/reference schemas build on that boundary; ports consume P3 scope/quality/snapshots without implementing detectors, persistence or provider policy. The user explicitly assigned the existing approved P04-001 card on 2026-10-24; this executes that design rather than introducing a new product feature.

**Tech Stack:** TypeScript, Zod 4, Vitest; browser-compatible contracts package.

## Global Constraints

- Strict discriminated EventEvidenceV1, schemaVersion=1; UTC half-open periods, Asia/Shanghai, CNY, observation/watermark/quality/sample/coverage/definition/baseline/alignment retained.
- Reuse P3 safe units and status semantics. Unknown data stays nullable; no invented zero, future watermark, mismatched denominator/rate/period or arbitrary JSON/text facts.
- Full organization/workspace/store/connection/external-store scope and immutable version/hash evidence references. Repository/query authority comes from server-authenticated TenantContext, never event severity.
- EventSeverity INFO/LOW/MEDIUM/HIGH/CRITICAL is independent from ActionRisk. Opportunity PRODUCT_BREAKOUT permits INFO/LOW, cannot produce CRITICAL or authorize an action.
- Fingerprint is deterministic over organization/workspace/store/type/entity/baselineVersion. Its canonical identity string is a dedup key, not a cryptographic authorization or evidence hash.
- EventRulePolicyV1 is versioned input only; deterministic severityFloor is supplied by the deterministic detector with policy version. This card does not implement threshold strategy, robust baseline selection, database access, provider calls or HTTP routes.
- Every function/test callback <40 lines, no any, no type suppressions/empty catches; readonly nested data, explicit bounded inputs, no Node-only dependencies in browser contracts.
- One feat/ branch/PR, separate verifiable commits; independent reviews and six latest-head product CI before merge. No deployment, online migration, provider/network/secrets/permission changes.
- Existing five active contract owners retain their exclusive files; coordinator integrates only this card's root exports in a short serialized commit on current main. Do not defer public exports beyond this PR.

## Unit 1: Strict event evidence and consumer ports

**Files:** new packages/contracts/src/events/event-evidence.schema.ts, event.schema.ts, event-ports.ts, event.schema.spec.ts. No barrel/index edits by implementer.

**Interface and semantic inventory:**

- Event types: STOCKOUT_RISK, INVENTORY_STAGNATION, REFUND_SPIKE, CANCELLED_ORDER_SPIKE, PROFIT_MARGIN_DROP, UNUSUAL_DISCOUNT, ROAS_DROP, AD_SPEND_SPIKE, CONVERSION_DROP, PRODUCT_BREAKOUT, SYNC_FAILURE, REVENUE_DROP. INSUFFICIENT_EVIDENCE is quality, not another business event.
- Entity is a strict STORE/SKU/CAMPAIGN/CONNECTION union; marketing is campaign-scoped, stock/inventory/breakout SKU-scoped. Preserve complete ConnectorBinding; use no product/customer names or raw documents.
- Common evidence includes version, scope/entity/type, period, UTC observation/watermark, quality/sample/coverage, definitionVersion/baselineVersion/alignment, and bounded immutable source metric/evidence references. Known aligned baseline requires an actual same-weekday/same-time comparable period and version; missing baseline remains unavailable/null.
- Facts cover: stock availability/sales window/forecast/lead-time/ETA/freshness; stagnation holding/demand/cost coverage; refund cohort counts/rate/typed reason counts/SKU concentration; paid versus pending cancellations; revenue/profit/discount/spend/SKU contribution aggregates; funnel counts/rates/price timing; marketing spend/attributed revenue/impressions/clicks/orders/coverage; breakout velocity/conversion/margin; sync last success/lag/typed error/resource.
- Rates carry explicit basis-point semantics and exact safe-integer numerator/denominator consistency. Zero or missing denominator means null, not Infinity/zero. Probability/share rates are 0..10000; ROAS is a scaled multiplier and may exceed10000. Signed financial deltas/profits remain safe signed minor integers. Check only actual timestamps; source versions and IDs stay opaque.
- Candidate/ref/record/transition/query schemas are strict; states OPEN/ACKNOWLEDGED/RESOLVED/SUPPRESSED; revisions and expectedRevision explicit. Event evidence reference retains immutable version/hash, scope and definition/baseline identity. Cross-scope/reference/type/version mismatches fail.
- Readonly BaselinePort returns robust baseline aggregate/status/alignment/version and source references from observed MetricSnapshotV1 candidates; EventDetector.detect(request) returns candidate-or-no-candidate plus quality with typed failure; EventRepository appendEvidence/current/stateTransition and EventQueryPort list/detail/evidence/history retain authenticated scope, expected revision and bounded cursors. No interfaces grant approval/execute/provider authority.

- [ ] Add focused valid fixtures for every discriminant and negative unknown/PII/raw/token/arbitraryJSON, unsafe numbers/periods/rates/watermarks/version/scope/alignment tests. Observe legitimate RED before implementation.
- [ ] Implement evidence schemas and invariants; keep common primitives in event-evidence.schema.ts so event.schema.ts can depend on it without a runtime cycle. Commit the independently tested evidence boundary.
- [ ] Add typed candidate/fingerprint/state/reference/policy/query schemas and readonly consumer ports with compile-time tests. Observe RED and GREEN; commit the consumer contract unit separately.
- [ ] Execute exact focused test, contracts typecheck/build/lint/format, function-length/forbidden/secret checks. Freeze four files and report actual results and limits.

For canonical identity use an unambiguous ordered tuple (schema-validated fields, exact opaque strings):

```ts
JSON.stringify(["event-fingerprint-v1", organizationId, workspaceId, storeId,
  eventType, entity.kind, entityIdentity, baselineVersion]);
```

Exact ratio validation uses BigInt intermediates and the existing HALF_AWAY_FROM_ZERO convention for nonnegative ratios:

```ts
const scaled = BigInt(numerator) * 10000n;
const base = BigInt(denominator);
const expected = scaled / base + ((scaled % base) * 2n >= base ? 1n : 0n);
```

Schema validation precedes the arithmetic; denominator0/missing and unsafe values never reach division. No financial or policy defaults are introduced.

## Unit 2: Public exports and delivery integration

**Files:** packages/contracts/src/index.ts, the same event.schema.spec.ts only if a public-import assertion is needed. Coordinator owns this unit after Unit1 freezes and review approves.

- [ ] Refresh main/active PRs and integrate this card's root exports only; preserve other owners' exports. Verify focused built-package import exposes all public values/types and does not import Node-only modules.
- [ ] Run focused event tests and full contracts tests, contracts/API/workspace typechecks as warranted, lint/build/format/secrets/AST. No local database work is needed for this contract-only change.
- [ ] Obtain independent whole-branch review, fix real findings with covering tests, push one PR Closes#229, attach it to this chat and wait for the six latest exact-head product CI checks before normal merge.
- [ ] Verify issue completed, acceptance and task-state sync; release only this card's export/file reservations. Preserve worktree/branches and paused deployment.

## Acceptance

Unknown fields at every nested object and PII/raw/token/JSON carrier fields are rejected. Invalid periods/future watermark/rate denominator inconsistency/unsupported schema fail. Cross-organization/workspace/store/entity/type/baseline identities produce distinct fingerprints. Opportunity severity remains INFO/LOW and does not satisfy any action authority. Port tests establish readonly authenticated contracts, not database integration or production detector behavior.

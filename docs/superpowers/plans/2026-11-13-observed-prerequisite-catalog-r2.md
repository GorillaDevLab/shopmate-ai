# R2 observed prerequisite catalog implementation plan

> Use the selected SDD/TDD and independent review process. Parent owns all live Issue/Project operations and identities; implementer has no remote permissions or child tasks.

**Goal:** Materialize the approved 30-card observed-fact DAG in the canonical catalog/docs and prepare an exact reviewed staging manifest, without activating any task.

**BASE:** `338f076455adfed0da0b30567e5e55b96966bf9e`, merged R1 PR547 with six exact-head CI and approved full-branch review. Worktree `p24-persistent-source-composition/aiShopASAS`, isolated branch `feat/observed-prerequisite-catalog`; old R1/spec branches retained. Fresh live preflight `R2-live-before-staging.json` found 547 Issue/PR identities, 228 unique registered cards, no proposed-ID or pending-PR collision. R1 trusted-main read-only preview43408019174-1 returned setup-required with zero mutations and actual Project1 identity; raw proof in coordinator r1-identity-43408019174-1/agile-state-plan.json.

**Authority:** User approved written ChoiceA on2026-11-11, all30newcards plus R1/R2/R3; existing automatic deployment after reviewed green merge remains authorized. No new credentials, permissions, CI/deploy workflow, business logic, runner or production changes. External24P7/P8 tasks stay with collaborator. P04-029 is the only active Harry catalog card; its code worktree/locks are separate, preserve all owners/active states.

## Exact implementation steps

- [ ] Read approved design/30-card manifest and the corrected canonical candidate from coordinator. Commit this plan first. Preserve every frozen contract/acceptance/proof/exclusion and exact per-card files/dependencies/locks. Common lock paths are CONDITIONAL rules in note, never blanket sharedFiles. Use all20existingfieldtypes; no owner/status fields or fake approval graph IDs.
- [ ] Add meaningful catalog regressions to tests/agile/observed-prerequisite-catalog.test.mjs: actual catalog shape/uniqueIDs/1-4h/DAG/docs parity, approved30mapping, unchanged oldcards except exact029/031/032 edits, and per-card locks. Reuse existing validateGraph; do not duplicate its entire test suite or write a fake validator. Observe RED against absent newcards, then append the coherent30-node DAG+consumer edges atomically so no dangling intermediate catalog.
- [ ] Update phase03/04, full README index/counts and master/engineering docs consistently. Totals258/848cap-hours; P3=36/129h, P4=44/151h, otherphases unchanged. Preserve unrelated old data/text, acceptance boxes and distinction historicalinitialReady/currentReady. Do not reformat unrelated old cards. Clarify liveApp setup and no-automatic-activation claims. Record written approval in spec/companion top-level status text only, retaining allper-card requirements and proposed/unregistered state.
- [ ] Apply exact consumer changes from preparation plan, plus R2-existing-029-lock-update.md for actual coordinated footprint. Preserve029activeowner/stage/deps, alloriginalacceptance; addonlyexplicitactualsharedpaths and laterreportednewownedhelpers, not guesses. 031/032 dependon033/044 perapprovedDAG; same-window015 andqualified008 preserved.
- [ ] Prepare all30 exact Issue bodies as UTF8 LF files under coordinator R2-issue-bodies and a local stage-intent metadata JSON (id/title/bodyFile/bodyHash only, never fake Issue/node IDs). Stage titles are nonleading-ID `Prerequisite draft: ID Chinese title`; canonical headings exactly once. Keep original common constraints in clear body. No source fixed registration manifest until parent supplies live verified identities. No remote creation/rename/labels/status by implementer.
- [ ] Run targeted catalog/Agile/workspace/CI/secret and named formatting/lint, diff checks; no wholeapp/tenant repeats for metadata. Granular commits for independently verified schema/data/docs units. Report NEEDS_IDENTITIES once local reviewed catalog/docs/tests/bodies are ready. Parent reviews bodies, rechecks live uniqueness then creates native sole-Harry staging Issues without agile labels. Do not insert TODO/example identity placeholders into runtime files.
- [ ] After parent returns exact readback proof with real Project/node/number/title/repo/owner/body identity, write docs/engineering/observed-prerequisite-registration.json with exactly version,repository,projectNumber,projectId,entries[{id,number,nodeId,title}]. All30entries match approvedcardset and acknowledged readbacks; validate using actualR1validate() with no API calls. Commit manifest independently; rerun only relevant changed checks. Final cleanhead report to parent for task+strongreview/PR/sixCI/normalmerge. R3 activation is not partofR2.

## Constraints and output

Functions/callbacks/tests <40physicallines; no any/suppressions/emptycatches, secrets onlyexistingserver env, no payload/credential echo. Source default root alreadyregisters tests/agile/*.test.mjs, no rootpackage edit. Preserve allbranches/worktrees, no forcepush. Use literal LF bytes before gitdiff; this docs tree is ignored so add only exact named tracked/newapproved files asneeded, never blanket forceadd. Source Issue snapshots/identity proofs stay ignoredcoordinator, not PRdata except approved fixed manifest; no tokens or raw unrelated Issuebody copiedinto source.

Parent will collect a full old228 App preview before activation; R3 sequencing preflight warns existing normalauto events may apply immediately once coherent. Do not claim a forecast is a live pre-apply review or disable/alter normalvalidation to forceordering. R3 will record actual chronology, all258pairs/options/statuses/owners and postpreview. No R3 operation is authorized to the implementer.

Read coordinator R2-preparation-plan.md and R2-existing-029-lock-update.md below as exact data/consumer requirements. Final report R2-implementation-report.md includes commands/counts/head/remainingactualidentity gates, not sourcefeaturecompletion.

# R2 canonical catalog and staged registration preparation

Preparation only, 2026-11-11. User approved written Choice A, 30 pool cards and three separate registration packets. Frozen approved spec/JSON remain unchanged on their original checkout (parent records docs HEAD `adb36a5`). Historical “approval pending” text in those frozen documents is superseded by recorded user approval, never a graph node. No source edit, claim, Issue/Project write, dispatch or test suite was performed for this preparation. Only this plan and `R2-catalog-candidate.json` are owned outputs.

## Inputs and candidate

Actual source baseline: `C:/Users/harry/.codex/worktrees/mock-latest-read-control/aiShopASAS`, main `5ec217f66aeba5c69cef8fa5682b943eeb8cee82`; recheck HEAD/cleanliness before implementation. Read frozen `docs/superpowers/specs/2026-11-11-observed-fact-prerequisites-design.md` and matching prerequisite-cards JSON from `p24-persistent-source-composition/aiShopASAS`; read coordinator `R1-plan.md` and `prerequisite-pool-registration-preflight.md`.

Candidate is an array of exactly 30 canonical 20-field cards, P03-019..036 and P04-033..044. Every `hours` is the four-hour planning cap, including focused proof/review preparation, not elapsed time. Preserve original contract, acceptance, proof, owned paths, dependencies and locks; sharedFiles equals each frozen card’s actual sharedLocks exactly. Common shared paths are conditional global rules in note: obtain the lock before touching one; they are not blanket planned edits or reservations. Proof prose is retained in `produces`; `tests` contains targeted package/tenant commands. Lanes use existing contract/database/backend/integration/qa; kinds use contract/component/integration/verification. No catalog owner/status fields. Native Issue sole assignee `hannnnnnnny` records reservation, distinct from active work. All hard dependencies remain genuine; only existing external `P2-GATE` is accepted. No USER_* nodes or registration packets enter the pool DAG.

## Future catalog/docs/test commits

1. After R1 review/merge, refresh latest main, all repository Issues including closed/staged, pending registrations/PRs, and the complete existing 228 Issue/Project pairs. Snapshot assignees, labels, milestone, bodies/acceptance boxes, Project item/status/option IDs and active locks. Resolve allocation collisions before writes; do not infer remote uniqueness from local JSON. Preserve independent P07/P08 work and existing active assignments.
2. Add `tests/agile/observed-prerequisite-catalog.test.mjs` with meaningful fixtures for exact 20-field types, legal phase/lane/kind, unique IDs, integer 1–4h caps, known dependencies/cycles, file/lock retention, frozen-contract correspondence and canonical docs/body dependency sections. Validate the candidate plus actual existing catalog, including consumer updates below; use existing `validateGraph` with configured `P2-GATE`, never a new approval gate. This focused target is already covered by root `tests/agile/*.test.mjs`; no root script edit.
3. Append the reviewed candidate to `docs/superpowers/plans/p3-p13-agile/backlog.json`. Edit only the bounded existing consumer fields below. Preserve all other existing cards. Update `phase-03.md`, `phase-04.md`, `README.md` full index and phase counts; total 258 cards/848 cap-hours, P03 36/129h, P04 44/151h. Other phases/hours unchanged. Initial Ready counts remain historical zero-hard-dependency counts (P03=1, P04=0); current readiness is separate evidence.
4. Update `docs/superpowers/plans/2026-10-04-p3-p13-agile-task-pool.md` and `docs/engineering/agile-state-sync.md` counts, bounded registration sequence, existing App reality and existing authorized automatic deployment after reviewed green merges. Do not claim a phase/README generator exists. Keep global reconciliation fail-closed; metadata registration is not source capability acceptance or readiness.
5. Implement and run the new focused catalog test, then once run `node --test tests/workspace-structure.test.mjs tests/agile/*.test.mjs` plus relevant formatting/secret checks. Confirm docs/JSON/body parity and independent diff review. Do not rerun green suites without a new change/failure. Commit each independently verifiable test/catalog/docs change separately with clear messages; prepare one R2 PR. No implementation or tests are authorized by this preparation itself.

## Exact consumer edits to stage locally

Preserve all unmentioned fields, existing acceptance/control clauses, files, locks and automatic deployment policy.

**P04-029:** `dependsOn` and `integrationDependsOn` unchanged. Append this scope paragraph to note and its locally staged Issue body:

> 本卡仅完成现有授权指标源到事件、Rules、winner、audit/outbox的DI与原子事务接线；以真实同subject、同窗口、同cutoff的已观测零库存正例及健康/未知负例证明闭环。未知预测扩展保持typed unavailable；不伪造流量、成本、上架、ETA或失败事实。完整观测家族由P04-033..044提供；不增加这些卡为029硬依赖，不声称030并发证明或031/032全场景验收。

**P04-030:** leave catalog/dependencies and contention/atomicity scope unchanged.

**P04-031 final hard dependencies:** `P2-GATE`, `P03-018`, `P04-029`, `P04-033`, `P04-044`. Actual integration dependencies remain `[]`. Append to consumes: `scenario-observation-v2真实因果观测与P04-044受限完整家族接线证明；所有expected/forbidden/oracle仅QA持有。` Append this acceptance paragraph, retaining the original 001..008 positive/negative assertions:

> 001..008各正例与控制完整保留；008按已批准Choice A必须检出真实早期新品LOW/ESTIMATED机会，基线null/MISSING，INSUFFICIENT_DATA、NO_LLM_NEEDED、LOW_PRIORITY，建议DAILY_BRIEF且可被既有路由降为IGNORE；禁止HIGH/DEEP/SUFFICIENT/NOTIFY_NOW/ESCALATE或确认增长。授权证据视图与合格intent使用“早期新品机会，基线未成熟”。Day3/Day5与四周历史均使用原观察点封存事实；不删除008正例，不以未成熟基线制造比较增长。

**P04-032 final hard dependencies:** `P2-GATE`, `P04-029`, `P04-030`, `P04-031`, `P04-044`. Actual integration dependencies remain `[]`. Append to consumes: `P04-044真实受限接线及scenario-observation-v2封存时序；P04-031仅提供QA helper。` Append this acceptance paragraph without weakening any original 009..015 control/twin/oracle assertion:

> 完整保留009..015正例/控制、真实营收下降twin与修改/删除expected不改变provider输入输出的隔离证明。009为真实D3中断失败且D5已成功恢复；010通过十次真实saved-page投递及新旧版本乱序。015库存售罄、异常折扣、实际5倍花费三帧必须同Day5 W=[T-24h,T)、visibleAt、generation与joined revision，三者均eligible且该同窗至少两个不同won candidates；验证cap、rank、唯一合格intent及重放幂等。另单独断言成熟退款C=[T0,T0+24h)、96h lag，不计入上述同窗winner数量。

The three dependency headers in every locally staged Issue body are exactly, once, in order: `## 硬依赖（合并后才可领取）`, `## 实际接线依赖`, `## 验收`. Dependency bullets contain only exact listed IDs; empty section is `无`. Do not silently replace original acceptance boxes or unrelated metadata.

## Future staging and trusted-main manifest

R1 must actually merge first. Existing trusted-main manual `register_prerequisites=true`, `apply=false` with absent fixed manifest may produce only a read-only `setup-required` report containing the actual fixed GorillaDevLab Project 1 identity; it must perform zero writes. Missing-manifest apply fails. Run this identity preview once through the existing App after merge; inspect retained report. No arbitrary manifest/workflow input, new workflow, permissions, credentials or guessed Project ID.

Prepare all 30 exact bodies locally. Future live creation uses titles `Prerequisite draft: P03-019 冻结观测事实、因果模型与选择契约` and corresponding ID/Chinese title for each candidate. These titles have no leading bracketed ID. Set native sole assignee Harry; omit all pool/agile labels while staged. Read back actual number/nodeId/title/repository/reservation and preserve unrelated metadata. Final Issue numbers/nodeIDs and actual Project ID are deliberately absent from this preparation; never invent them.

After live proof, create reviewed `docs/engineering/observed-prerequisite-registration.json` with only `{version,repository,projectNumber,projectId,entries:[{id,number,nodeId,title}]}`: version 1, repository `GorillaDevLab/shopmate-ai`, projectNumber 1, real App-read projectId, and all 30 exact staged identities. No owner/status/arbitrary dispatch allowlist. Independently review and merge this manifest on trusted main before R1 registration. Keep dependency/consumer body edits staged locally until coordinated activation.

## R3 handoff and completion evidence

R3 records a coordinated activation window and serializes other manual operators. Register staged items via R1 exact main manifest and read back valid Backlog before exact-ID activation. Catalog merge/title/labels/body transition cannot be atomic; normal global sync must reject incomplete pairs before any write throughout the window. Activate `[ID] <Chinese title>` with existing pool/phase/lane/estimate/priority labels, actual milestone convention and exactly one `agile:backlog`; preserve every existing assignee and active state. Never bulk reset cards.

Read back all 258 unique canonical Issue/Project pairs, exact dependency bodies/status option IDs, 30 Harry reservations and unchanged existing metadata. Save main SHA, run/attempt/artifact, step/receipts/appliedIds/failedId/partialWrite and window bounds. Inspect partial-write evidence before retry. One full preview precedes reviewed apply; a fresh full preview follows with zero unexplained changes. Readiness still requires merged hard/integration closure and lock checks; at most one reserved card may become active after confirming Harry has no other active card. Source/tenant acceptance remains each later card's proof.

## Actual coordinated 029 ownership amendment

The later source-backed coordinator note `R2-existing-029-lock-update.md` is part of the implementation brief. Extend only the explicitly coordinated existing 029 shared-lock metadata and reported card-owned helpers, preserving all other fields/states. This narrowly supersedes the earlier note-only restriction for the actual adapter footprint; no dependency or acceptance weakening.

# R2 metadata update from actual P04-029 coordinated footprint

P04-029 is now the sole active Harry catalog card, started after actual Ready/sole-owner/dependency/lock readback. R1 is a separate metadata PR in review. The declared four shared paths remain; the prepared 029 plan also required small existing leaf fixes, the checked database export and isolated fixture composition. Those additional paths were explicitly coordinated before edits and have no active conflict (only unrelated P10-015 is active).

When materializing R2 consumer metadata, append these actual coordinated paths to P04-029.sharedFiles, preserving its four existing paths:

- packages/database/src/decision-run.repository.ts
- packages/database/src/index.ts
- apps/api/src/decisions/decision-evaluation.host.ts
- apps/api/src/decisions/decision-evaluation.host.spec.ts
- packages/database/test/integration/decision-storage.test.mjs
- packages/database/test/helpers/tenant-api-fixture.mjs

packages/database/test/decision-run.test.mjs was read/run only and must not be represented as a planned edit unless later actually coordinated. New card-owned helpers, pool files and tests belong to 029.files once their final exact names are reported; do not invent paths now. Cross-check the actual accepted implementation diff before closing 029.

Update phase-04 and the staged existing #257 shared-lock section consistently. Retain its owner, active lifecycle, dependency arrays, all existing acceptance boxes and unrelated body metadata. This is accurate ownership bookkeeping for already-authorized adapter work, not an added runtime feature or permission. Do not blanket-add global locks or reset Ready/active states. The same runner/API configuration lock remains exclusive to 029 while implementing; R2 metadata/test paths are disjoint.

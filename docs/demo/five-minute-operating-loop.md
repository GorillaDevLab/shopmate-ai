# Five-minute operating loop demo

## Status and scope

This document defines the five-minute ShopMate AI operating-loop demo narrative.

It is a **demo script**, not proof that every integration dependency is currently wired. When a required runtime path is unavailable, validate the wording and evidence requirements only and record the rehearsal as `NOT_RUN` rather than claiming the end-to-end demo passed.

The demo uses controlled local/demo fixtures only.

Out of scope:

- real vendor, Jev, or LLM network calls;
- production deployment or live migration;
- automatic writes to real merchant platforms;
- email, SMS, or external-platform delivery;
- invented values, platform capabilities, or successful action results.

## Demo objective

In five minutes, demonstrate one evidence-traceable operating loop:

1. Read the current period and evidence.
2. Explain an observed business change without hard-coded numbers.
3. Surface inventory risk and recommend replenishment without pretending inventory changed.
4. Create one single-SKU price candidate.
5. Require human approval.
6. Execute through the controlled Mock path.
7. Independently read back and verify the result.
8. Show the audit trail.
9. Inject a write-response-loss case and preserve `UNKNOWN` rather than blindly retrying.
10. Show the final Daily Brief / inbox result with deduplication.

## Evidence rule

Do not begin the narrative with a fixed statement such as “sales increased 12% while profit fell 8%”.

First read the current dataset period and evidence. Only describe a rise, fall, or divergence when the current evidence supports it.

Before speaking, record the references exposed by the current runtime or UI.

| Reference                           | Required before use                 | Purpose                                                |
| ----------------------------------- | ----------------------------------- | ------------------------------------------------------ |
| Current period                      | Yes                                 | Defines the business window being discussed            |
| Comparison period                   | When available                      | Defines the comparison baseline                        |
| Metric/evidence reference           | Yes                                 | Grounds sales, margin, discount, spend, and mix claims |
| Inventory evidence                  | Before replenishment recommendation | Grounds the SKU risk                                   |
| Proposal reference                  | Before approval                     | Identifies the exact price candidate                   |
| Approval reference                  | Before execution                    | Shows human approval is bound to the proposal          |
| Execution reference                 | Before discussing execution         | Proves one controlled execution attempt                |
| Verification/read-back reference    | Before claiming success             | Separates receipt from verified state                  |
| Audit reference                     | Before saying the chain is complete | Links proposal, approval, execution, and verification  |
| Brief/inbox identity or fingerprint | Final step                          | Demonstrates delivery deduplication                    |

If a required reference is unavailable, stop that branch of the story and mark it as not rehearsed.

## Five-minute narrative

### 0:00–0:40 — Establish the period and evidence

Open the operating dashboard for the prepared problematic demo store.

Before explaining any trend:

1. read the currently selected period;
2. read the comparison period when shown;
3. open or note the evidence associated with the key operating metrics;
4. confirm the evidence belongs to the current store and period.

Narration pattern:

> For this run, I am first reading the current period and its evidence. The values shown next come from this dataset rather than from a number embedded in the demo script.

If the current dataset actually shows sales increasing while margin/profit weakens, explain that observation. If it does not, describe the real direction shown by the current evidence instead.

Expected acceptance:

- no fixed percentage or fixed currency amount is required by the script;
- every material numeric statement can be traced to the current dataset/evidence;
- missing or insufficient evidence is stated as unavailable rather than replaced with zero.

### 0:40–1:20 — Explain the operating change

Use the evidence-backed analytics/assistant flow to answer why the observed business result changed.

Prefer the evidence dimensions already present in the current dataset, such as:

- discounts;
- advertising spend;
- product/category mix;
- order and unit movement;
- other evidence-backed operating drivers.

Do not invent a causal explanation if the evidence only supports correlation or an incomplete decomposition.

Expected acceptance:

- the explanation uses the same period/evidence established in the previous step;
- values come from controlled tools/data rather than model memory;
- unsupported causal claims are not presented as facts.

### 1:20–1:55 — Surface inventory risk without mutating inventory

Show a fast-selling or otherwise evidence-backed SKU with inventory risk.

Create or display a replenishment recommendation.

The recommendation is advisory only:

- it must not directly increase `available` inventory;
- it must not imply that a supplier order or warehouse receipt occurred;
- unknown inventory remains unknown rather than becoming zero.

Narration pattern:

> ShopMate can recommend what should be replenished, but the recommendation itself does not change sellable inventory.

Expected acceptance:

- inventory evidence is visible or traceable;
- recommendation and source inventory state remain separate;
- no fake stock increase is shown.

### 1:55–3:20 — Single-SKU price candidate to verified action

Select one prepared SKU and create a small price-change candidate.

The controlled path is:

`candidate → human approval → execution → independent read-back → audit`

#### Candidate

Show the exact SKU and proposed absolute target price.

Do not present a relative increment as the authoritative target.

#### Human approval

Require the prepared authorized human approval step.

The approval must remain bound to the proposal/version being demonstrated. An altered or stale proposal must not inherit an old approval.

If the current user lacks approval authority, the demo should show the action being blocked rather than bypass the permission.

#### Execution

After approval, submit one controlled Mock execution.

An execution receipt alone is not proof that the target state is verified.

#### Independent read-back

Use the independent verification/read-back path to inspect the resulting state.

Only after read-back confirms the expected target may the narration say the change is verified.

If verification is pending, mismatched, unavailable, or unknown, say so explicitly.

#### Audit

Open the available audit view or trace and show the chain linking:

- proposal;
- approving identity;
- execution;
- verification/read-back.

Expected acceptance:

- exactly one SKU candidate is used;
- human approval precedes execution;
- receipt and verified state are not conflated;
- the final claim is based on independent read-back;
- the audit chain can be traced.

### 3:20–4:20 — Write succeeded but response was lost

Switch to the prepared controlled `write-response-loss` failure scenario when that runtime control is available.

The intended condition is:

- the platform-side Mock write may have succeeded;
- the response is lost before ShopMate has a trustworthy success result.

The UI/runtime must therefore preserve the result as `UNKNOWN` or the equivalent non-success state.

Do **not** blindly retry the write.

Do **not** create a second execution merely because the first response was lost.

Instead:

1. preserve the original execution reference;
2. show that automatic blind retry is stopped;
3. invoke the independent read-back/verification path;
4. resolve the state from read-back evidence when possible.

Narration pattern:

> We do not turn a network ambiguity into a second write. The execution remains unknown until independent read-back tells us what actually happened.

Expected acceptance:

- no false success is displayed;
- no duplicate write is triggered;
- one execution identity remains traceable;
- verification, not retry, determines the next safe state.

If the response-loss control is not currently wired, describe this step only and mark it `NOT_RUN` in the checklist.

### 4:20–5:00 — Daily Brief and inbox deduplication

Finish in the Daily Brief / in-app inbox path when available.

Show that the operating event or action outcome:

- is tied to the relevant evidence;
- appears through the intended in-app delivery path;
- does not duplicate merely because the page is refreshed or the same eligible item is processed again.

Where the runtime exposes an identity/fingerprint/version, record it in the checklist.

Expected acceptance:

- first-party in-app delivery only;
- duplicate notifications are not created for the same deduplication identity;
- the final brief/inbox item does not invent a success state for an `UNKNOWN` execution;
- refreshing or reopening the UI does not itself create an additional notification.

## Controlled demo-time operations

Demo business-time advancement, when required by the prepared fixture, must use the approved demo-only session controls.

The persistent demo session supports authenticated create/read/advance/reset/disconnect operations. Business-clock advancement changes simulated business time only; it is not evidence that normalized business data has automatically synchronized.

Do not expose secrets or credentials while operating these controls.

## Failure handling during the presentation

If any expected runtime path is unavailable:

1. do not improvise an API result;
2. do not alter real data to force the story;
3. continue only with portions whose evidence is available;
4. mark the unavailable step `NOT_RUN`;
5. do not claim the five-minute end-to-end rehearsal passed.

If the general demo environment is unhealthy, use the existing project health and fixture procedures rather than inventing recovery commands.

## Completion definition

This script is ready when:

- the narrative fits the five-minute allocation;
- every quantitative statement is derived from the current run;
- replenishment remains advisory;
- price execution requires human approval;
- success requires independent read-back;
- the audit chain is observable;
- response-loss preserves `UNKNOWN` and prevents blind retry;
- Daily Brief / inbox deduplication is explicitly checked.

A completed document is not equivalent to a completed end-to-end rehearsal. Runtime rehearsal evidence belongs to the dedicated verification task.

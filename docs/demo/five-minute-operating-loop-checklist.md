# Five-minute operating loop rehearsal checklist

Use this checklist with `docs/demo/five-minute-operating-loop.md`.

## Result values

For every section, use one of:

- `PASS` — executed and observed as required;
- `FAIL` — executed but behavior did not meet the requirement;
- `NOT_RUN` — runtime dependency is unavailable or the step was intentionally not executed.

Do not convert `NOT_RUN` into `PASS` based only on a contract, source file, or planned behavior.

## Run record

| Field              | Value                 |
| ------------------ | --------------------- |
| Date/time          |                       |
| Operator           |                       |
| Branch/commit      |                       |
| Environment        | local fixture / demo  |
| Store              |                       |
| Current period     |                       |
| Comparison period  |                       |
| Total elapsed time |                       |
| Overall result     | PASS / FAIL / NOT_RUN |

## 1. Preflight

- [ ] No real vendor/Jev/LLM network call is required.
- [ ] No production deployment or live migration is performed.
- [ ] No secret is visible in screen share, terminal output, screenshot, Issue, or PR.
- [ ] The selected store is an approved synthetic/demo store.
- [ ] Current period is visible or retrievable.
- [ ] Current dataset/evidence is available.
- [ ] Required demo controls are available for every step intended to be marked `PASS`.

Preflight result: `PASS / FAIL / NOT_RUN`

Notes:

## 2. 0:00–0:40 — Period and evidence

Start: `__:__`

- [ ] Read the current period before making a business claim.
- [ ] Record the comparison period when available.
- [ ] Record metric/evidence references before narrating changes.
- [ ] Do not use a hard-coded percentage, amount, or date from the script.
- [ ] Missing evidence is described as missing/insufficient rather than zero.

Recorded references:

| Reference              | Value |
| ---------------------- | ----- |
| Current period         |       |
| Comparison period      |       |
| Sales evidence         |       |
| Margin/profit evidence |       |
| Other evidence         |       |

Result: `PASS / FAIL / NOT_RUN`

End: `__:__`

## 3. 0:40–1:20 — Explain the operating change

Start: `__:__`

- [ ] Explanation uses the same current period/evidence.
- [ ] Discount/spend/mix or another driver is shown only when supported by evidence.
- [ ] Tool/data output, not model memory, grounds quantitative claims.
- [ ] Correlation is not presented as proven causation when evidence is insufficient.

Evidence/driver refs:

Result: `PASS / FAIL / NOT_RUN`

End: `__:__`

## 4. 1:20–1:55 — Inventory risk and replenishment

Start: `__:__`

- [ ] A SKU inventory risk is grounded in the current dataset.
- [ ] A replenishment recommendation is visible or traceable.
- [ ] Creating the recommendation does not increase sellable inventory.
- [ ] Recommendation does not imply a supplier/warehouse action occurred.
- [ ] Unknown inventory is not replaced with zero.

| Reference                      | Value |
| ------------------------------ | ----- |
| SKU                            |       |
| Inventory evidence             |       |
| Recommendation                 |       |
| Available before               |       |
| Available after recommendation |       |

Expected: `available after recommendation` remains the source state unless a separate verified inventory operation actually occurred.

Result: `PASS / FAIL / NOT_RUN`

End: `__:__`

## 5. 1:55–3:20 — Single-SKU price operating loop

Start: `__:__`

### Candidate

- [ ] Exactly one prepared SKU is used.
- [ ] Absolute target price is shown.
- [ ] Proposal/candidate identity is recorded.

Proposal reference:

### Human approval

- [ ] Approval occurs before execution.
- [ ] Approving identity is visible/traceable.
- [ ] Approval remains bound to the demonstrated proposal/version.
- [ ] Unauthorized approval is blocked rather than bypassed.

Approval reference:

### Execution

- [ ] One controlled Mock execution is submitted.
- [ ] Execution identity is recorded.
- [ ] A receipt is not narrated as verified success.

Execution reference:

### Independent read-back

- [ ] Verification/read-back is separate from the execution receipt.
- [ ] Expected and observed target can be compared.
- [ ] Success is claimed only after verified read-back.
- [ ] Pending/mismatch/unavailable/unknown is preserved accurately.

Verification/read-back reference:

### Audit

- [ ] Proposal is traceable.
- [ ] Approval is traceable.
- [ ] Execution is traceable.
- [ ] Verification is traceable.
- [ ] Actor/identity information is traceable without exposing secrets.

Audit reference:

Result: `PASS / FAIL / NOT_RUN`

End: `__:__`

## 6. 3:20–4:20 — Write-response-loss failure

Start: `__:__`

If the controlled response-loss runtime is not yet wired, mark this section `NOT_RUN`.

- [ ] Prepared response-loss failure is enabled without modifying production or real merchant data.
- [ ] Only one execution identity is created for the write attempt.
- [ ] Lost response does not become false `SUCCESS`.
- [ ] Result remains `UNKNOWN` or equivalent safe unresolved state.
- [ ] Automatic/blind write retry does not occur.
- [ ] No operator action creates a duplicate execution just to obtain a response.
- [ ] Independent read-back/verification is used to determine the resulting state.
- [ ] Audit retains the ambiguous execution and its later resolution.

| Reference              | Value |
| ---------------------- | ----- |
| Fault scenario/control |       |
| Original execution     |       |
| Immediate result       |       |
| Verification/read-back |       |
| Final safe state       |       |
| Audit reference        |       |

Result: `PASS / FAIL / NOT_RUN`

End: `__:__`

## 7. 4:20–5:00 — Daily Brief / inbox deduplication

Start: `__:__`

If the integrated Daily Brief / inbox runtime is unavailable, mark this section `NOT_RUN`.

- [ ] Relevant brief/inbox item is linked to current evidence.
- [ ] Delivery is in-app only.
- [ ] Item does not convert an unresolved execution into false success.
- [ ] Notification/brief identity, fingerprint, or version is recorded when exposed.
- [ ] Refresh/reopen does not create a second item.
- [ ] Reprocessing the same eligible observation does not create a duplicate item.

| Reference                      | Value |
| ------------------------------ | ----- |
| Brief/version                  |       |
| Inbox/notification identity    |       |
| Evidence refs                  |       |
| Count before refresh/reprocess |       |
| Count after refresh/reprocess  |       |

Result: `PASS / FAIL / NOT_RUN`

End: `__:__`

## 8. Timing result

| Segment                                                 |   Target |
| ------------------------------------------------------- | -------: |
| Period and evidence                                     |     0:40 |
| Operating explanation                                   |     0:40 |
| Inventory/replenishment                                 |     0:35 |
| Candidate → approval → execution → verification → audit |     1:25 |
| Response-loss failure                                   |     1:00 |
| Daily Brief / inbox dedup                               |     0:40 |
| **Total**                                               | **5:00** |

Actual total:

- [ ] `<= 5:00`
- [ ] `> 5:00`

Timing result: `PASS / FAIL / NOT_RUN`

## 9. Evidence-trace final gate

Before marking the overall rehearsal `PASS`:

- [ ] Every material business number traces to the current run.
- [ ] No fixed demo number was substituted for unavailable evidence.
- [ ] Replenishment did not fake inventory mutation.
- [ ] Price execution was human-approved.
- [ ] Execution receipt was separated from verification.
- [ ] Independent read-back determined verified success.
- [ ] Audit linked the operating chain.
- [ ] Response loss did not trigger blind retry.
- [ ] Brief/inbox deduplication was observed.
- [ ] No real platform write, deployment, live migration, email, SMS, or external-platform delivery occurred.

If any runtime-dependent item above is `NOT_RUN`, the documentation may still be accepted as the P10-015 script deliverable, but the end-to-end rehearsal must remain `NOT_RUN`.

## 10. Final result

Overall:

`PASS / FAIL / NOT_RUN`

Observed defects:

1.
2.
3.

Follow-up Issue/PR references:

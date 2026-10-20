# Task-pool dependency and state reconciliation design

## Goal and observed failure

Keep all 228 P3–P13 cards consistent after merges, CI completion and issue changes. The existing coordination guide explicitly requires manual dependency reconciliation; merging a PR closes its issue but does not unlock successors. The audit found P03-011 and P03-013 still labelled in-review after merged PRs and six successful checks. P03-015 was manually repaired in the preceding request.

## Recommended approach

Add a deterministic, idempotent repository reconciler with dry-run as its CLI default and a small metadata-only GitHub Actions workflow. Run on merged PR closure, CI workflow completion, relevant issue state/ownership/label edits and manual dispatch. Read only trusted default-branch policy/source. Do not run application builds, install dependencies, deploy, merge PRs or schedule polling. Serialize applications to avoid overlapping writers. Retain a compact Actions summary of decisions and blockers; avoid automatic issue comments.

Alternatives considered: manual bulk repair fixes today's state but repeats the failure; a periodic-only workflow adds runner minutes and delays unlocks. Event-driven reconciliation plus manual full repair handles both without scheduled polling.

## Rules

- Use the versioned backlog.json dependency graph and an exact one-to-one Pxx-nnn-to-Issue map. Validate unique IDs, dependencies, acyclicity, known status labels and Project configuration before applying. Ambiguous/missing cards, conflicting Issue dependency sections, incomplete API pagination, API errors or unknown external gates fail closed.
- A prerequisite is complete only when its Issue is closed as completed and has a linked PR merged into the repository default branch with the configured six CI checks successful at that PR's exact latest head. Pending, cancelled, skipped, absent or failing required checks do not count. Merely closing an Issue is insufficient. Do not execute fetched PR code.
- Re-evaluate hard dependsOn only for component readiness. Preserve integrationDependsOn as a separate wiring gate and report it; never imply actual integration is complete. Resolve external P2-GATE only through an explicitly configured, independently verified gate mapping; otherwise keep it blocked.
- Eligible inactive Backlog cards become Ready after dependency and shared-file conflict checks. Inactive Ready cards whose prerequisites become incomplete return to Backlog. Do not automatically claim, assign or start cards.
- Preserve all existing assignees. Preserve In progress and In review work, including the seven explicitly approved parallel cards; report newly discovered dependency, multiple-owner or file-lock conflicts for coordination instead of silently resetting active work.
- Retire stale lifecycle labels on genuinely completed cards and align their Project status with Done. Do not close issues, tick acceptance checkboxes, manufacture review evidence, or infer that closed fixtures mean production wiring. Completed cards release their own file reservations; this does not grant another task a lock.
- Synchronize lifecycle labels and the native Project Status field in the same reconciliation plan. Paginate all reads, re-read affected entities immediately before writes, skip unchanged values, and stop/report partial failures so a rerun repairs them. Do not remove/recreate Project items or overwrite other fields. No claim of transactional locking across GitHub APIs.

## Permissions and trust

Use GITHUB_TOKEN only for repository metadata with explicit issues:write and read-only contents/checks/pull-requests/actions. Organization Project writes require a separate installed GitHub App with organization Projects read/write access, as recommended by GitHub. Limit its installation to this repository and use its token only for Project operations. No contents write, workflow write, admin, deployment or branch-bypass permission. Never print tokens or store them in source, reports or caches.

Current local gh authentication lacks read:project, and repository secrets contain only existing server deployment credentials. No Project automation App is configured. Prepare the code and setup instructions first; a human must provision/approve the new App access and set the named App ID/private-key secrets through GitHub settings. Do not reuse deployment SSH credentials or silently expand the local OAuth scope. Missing Project credentials produce an explicit incomplete-setup result, not a false all-synchronized success.

## Planned files and tests

Add focused modules under scripts/agile/ for graph/state policy, GitHub reads/writes and CLI orchestration, with node:test tests under tests/agile/. Add one metadata-only workflow and its workflow-security contract tests. Update the coordination guide to describe automatic readiness versus manual claiming/locking, and provide exact setup, dry-run, apply, failure-repair and rollback instructions.

Test transitive dependencies, mixed/failing/pending/missing checks, exact head association, no-PR closures, external gates, reopened dependencies, cycles/duplicates/missing cards, full pagination, assignee preservation, active-state preservation, file conflicts, idempotency, concurrent-state changes, partial failures, missing credentials and trusted-branch workflow checkout. No merchant data or application business logic changes.

## One-time repair and delivery

Audit every live card against the approved policy; save the proposed changes before applying. Repair only verified stale states and preserve ownership. Verify the Ready queue and affected Project rows after application. Commit independent changes, run focused tests/lint/format/secrets and appropriate workflow validation, independent review, create one PR and attach it to this chat. Keep future automation labelled not enabled until its workflow is merged, credentials are configured and an actual dry-run/apply succeeds.

Rollback disables the new metadata workflow and retains the audit evidence. Revert incorrect metadata from the saved before-state, never delete cards or alter application/deployment settings.
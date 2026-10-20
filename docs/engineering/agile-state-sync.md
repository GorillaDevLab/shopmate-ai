# P3–P13 task-state reconciliation

The metadata-only reconciler keeps all 228 task Issues and the organization Project Status field aligned with the versioned [backlog](../superpowers/plans/p3-p13-agile/backlog.json). It plans the entire pool on every run. A dry run is the CLI default; `--apply` is explicit. It does not claim work, change assignees, edit Issue bodies or acceptance boxes, close Issues, run application code, or deploy.

## Completion and readiness

A card is complete only if its Issue is closed with the **completed** reason and an explicitly linked PR was merged into the repository default branch. The PR must list the exact Issue in `closingIssuesReferences`, and the latest trusted `CI` workflow run for the PR's exact head SHA must contain six completed, successful GitHub Actions check runs from that run's check suite. The configured check names in [config.json](../../scripts/agile/config.json) are `质量门禁`, four `历史源与同步验收` profiles (`growing`, `problematic`, `mature`, `new`), and `15 场景源与同步验收`. A skipped, missing, cancelled, pending or failed check leaves completion unverified. Native Project auto-Done and Issue closure alone do not release a dependency.

The planner validates a one-to-one map of backlog IDs, repository Issues and Project items, both Issue dependency sections, known lifecycle labels, Project Status options, and graph cycles before writing. Unknown external dependencies fail validation. `P2-GATE` is a known, blocked external gate until an explicit mapping passes independent Issue/PR/CI verification. `dependsOn` controls component readiness. `integrationDependsOn` is reported as a separate wiring gate; a fixture-complete component does not imply production integration.

An unassigned Backlog card with verified hard prerequisites and no active file reservation becomes Ready. An inactive Ready card with a new blocker returns to Backlog. Closed cards with unverified completion move to In review, so native auto-Done does not advertise completion while CI is pending. In progress and In review cards, including approved parallel work, retain their state and assignees; new dependency, owner or file collisions appear in the report for coordination. Verified Done cards have stale lifecycle labels removed, retain all unrelated labels, and get native Project Status Done.

## Permissions and enablement

The workflow uses the repository `GITHUB_TOKEN` for Issue labels and read-only repository metadata: `issues:write`, `contents:read`, `checks:read`, `actions:read`, and `pull-requests:read`. Create a separate GitHub App with **organization Projects read/write** and **repository Issues read** access, install it only on `GorillaDevLab/shopmate-ai`, and approve that grant through the normal GitHub settings flow. Store its App ID in repository secret `AGILE_PROJECT_APP_ID` and its private key in `AGILE_PROJECT_APP_PRIVATE_KEY`. The pinned `actions/create-github-app-token` step requests only `permission-organization-projects: write` and `permission-issues: read`, limited to this repository, and supplies its token only to Project GraphQL calls. Do not reuse deployment credentials or expand a personal OAuth token.

No Project App is configured yet. Until the App is installed and those two secrets exist, the workflow reports `setup-required` and fails before writes. A local full CLI run without `PROJECT_TOKEN` also returns `setup-required`. This code becomes live automation only after the workflow is merged, the App is provisioned, and a manual dry run and apply have been checked against the actual Project.

The workflow runs after a merged PR, completed `CI` workflow, task-pool Issue event, relevant default-branch policy push, or manual dispatch. Issue events are filtered by `agile-p3-p13`; a separately configured external gate Issue must have `agile-external-gate`. It checks out `main` with credentials disabled, uses pinned official actions, serializes runs, and performs no dependency installation or build. Manual dispatch defaults to preview; set its `apply` input to write. The seven-day `agile-state-plan` Actions artifact retains the before-state and decision record; the Actions summary contains only validated task IDs and reason codes.

## Local operation

Use Node 22 or newer from a trusted checkout of current `main`. Supply the repository token through `GITHUB_TOKEN` or `GH_TOKEN` and the separate App installation token through `PROJECT_TOKEN`; the CLI never reads `gh` credentials itself. Keep tokens in the environment, never in arguments, files, or logs.

```sh
node scripts/agile/sync.mjs
node scripts/agile/sync.mjs --apply
node scripts/agile/sync.mjs --labels-only --apply
node scripts/agile/sync.mjs --report /path/to/private-plan.json
```

The first command previews the complete plan. `--apply` re-reads the entire pool immediately before each changed card, directly re-reads the affected Issue and Project item before their writes, and skips unchanged values. It stops on a conflict or API failure; rerun after examining the saved before-state. `--labels-only` is an explicit repair option when Project access is unavailable and always reports `project-incomplete`, including after label writes. It is not a successful full sync. The default local report is `.superpowers/sdd/agile-sync-last-plan.json`, ignored by Git; protect that local file as task metadata.

GitHub Issue and Project APIs do not provide a transaction or lock. A concurrent change can occur after the last read, and Project's native automation can act between calls. The reconciler never overwrites unrelated Project fields or assignees. If a partial failure occurs, the report records which card and which half of the label/Status pair may have changed. Re-run the full dry run and apply once the conflict is resolved. REST and GraphQL reads page to completion, reject repeated or missing cursors, use a 20-second request timeout and a bounded page count, and fail closed on API or rate-limit errors.

For an approved external gate, add an `externalGateSources` entry to `config.json` with its exact repository, Issue number, and expected title. For example: `"P2-GATE": {"repository":"GorillaDevLab/shopmate-ai","issueNumber":900,"expectedTitle":"Approved P2 acceptance gate"}`. The number and title are illustrative; do not add this entry without a reviewed real gate. The gate verifies the mapped Issue's completed closure, linked merged default-branch PR, and the same six exact-head CI checks. A missing or failed gate remains blocked.

To roll back, disable the new workflow, inspect the retained plan artifact, and restore any incorrect Issue lifecycle labels and Project Status from its recorded before-state. Do not remove Project items or alter application/deployment settings. Removing the workflow does not alter already written metadata.

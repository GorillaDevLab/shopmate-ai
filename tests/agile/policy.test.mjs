import assert from "node:assert/strict";
import test from "node:test";
import {
  completionEvidence,
  planReconciliation,
  validateGraph,
} from "../../scripts/agile/policy.mjs";

const checks = ["quality", "history-a", "history-b", "history-c", "scenarios", "build"];
const card = (id, dependsOn = [], extra = {}) => ({
  id,
  dependsOn,
  integrationDependsOn: [],
  files: [],
  sharedFiles: [],
  ...extra,
});
const issue = (id, label = "agile:backlog", extra = {}) => ({
  id,
  number: Number(id.slice(-3)),
  state: "OPEN",
  stateReason: null,
  labels: [label, "phase:p03"],
  assignees: [],
  body: "## 硬依赖（合并后才可领取）\n\n- 无\n\n## 实际接线依赖\n\n- 无",
  ...extra,
});
const project = (id, status = "Backlog") => ({ id, itemId: `item-${id}`, status });
const done = (id) => issue(id, "agile:done", { state: "CLOSED", stateReason: "COMPLETED" });
const pr = (id, overrides = {}) => ({
  mergedAt: "2026-10-20T00:00:00Z",
  baseRefName: "main",
  headRefOid: "a".repeat(40),
  closingIssueIds: [id],
  checks: checks.map((name) => ({
    name,
    status: "completed",
    conclusion: "success",
    headSha: "a".repeat(40),
    trusted: true,
  })),
  ...overrides,
});
const config = { requiredChecks: checks, defaultBranch: "main", externalGateIds: ["P2-GATE"] };
const snapshot = (cards, issues, prs = [], projects = cards.map((x) => project(x.id))) => ({
  cards,
  issues,
  prs,
  projects,
  externalGates: {},
});

test("graph rejects duplicate, missing and cyclic hard dependencies", () => {
  assert.throws(() => validateGraph([card("P03-001"), card("P03-001")], config), /duplicate/i);
  assert.throws(() => validateGraph([card("P03-001", ["P03-999"])], config), /unknown/i);
  assert.throws(
    () => validateGraph([card("P03-001", ["P03-002"]), card("P03-002", ["P03-001"])], config),
    /cycle/i,
  );
});

test("same card may have a hard dependency and a separate integration gate on one ID", () => {
  assert.doesNotThrow(() =>
    validateGraph(
      [
        card("P03-001"),
        card("P03-002", ["P03-001"], {
          integrationDependsOn: ["P03-001"],
        }),
      ],
      config,
    ),
  );
});

test("unknown external gates fail; known unverified gate remains blocked", () => {
  assert.throws(() => validateGraph([card("P03-001", ["OTHER-GATE"])], config), /unknown/i);
  const result = planReconciliation(
    snapshot(
      [card("P03-001", ["P2-GATE"])],
      [
        issue("P03-001", "agile:ready", {
          body: "## 硬依赖（合并后才可领取）\n- `P2-GATE`\n## 实际接线依赖\n- 无",
        }),
      ],
    ),
    config,
  );
  assert.equal(result.entries[0].after, "Backlog");
  assert.match(result.entries[0].blockers.join(" "), /P2-GATE/);
});

test("completion requires linked merged main PR and exact trusted successful checks", () => {
  assert.equal(completionEvidence(done("P03-001"), [], config).complete, false);
  assert.equal(completionEvidence(done("P03-001"), [pr("P03-002")], config).complete, false);
  assert.equal(completionEvidence(done("P03-001"), [pr("P03-001")], config).complete, true);
  assert.equal(
    completionEvidence(done("P03-001"), [pr("P03-001", { baseRefName: "dev" })], config).complete,
    false,
  );
});

test("completed Issues may have retired all lifecycle labels", () => {
  const completed = done("P03-001");
  completed.labels = [];
  const result = planReconciliation(
    snapshot([card("P03-001")], [completed], [pr("P03-001")], [project("P03-001", "Done")]),
    config,
  );
  assert.equal(result.entries[0].after, "Done");
  assert.equal(result.entries[0].labelAfter, null);
});

test("skipped, missing, wrong-head and untrusted checks cannot complete a card", () => {
  for (const changed of [
    { conclusion: "skipped" },
    { headSha: "b".repeat(40) },
    { trusted: false },
  ]) {
    const broken = pr("P03-001");
    broken.checks[0] = { ...broken.checks[0], ...changed };
    assert.equal(completionEvidence(done("P03-001"), [broken], config).complete, false);
  }
  const missing = pr("P03-001");
  missing.checks.pop();
  assert.equal(completionEvidence(done("P03-001"), [missing], config).complete, false);
});

test("reopened prerequisite demotes inactive successor and transitive completion unlocks it", () => {
  const cards = [card("P03-001"), card("P03-002", ["P03-001"]), card("P03-003", ["P03-002"])];
  const issues = [done("P03-001"), done("P03-002"), issue("P03-003")];
  issues[1].body =
    "## 硬依赖（合并后才可领取）\n- [P03-001](https://example.test)\n## 实际接线依赖\n- 无";
  issues[2].body =
    "## 硬依赖（合并后才可领取）\n- [P03-002](https://example.test)\n## 实际接线依赖\n- 无";
  const ready = planReconciliation(snapshot(cards, issues, [pr("P03-001"), pr("P03-002")]), config);
  assert.equal(ready.entries[2].after, "Ready");
  issues[1] = issue("P03-002", "agile:ready", { body: issues[1].body });
  issues[2].labels[0] = "agile:ready";
  const blocked = planReconciliation(
    snapshot(
      cards,
      issues,
      [pr("P03-001"), pr("P03-002")],
      [project("P03-001", "Done"), project("P03-002", "Ready"), project("P03-003", "Ready")],
    ),
    config,
  );
  assert.equal(blocked.entries[2].after, "Backlog");
});

test("closed intermediate card cannot bypass a reopened ancestor", () => {
  const cards = [card("P03-001"), card("P03-002", ["P03-001"]), card("P03-003", ["P03-002"])];
  const issues = [issue("P03-001"), done("P03-002"), issue("P03-003", "agile:ready")];
  issues[1].body = "## 硬依赖（合并后才可领取）\n- `P03-001`\n## 实际接线依赖\n- 无";
  issues[2].body = "## 硬依赖（合并后才可领取）\n- `P03-002`\n## 实际接线依赖\n- 无";
  const result = planReconciliation(snapshot(cards, issues, [pr("P03-002")]), config);
  assert.equal(result.entries[2].after, "Backlog");
});

test("active work and assignees stay untouched; shared locks block inactive Ready", () => {
  const cards = [
    card("P03-001", [], { sharedFiles: ["packages/contracts/src/index.ts"] }),
    card("P03-002", [], { sharedFiles: ["packages/contracts/src/index.ts"] }),
  ];
  const issues = [
    issue("P03-001", "agile:in-progress", { assignees: ["alice"] }),
    issue("P03-002", "agile:ready", { assignees: ["bob"] }),
  ];
  const result = planReconciliation(
    snapshot(cards, issues, [], [project("P03-001", "In progress"), project("P03-002", "Ready")]),
    config,
  );
  assert.equal(result.entries[0].after, "In progress");
  assert.equal(result.entries[1].after, "Backlog");
  assert.deepEqual(issues[1].assignees, ["bob"]);
  assert.match(result.entries[1].blockers.join(" "), /lock/i);
});

test("one existing assignee preserves Ready and does not block Backlog unlocking", () => {
  const cards = [card("P03-001"), card("P03-002", ["P03-001"])];
  const dependentBody = "## 硬依赖（合并后才可领取）\n- `P03-001`\n## 实际接线依赖\n- 无";
  for (const label of ["agile:ready", "agile:backlog"]) {
    const assigned = issue("P03-002", label, { assignees: ["hannnnnnnny"], body: dependentBody });
    const plan = planReconciliation(
      snapshot(cards, [done("P03-001"), assigned], [pr("P03-001")]),
      config,
    );
    assert.equal(plan.entries[1].after, "Ready");
    assert.deepEqual(assigned.assignees, ["hannnnnnnny"]);
    assert.deepEqual(plan.entries[1].blockers, []);
  }
});

test("multiple owners remain a reported readiness conflict", () => {
  const assigned = issue("P03-001", "agile:ready", { assignees: ["alice", "bob"] });
  const plan = planReconciliation(snapshot([card("P03-001")], [assigned]), config);
  assert.equal(plan.entries[0].after, "Backlog");
  assert.match(plan.entries[0].blockers.join(" "), /multiple owners/i);
});

test("active work with newly incomplete dependency stays active and reports it", () => {
  const cards = [card("P03-001"), card("P03-002", ["P03-001"])];
  const issues = [
    issue("P03-001"),
    issue("P03-002", "agile:in-progress", {
      body: "## 硬依赖（合并后才可领取）\n- [P03-001](https://example.test)\n## 实际接线依赖\n- 无",
    }),
  ];
  const result = planReconciliation(
    snapshot(cards, issues, [], [project("P03-001"), project("P03-002", "In progress")]),
    config,
  );
  assert.equal(result.entries[1].after, "In progress");
  assert.match(result.entries[1].blockers.join(" "), /dependency P03-001/);
});

test("multiple lifecycle labels and dependency section mismatches fail validation", () => {
  const cards = [card("P03-001")];
  assert.throws(
    () =>
      planReconciliation(
        snapshot(cards, [
          issue("P03-001", "agile:ready", { labels: ["agile:ready", "agile:backlog"] }),
        ]),
        config,
      ),
    /lifecycle/i,
  );
  assert.throws(
    () =>
      planReconciliation(
        snapshot(cards, [
          issue("P03-001", "agile:backlog", {
            body: "## 硬依赖（合并后才可领取）\n- `P2-GATE`\n## 实际接线依赖\n- 无",
          }),
        ]),
        config,
      ),
    /mismatch/i,
  );
});

test("verified completed card retires a stale Done lifecycle label", () => {
  const result = planReconciliation(
    snapshot([card("P03-001")], [done("P03-001")], [pr("P03-001")], [project("P03-001", "Done")]),
    config,
  );
  assert.deepEqual(
    result.changed.map((entry) => entry.id),
    ["P03-001"],
  );
  assert.equal(result.entries[0].labelAfter, null);
});

test("native Project Done cannot hide a closed Issue with pending CI", () => {
  const result = planReconciliation(
    snapshot([card("P03-001")], [done("P03-001")], [], [project("P03-001", "Done")]),
    config,
  );
  assert.equal(result.entries[0].after, "In review");
  assert.match(result.entries[0].blockers.join(" "), /completion evidence/i);
  assert.equal(result.entries[0].labelAfter, "agile:in-review");
});

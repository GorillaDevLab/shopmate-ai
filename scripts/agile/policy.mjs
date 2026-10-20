const ID = /^P\d{2}-\d{3}$/;
const STATES = new Map([
  ["agile:backlog", "Backlog"],
  ["agile:ready", "Ready"],
  ["agile:in-progress", "In progress"],
  ["agile:in-review", "In review"],
  ["agile:done", "Done"],
]);
const LABELS = new Map([...STATES].map(([label, state]) => [state, label]));

function distinct(values, context) {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${context}`);
  return values;
}

function dependencies(card) {
  return [...card.dependsOn, ...card.integrationDependsOn];
}

export function validateGraph(cards, config) {
  distinct(
    cards.map((card) => card.id),
    "card ID",
  );
  const byId = new Map(cards.map((card) => [card.id, card]));
  const allowed = new Set(config.externalGateIds ?? []);
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error(`dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of dependencies(byId.get(id))) {
      if (!byId.has(dep) && !allowed.has(dep)) throw new Error(`unknown dependency ${dep}`);
      if (byId.has(dep)) visit(dep);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const card of cards) {
    if (!ID.test(card.id)) throw new Error(`invalid card ID ${card.id}`);
    distinct(card.dependsOn, `hard dependencies for ${card.id}`);
    distinct(card.integrationDependsOn, `integration dependencies for ${card.id}`);
    visit(card.id);
  }
  return byId;
}

function section(body, heading, nextHeading) {
  const start = body.indexOf(heading);
  if (start < 0) throw new Error(`missing Issue ${heading} section`);
  const rest = body.slice(start + heading.length);
  const end = rest.indexOf(nextHeading);
  return (end < 0 ? rest : rest.slice(0, end))
    .split("\n")
    .filter((line) => /^\s*-\s/.test(line))
    .join("\n");
}

function issueDependencies(body, heading, nextHeading) {
  const source = section(body, heading, nextHeading);
  const ids = [...source.matchAll(/\b(?:P\d{2}-\d{3}|P2-GATE)\b/g)].map((match) => match[0]);
  return distinct(ids, `${heading} Issue section`).sort();
}

function validateIssue(card, issue) {
  if (issue.id !== card.id) throw new Error(`Issue map mismatch for ${card.id}`);
  const labels = issue.labels.filter((label) => STATES.has(label));
  const retired =
    labels.length === 0 && issue.state === "CLOSED" && issue.stateReason === "COMPLETED";
  if (labels.length !== 1 && !retired) throw new Error(`ambiguous lifecycle labels for ${card.id}`);
  const hard = issueDependencies(issue.body, "## 硬依赖（合并后才可领取）", "## 实际接线依赖");
  const wiring = issueDependencies(issue.body, "## 实际接线依赖", "## 验收");
  if (hard.join("|") !== [...card.dependsOn].sort().join("|"))
    throw new Error(`hard dependency mismatch for ${card.id}`);
  if (wiring.join("|") !== [...card.integrationDependsOn].sort().join("|"))
    throw new Error(`integration dependency mismatch for ${card.id}`);
  return retired ? "Done" : STATES.get(labels[0]);
}

export function completionEvidence(issue, prs, config) {
  if (issue.state !== "CLOSED" || issue.stateReason !== "COMPLETED")
    return { complete: false, reason: "Issue not closed as completed" };
  const linked = prs.filter(
    (pr) =>
      pr.closingIssueIds.includes(issue.id) &&
      pr.mergedAt &&
      pr.baseRefName === config.defaultBranch,
  );
  for (const pr of linked) {
    const good = config.requiredChecks.every((name) =>
      pr.checks.some(
        (check) =>
          check.name === name &&
          check.status === "completed" &&
          check.conclusion === "success" &&
          check.headSha === pr.headRefOid &&
          check.trusted === true,
      ),
    );
    if (good) return { complete: true, prNumber: pr.number };
  }
  return {
    complete: false,
    reason: linked.length
      ? "Required CI incomplete at exact PR head"
      : "No linked merged default-branch PR",
  };
}

function validateSnapshot(snapshot, config) {
  const cards = validateGraph(snapshot.cards, config);
  const issues = new Map(snapshot.issues.map((issue) => [issue.id, issue]));
  const projects = new Map(snapshot.projects.map((item) => [item.id, item]));
  distinct(
    snapshot.issues.map((issue) => issue.id),
    "Issue task ID",
  );
  distinct(
    snapshot.projects.map((item) => item.id),
    "Project card ID",
  );
  if (issues.size !== cards.size || projects.size !== cards.size)
    throw new Error("missing or extra Issue/Project card");
  for (const [id, card] of cards) {
    if (!issues.has(id) || !projects.has(id)) throw new Error(`missing Issue/Project card ${id}`);
    validateIssue(card, issues.get(id));
    if (!LABELS.has(projects.get(id).status)) throw new Error(`unknown Project Status for ${id}`);
  }
  return { cards, issues, projects };
}

function reservations(card) {
  return new Set([...card.files, ...card.sharedFiles]);
}

function lockBlockers(card, active) {
  const files = reservations(card);
  return active
    .filter(
      (other) => other.id !== card.id && [...reservations(other)].some((file) => files.has(file)),
    )
    .map((other) => `file lock conflict with ${other.id}`);
}

function dependencyBlockers(card, complete, gates) {
  return card.dependsOn
    .filter((id) => !(complete.get(id) || gates[id]?.verified === true))
    .map((id) => `dependency ${id} incomplete`);
}

function planEntry(card, issue, projectItem, before, complete, active, snapshot) {
  const blockers = dependencyBlockers(card, complete, snapshot.externalGates);
  blockers.push(...lockBlockers(card, active));
  if (issue.assignees.length > 1) blockers.push("multiple owners");
  if (issue.assignees.length === 1 && !["In progress", "In review"].includes(before))
    blockers.push("existing owner");
  const integrationBlockers = dependencyBlockers(
    { dependsOn: card.integrationDependsOn },
    complete,
    snapshot.externalGates,
  );
  const verified = complete.get(card.id) === true;
  let after = before;
  if (verified) after = "Done";
  else if (["Backlog", "Ready"].includes(before)) after = blockers.length ? "Backlog" : "Ready";
  return {
    id: card.id,
    issueNumber: issue.number,
    itemId: projectItem.itemId,
    before,
    after,
    projectBefore: projectItem.status,
    blockers,
    integrationBlockers,
    completionVerified: verified,
    assigneeCount: issue.assignees.length,
    labelsBefore: issue.labels,
    labelAfter: after === "Done" ? null : LABELS.get(after),
  };
}

export function planReconciliation(snapshot, config) {
  const { cards, issues, projects } = validateSnapshot(snapshot, config);
  const complete = new Map(
    snapshot.issues.map((issue) => [
      issue.id,
      completionEvidence(issue, snapshot.prs, config).complete,
    ]),
  );
  const before = new Map([...cards].map(([id, card]) => [id, validateIssue(card, issues.get(id))]));
  const active = [...cards.values()].filter(
    (card) => ["In progress", "In review"].includes(before.get(card.id)) && !complete.get(card.id),
  );
  const entries = [...cards.values()].map((card) =>
    planEntry(
      card,
      issues.get(card.id),
      projects.get(card.id),
      before.get(card.id),
      complete,
      active,
      snapshot,
    ),
  );
  return {
    entries,
    changed: entries.filter(
      (entry) => entry.before !== entry.after || entry.projectBefore !== entry.after,
    ),
  };
}

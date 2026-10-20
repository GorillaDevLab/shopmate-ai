import { completionEvidence, planReconciliation } from "./policy.mjs";

const STATES = new Map([
  ["agile:backlog", "Backlog"],
  ["agile:ready", "Ready"],
  ["agile:in-progress", "In progress"],
  ["agile:in-review", "In review"],
  ["agile:done", "Done"],
]);
const STATUS_NAMES = ["Backlog", "Ready", "In progress", "In review", "Done"];

function syntheticProject(issues) {
  return {
    projectId: null,
    fieldId: null,
    optionsByName: {},
    items: issues.map((issue) => ({
      number: issue.number,
      itemId: null,
      status:
        issue.labels.map((label) => STATES.get(label)).find(Boolean) ??
        (issue.state === "CLOSED" ? "Done" : null),
    })),
  };
}

function validateProject(project) {
  if (!project.projectId || !project.fieldId) throw new Error("Project configuration missing");
  for (const name of STATUS_NAMES) {
    if (!project.optionsByName[name]) throw new Error(`Project Status option ${name} missing`);
  }
  if (new Set(STATUS_NAMES.map((name) => project.optionsByName[name])).size !== STATUS_NAMES.length)
    throw new Error("Project Status option IDs ambiguous");
  for (const item of project.items) {
    if (item.status && project.optionsByName[item.status] !== item.optionId)
      throw new Error(`Project item ${item.number} Status option ID mismatch`);
  }
}

function attachProjectIds(issues, project) {
  const byNumber = new Map(issues.map((issue) => [issue.number, issue.id]));
  return project.items
    .map((item) => ({ ...item, id: byNumber.get(item.number) ?? null }))
    .filter((item) => item.id !== null);
}

async function loadPullEvidence(api, issues, defaultBranch) {
  const prs = [];
  const checksBySha = new Map();
  for (const issue of issues.filter(
    (item) => item.state === "CLOSED" && item.stateReason === "COMPLETED",
  )) {
    const candidates = await api.readIssuePrs(issue.number);
    for (const candidate of candidates) {
      const checks =
        candidate.mergedAt && candidate.baseRefName === defaultBranch
          ? await cachedChecks(api, checksBySha, candidate.headRefOid)
          : [];
      prs.push({
        ...candidate,
        closingIssueIds: candidate.closingIssueNumbers
          .filter((number) => number === issue.number)
          .map(() => issue.id),
        checks,
      });
    }
  }
  return prs;
}

async function cachedChecks(api, cache, sha) {
  if (!cache.has(sha)) cache.set(sha, await api.readChecks(sha));
  return cache.get(sha);
}

export async function verifyExternalGates(api, config) {
  const results = {};
  const allowed = new Set(config.externalGateIds ?? []);
  for (const [id, source] of Object.entries(config.externalGateSources ?? {})) {
    if (
      !allowed.has(id) ||
      source.repository !== api.fullName ||
      !Number.isSafeInteger(source.issueNumber) ||
      source.issueNumber < 1 ||
      !source.expectedTitle
    )
      throw new Error(`external gate ${id} mapping identity invalid`);
    const issue = await api.readExternalIssue(source.issueNumber, id);
    if (issue.title !== source.expectedTitle)
      throw new Error(`external gate ${id} identity mismatch`);
    const candidates = await api.readIssuePrs(source.issueNumber);
    const prs = [];
    for (const candidate of candidates) {
      const checks =
        candidate.mergedAt && candidate.baseRefName === config.defaultBranch
          ? await api.readChecks(candidate.headRefOid)
          : [];
      prs.push({
        ...candidate,
        checks,
        closingIssueIds: candidate.closingIssueNumbers
          .filter((number) => number === source.issueNumber)
          .map(() => id),
      });
    }
    const evidence = completionEvidence(issue, prs, config);
    results[id] = { verified: evidence.complete, reason: evidence.reason ?? null };
  }
  return results;
}

async function loadSnapshot(api, cards, config, labelsOnly) {
  const repo = await api.readRepo();
  if (repo.defaultBranch !== config.defaultBranch) throw new Error("default branch changed");
  const issues = await api.readIssues();
  const project = labelsOnly ? syntheticProject(issues) : await api.readProject();
  if (!labelsOnly) validateProject(project);
  const prs = await loadPullEvidence(api, issues, repo.defaultBranch);
  const externalGates = await verifyExternalGates(api, config);
  return {
    snapshot: { cards, issues, projects: attachProjectIds(issues, project), prs, externalGates },
    project,
  };
}

function publicPlan(plan, mode, phase) {
  return {
    phase,
    mode,
    generatedAt: new Date().toISOString(),
    entries: plan.entries.map((entry) => ({
      id: entry.id,
      issueNumber: entry.issueNumber,
      itemId: entry.itemId,
      before: entry.before,
      projectBefore: entry.projectBefore,
      labelsBefore: entry.labelsBefore,
      after: entry.after,
      blockers: entry.blockers,
      integrationBlockers: entry.integrationBlockers,
      completionVerified: entry.completionVerified,
    })),
    changedIds: plan.changed.map((entry) => entry.id),
  };
}

function desiredLabels(issue, target) {
  const existing = issue.labels.filter((label) => !STATES.has(label));
  return target.labelAfter ? [...existing, target.labelAfter] : existing;
}

function sameLabels(left, right) {
  return left.length === right.length && left.every((label) => right.includes(label));
}

async function freshTarget(api, cards, config, labelsOnly, original) {
  const { snapshot, project } = await loadSnapshot(api, cards, config, labelsOnly);
  const plan = planReconciliation(snapshot, config);
  const target = plan.entries.find((entry) => entry.id === original.id);
  if (
    !target ||
    target.after !== original.after ||
    target.issueNumber !== original.issueNumber ||
    target.itemId !== original.itemId
  )
    throw new Error(`concurrent eligibility change for ${original.id}`);
  return { target, issue: snapshot.issues.find((item) => item.id === original.id), project };
}

async function writeIssue(api, fresh) {
  const direct = await api.readIssue(fresh.issue.number);
  if (JSON.stringify(direct) !== JSON.stringify(fresh.issue))
    throw new Error("concurrent Issue change");
  const labels = desiredLabels(direct, fresh.target);
  if (sameLabels(direct.labels, labels)) return false;
  await api.updateIssueLabels(direct.number, labels);
  return true;
}

async function writeProject(api, fresh) {
  if (fresh.target.projectBefore === fresh.target.after) return false;
  const direct = await api.readProjectItem(fresh.target.itemId);
  if (
    direct.projectId !== fresh.project.projectId ||
    direct.number !== fresh.target.issueNumber ||
    direct.status !== fresh.target.projectBefore ||
    direct.optionId !== fresh.project.optionsByName[direct.status]
  )
    throw new Error("concurrent Project change");
  await api.updateStatus(
    fresh.project.projectId,
    fresh.target.itemId,
    fresh.project.fieldId,
    fresh.project.optionsByName[fresh.target.after],
  );
  return true;
}

async function attemptChange(context, original) {
  const { api, cards, config, labelsOnly } = context;
  const partialWrite = { id: original.id, issueLabels: false, projectStatus: false };
  try {
    const fresh = await freshTarget(api, cards, config, labelsOnly, original);
    partialWrite.issueLabels = await writeIssue(api, fresh);
    if (!labelsOnly) {
      const verified = await freshTarget(api, cards, config, false, original);
      partialWrite.projectStatus = await writeProject(api, verified);
    }
    return { partialWrite };
  } catch (error) {
    return { partialWrite, error };
  }
}

async function applyPlan(context, plan, report) {
  const appliedIds = [];
  for (const original of plan.changed) {
    const { partialWrite, error } = await attemptChange(context, original);
    if (!error) {
      appliedIds.push(original.id);
      continue;
    }
    const status =
      appliedIds.length ||
      partialWrite.issueLabels ||
      partialWrite.projectStatus ||
      error.message.includes("HTTP") ||
      error.message.includes("GraphQL")
        ? "partial-failure"
        : "conflict";
    await context.persist({
      ...report,
      phase: status,
      appliedIds,
      failedId: original.id,
      partialWrite,
      reason: error.message,
    });
    return { status, plan, appliedIds, failedId: original.id, partialWrite };
  }
  const status = context.labelsOnly ? "project-incomplete" : "applied";
  await context.persist({ ...report, phase: status, appliedIds });
  return { status, plan, appliedIds };
}

export async function reconcile(context) {
  const { api, cards, config, apply = false, labelsOnly = false, persist } = context;
  let loaded;
  try {
    loaded = await loadSnapshot(api, cards, config, labelsOnly);
  } catch (error) {
    if (error.message.includes("Project setup required"))
      return { status: "setup-required", reason: error.message };
    throw error;
  }
  const plan = planReconciliation(loaded.snapshot, config);
  const mode = labelsOnly ? "labels-only; Project incomplete" : "full";
  const report = publicPlan(plan, mode, "before-write");
  if (persist) await persist(report);
  if (!apply) return { status: labelsOnly ? "project-incomplete" : "dry-run", plan };
  if (!persist) throw new Error("persistent before-state report required for apply");
  return applyPlan({ ...context, labelsOnly }, plan, report);
}

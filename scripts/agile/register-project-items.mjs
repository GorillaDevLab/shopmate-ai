import { createHash } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { createHttp } from "./http.mjs";
import { createProjectApi } from "./github-project.mjs";

const repo = "GorillaDevLab/shopmate-ai";
const owner = "hannnnnnnny";
const reportKeys =
  "kind run attempt apply status step partialWrite failedId appliedIds historicalAppliedIds receipts planned pendingId digest continuityEstablished";
const rowSteps = new Set([
  "preflight",
  "read",
  "add-requested",
  "add-acknowledged",
  "add-readback",
  "status-requested",
  "status-readback",
  "verified-backlog",
]);
const phaseSteps = new Set(["manifest", "restore", "project-identity", "complete"]);

class RegistrationError extends Error {}

function check(ok, message) {
  if (!ok) throw new RegistrationError(message);
}

function shape(obj, keys) {
  return (
    obj &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    Object.keys(obj).sort().join("|") === keys.split(" ").sort().join("|")
  );
}

const nodeId = (v) => typeof v === "string" && /^[A-Za-z0-9_=-]{1,160}$/.test(v);

function validRow(r) {
  return (
    shape(r, "id number nodeId title") &&
    typeof r.id === "string" &&
    /^(P03-0(19|2\d|3[0-6])|P04-0(3[3-9]|4[0-4]))$/.test(r.id) &&
    Number.isSafeInteger(r.number) &&
    r.number > 0 &&
    nodeId(r.nodeId) &&
    typeof r.title === "string" &&
    /^Prerequisite draft: [^\p{Cc}]{1,180}$/u.test(r.title)
  );
}

export function validate(m) {
  check(
    shape(m, "version repository projectNumber projectId entries") &&
      m.version === 1 &&
      m.repository === repo &&
      m.projectNumber === 1 &&
      nodeId(m.projectId),
    "manifest identity",
  );
  check(
    Array.isArray(m.entries) &&
      m.entries.length >= 1 &&
      m.entries.length <= 30 &&
      m.entries.every(validRow),
    "manifest entries",
  );
  for (const k of ["id", "number", "nodeId", "title"]) {
    check(new Set(m.entries.map((r) => r[k])).size === m.entries.length, "duplicate entry");
  }
  return m;
}

async function itemFor(x, r) {
  const i = await x.api.readStagedIssue(r.nodeId);
  check(
    i.id === r.nodeId &&
      i.number === r.number &&
      i.title === r.title &&
      i.state === "OPEN" &&
      i.repository?.nameWithOwner === repo &&
      i.assignees?.totalCount === 1 &&
      i.assignees.nodes?.length === 1 &&
      i.assignees.nodes[0]?.login === owner,
    "staged identity changed",
  );
  check(
    Array.isArray(i.labels?.nodes) &&
      i.labels.totalCount === i.labels.nodes.length &&
      i.labels.nodes.every((l) => typeof l?.name === "string" && !/^agile[-:]/.test(l.name)),
    "staged labels changed",
  );
  const matches = i.items.filter((it) => it.project?.id === x.m.projectId);
  check(
    matches.length <= 1 &&
      (!matches.length || (matches[0].isArchived === false && nodeId(matches[0].id))),
    "ambiguous item",
  );
  return matches[0] ?? null;
}

function state(x, r, item) {
  const receipt = x.report.receipts[r.id];
  const completed =
    x.report.appliedIds.includes(r.id) || x.report.historicalAppliedIds.includes(r.id);
  if (receipt) check(item?.id === receipt, "acknowledged item changed");
  check(item || !completed, "completed item missing");
  if (!item) return "missing";
  const status = item.fieldValueByName;
  if (status?.name === "Backlog" && status.optionId === x.backlog) return "ready";
  check(
    status === null && receipt === item.id && x.report.pendingId === r.id && !completed,
    "existing status protected",
  );
  return "blank";
}

async function step(x, r, name, partialWrite) {
  if (partialWrite) x.report.pendingId = r.id;
  if (name === "verified-backlog" && x.report.pendingId === r.id) x.report.pendingId = null;
  Object.assign(x.report, {
    failedId: r.id,
    step: name,
    partialWrite: x.report.pendingId !== null,
  });
  await x.save(x.report);
}

async function phase(x, name) {
  Object.assign(x.report, {
    failedId: null,
    step: name,
    partialWrite: x.report.pendingId !== null,
  });
  await x.save(x.report);
}

async function one(x, r) {
  await step(x, r, "read", false);
  let item = await itemFor(x, r),
    stage = state(x, r, item);
  if (!x.apply) return;
  if (stage === "missing") {
    await step(x, r, "add-requested", true);
    const id = await x.api.addItem(x.m.projectId, r.nodeId);
    check(nodeId(id), "add acknowledgement missing");
    x.report.receipts[r.id] = id;
    await step(x, r, "add-acknowledged", true);
    await step(x, r, "add-readback", true);
    item = await itemFor(x, r);
    stage = state(x, r, item);
  }
  if (stage === "blank") {
    await step(x, r, "status-requested", true);
    await x.api.updateStatus(x.m.projectId, item.id, x.field, x.backlog);
    await step(x, r, "status-readback", true);
    check(state(x, r, await itemFor(x, r)) === "ready", "status readback failed");
  }
  if (!x.report.appliedIds.includes(r.id)) x.report.appliedIds.push(r.id);
  await step(x, r, "verified-backlog", false);
}

export async function register(x) {
  validate(x.m);
  check(!x.apply || x.report.continuityEstablished === true, "registration continuity unavailable");
  await phase(x, "project-identity");
  const p = destination(await x.api.readProject());
  check(p.projectId === x.m.projectId, "project identity");
  x.field = p.fieldId;
  x.backlog = p.backlogOptionId;
  for (const r of x.m.entries) {
    await step(x, r, "preflight", false);
    x.report.planned[r.id] = state(x, r, await itemFor(x, r));
  }
  for (const r of x.m.entries) await one(x, r);
  Object.assign(x.report, {
    status: x.apply ? "registered" : "preview",
    failedId: null,
    step: "complete",
    partialWrite: false,
  });
  await x.save(x.report);
}
const manifestPath = new URL(
  "../../docs/engineering/observed-prerequisite-registration.json",
  import.meta.url,
);

async function persist(path, value) {
  await writeFile(path + ".tmp", JSON.stringify(value), { mode: 0o600 });
  await rename(path + ".tmp", path);
}

function trusted(e) {
  check(
    e.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      e.GITHUB_REPOSITORY === repo &&
      e.GITHUB_REF === "refs/heads/main" &&
      e.GITHUB_WORKFLOW_REF === `${repo}/.github/workflows/agile-state-sync.yml@refs/heads/main` &&
      /^\d+$/.test(e.GITHUB_RUN_ID) &&
      /^[1-9]\d*$/.test(e.GITHUB_RUN_ATTEMPT) &&
      ["true", "false"].includes(e.REGISTRATION_APPLY),
    "untrusted registration mode",
  );
}

function envelope(prior, report) {
  const reasonKey = prior && Object.hasOwn(prior, "reason") ? " reason" : "";
  check(shape(prior, reportKeys + reasonKey), "invalid checkpoint shape");
  check(prior.continuityEstablished === true, "checkpoint continuity unavailable");
  check(
    prior.kind === "staged-registration-v1" &&
      prior.kind === report.kind &&
      prior.apply === true &&
      report.apply === true &&
      /^[a-f0-9]{64}$/.test(prior.digest) &&
      prior.digest === report.digest &&
      typeof prior.run === "string" &&
      /^\d+$/.test(prior.run) &&
      prior.run === report.run &&
      Number.isSafeInteger(prior.attempt) &&
      prior.attempt >= 1 &&
      Number.isSafeInteger(report.attempt) &&
      prior.attempt === report.attempt - 1,
    "untrusted resume report",
  );
  check(["started", "failed", "registered"].includes(prior.status), "invalid checkpoint status");
  check(
    !reasonKey ||
      (typeof prior.reason === "string" &&
        prior.reason.length <= 256 &&
        !/\p{Cc}/u.test(prior.reason)),
    "invalid checkpoint reason",
  );
}

function entryIds(values, m) {
  check(
    Array.isArray(values) &&
      new Set(values).size === values.length &&
      values.every((id) => m.entries.some((r) => r.id === id)),
    "invalid completion evidence",
  );
  return Object.freeze([...values]);
}

function entryMap(value, m, valid) {
  check(value && typeof value === "object" && !Array.isArray(value), "invalid checkpoint map");
  const entries = Object.entries(value);
  check(
    entries.every(([id, item]) => m.entries.some((r) => r.id === id) && valid(item)),
    "invalid add receipt or plan",
  );
  return Object.freeze(Object.fromEntries(entries));
}

function checkpointPhase(prior, m, receipts) {
  check(rowSteps.has(prior.step) || phaseSteps.has(prior.step), "invalid checkpoint step");
  const row = m.entries.some((r) => r.id === prior.failedId);
  check(rowSteps.has(prior.step) ? row : prior.failedId === null, "invalid checkpoint failure ID");
  if (
    ["add-acknowledged", "add-readback", "status-requested", "status-readback"].includes(prior.step)
  ) {
    check(
      prior.failedId === prior.pendingId && nodeId(receipts[prior.pendingId]),
      "invalid pending receipt",
    );
  }
  if (prior.step === "verified-backlog")
    check(prior.appliedIds.includes(prior.failedId), "invalid verified completion");
  if (prior.step === "complete" || prior.status === "registered") {
    check(
      prior.step === "complete" &&
        prior.pendingId === null &&
        prior.appliedIds.length === m.entries.length,
      "invalid completed checkpoint",
    );
  }
}

function recoveredEvidence(prior, m) {
  const completed = new Set([
    ...entryIds(prior.historicalAppliedIds, m),
    ...entryIds(prior.appliedIds, m),
  ]);
  const receipts = entryMap(prior.receipts, m, nodeId);
  entryMap(prior.planned, m, (value) => ["missing", "ready", "blank"].includes(value));
  check(
    (prior.pendingId === null || m.entries.some((r) => r.id === prior.pendingId)) &&
      !completed.has(prior.pendingId) &&
      prior.partialWrite === (prior.pendingId !== null),
    "invalid pending entry",
  );
  check(
    new Set(Object.values(receipts)).size === Object.keys(receipts).length &&
      Object.keys(receipts).every((id) => completed.has(id) || id === prior.pendingId),
    "invalid receipt ownership",
  );
  checkpointPhase(prior, m, receipts);
  return Object.freeze({
    continuityEstablished: true,
    pendingId: prior.pendingId,
    partialWrite: prior.pendingId !== null,
    receipts,
    historicalAppliedIds: Object.freeze([...completed]),
  });
}

export function restore(prior, m, report) {
  validate(m);
  envelope(prior, report);
  const recovered = recoveredEvidence(prior, m);
  Object.assign(report, {
    ...recovered,
    receipts: { ...recovered.receipts },
    historicalAppliedIds: [...recovered.historicalAppliedIds],
  });
}

async function resume(e, m, report, path) {
  if (!report.apply) return;
  if (+e.GITHUB_RUN_ATTEMPT === 1) {
    // Only the first attempt has no predecessor history to establish.
    report.continuityEstablished = true;
    return;
  }
  report.step = "restore";
  await persist(path, report);
  const bytes = await readFile(join(e.RUNNER_TEMP, "r1-resume", "agile-state-plan.json"));
  check(bytes.length <= 32768, "checkpoint size");
  restore(JSON.parse(bytes), m, report);
}

function destination(p) {
  check(
    nodeId(p.projectId) && nodeId(p.fieldId) && nodeId(p.optionsByName?.Backlog),
    "project identity",
  );
  return {
    repository: repo,
    projectNumber: 1,
    projectId: p.projectId,
    fieldId: p.fieldId,
    backlogOptionId: p.optionsByName.Backlog,
  };
}

async function reviewedManifest(report) {
  let bytes;
  try {
    bytes = await readFile(manifestPath);
  } catch (error) {
    // Only the absent allowlist permits a read-only bootstrap identity report.
    if (!report.apply && error.code === "ENOENT") return null;
    throw error;
  }
  check(bytes.length <= 32768, "manifest size");
  report.digest = createHash("sha256").update(bytes).digest("hex");
  return validate(JSON.parse(bytes));
}

async function setupPreview(e, report, path) {
  report.step = "project-identity";
  await persist(path, report);
  report.destination = destination(await projectApi(e).readProject());
  Object.assign(report, { status: "setup-required", step: "manifest-required" });
  await persist(path, report);
}

function newReport(e) {
  return {
    kind: "staged-registration-v1",
    run: e.GITHUB_RUN_ID,
    attempt: +e.GITHUB_RUN_ATTEMPT,
    apply: e.REGISTRATION_APPLY === "true",
    status: "started",
    step: "manifest",
    partialWrite: false,
    failedId: null,
    appliedIds: [],
    historicalAppliedIds: [],
    receipts: {},
    planned: {},
    pendingId: null,
    continuityEstablished: false,
  };
}

function projectApi(e) {
  return createProjectApi(createHttp(globalThis.fetch, e.PROJECT_TOKEN), "GorillaDevLab", 1, repo);
}

async function main(e) {
  trusted(e);
  const path = join(e.RUNNER_TEMP, "agile-state-plan.json");
  const report = newReport(e);
  try {
    await persist(path, report);
    const m = await reviewedManifest(report);
    if (!m) return await setupPreview(e, report, path);
    await resume(e, m, report, path);
    report.step = "project-identity";
    const api = projectApi(e);
    await register({ api, m, apply: report.apply, report, save: (r) => persist(path, r) });
  } catch (error) {
    report.reason =
      error instanceof RegistrationError
        ? error.message
        : "authority, API, file or checkpoint unavailable";
    report.status = "failed";
    await persist(path, report);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.env).catch(() => {
    process.stderr.write("Registration failed before checkpoint\n");
    process.exitCode = 1;
  });
}

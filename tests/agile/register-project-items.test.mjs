/* global structuredClone */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { URL, pathToFileURL } from "node:url";
import { register, restore, validate } from "../../scripts/agile/register-project-items.mjs";
import { createProjectApi } from "../../scripts/agile/github-project.mjs";

const row = { id: "P03-019", number: 700, nodeId: "I_test", title: "Prerequisite draft: Finance" };
const manifest = {
  version: 1,
  repository: "GorillaDevLab/shopmate-ai",
  projectNumber: 1,
  projectId: "PVT_test",
  entries: [row],
};

test("manifest is closed, unique and scoped", () => {
  assert.equal(validate(manifest), manifest);
  for (const bad of [
    { entries: [row, row] },
    { projectNumber: 2 },
    { apply: true },
    { entries: [{ ...row, id: "P04-032" }] },
    { entries: [{ ...row, title: "[P03-019] live" }] },
  ]) {
    assert.throws(() => validate({ ...manifest, ...bad }));
  }
});

function stagedIssue() {
  return {
    id: row.nodeId,
    number: row.number,
    title: row.title,
    state: "OPEN",
    repository: { nameWithOwner: manifest.repository },
    assignees: { totalCount: 1, nodes: [{ login: "hannnnnnnny" }] },
    labels: { totalCount: 0, nodes: [] },
    items: [],
  };
}

function fixture() {
  const issue = stagedIssue();
  const item = {
    id: "PVTI_new",
    isArchived: false,
    project: { id: manifest.projectId },
    fieldValueByName: null,
  };
  const api = {
    readProject: async () => ({
      projectId: manifest.projectId,
      fieldId: "field",
      optionsByName: { Backlog: "back" },
    }),
    readStagedIssue: async () => structuredClone(issue),
    addItem: async () => {
      issue.items.push(item);
      return item.id;
    },
    updateStatus: async () => {
      item.fieldValueByName = { name: "Backlog", optionId: "back" };
    },
  };
  const input = {
    api,
    m: manifest,
    apply: true,
    report: {
      appliedIds: [],
      historicalAppliedIds: [],
      continuityEstablished: true,
      receipts: {},
      planned: {},
      pendingId: null,
    },
    save: async () => {},
  };
  return { issue, item, api, input };
}

function checkpoint(attempt, extra = {}) {
  return {
    kind: "staged-registration-v1",
    apply: true,
    digest: "a".repeat(64),
    run: "10",
    attempt,
    status: "started",
    step: "manifest",
    partialWrite: false,
    failedId: null,
    appliedIds: [],
    historicalAppliedIds: [],
    continuityEstablished: attempt === 1,
    receipts: {},
    planned: {},
    pendingId: null,
    ...extra,
  };
}

function twoRows() {
  const a = fixture(),
    b = fixture();
  const second = {
    ...row,
    id: "P03-020",
    number: 701,
    nodeId: "I_second",
    title: "Prerequisite draft: Traffic",
  };
  Object.assign(b.issue, { id: second.nodeId, number: second.number, title: second.title });
  b.item.id = "PVTI_second";
  const api = {
    ...a.api,
    readStagedIssue: async (id) => structuredClone(id === row.nodeId ? a.issue : b.issue),
    addItem: async (_project, id) => (id === row.nodeId ? a.api : b.api).addItem(),
    updateStatus: async (_project, id) => {
      if (id === b.item.id) throw Error("second status failed");
      await a.api.updateStatus();
    },
  };
  const input = {
    ...a.input,
    api,
    m: { ...manifest, entries: [row, second] },
    report: checkpoint(1),
  };
  return { a, b, second, input };
}

test("completed add receipts cannot reinitialize an operator-cleared Status", async () => {
  const f = fixture();
  await register(f.input);
  f.item.fieldValueByName = null;
  let writes = 0;
  f.api.updateStatus = async () => {
    writes++;
  };
  await assert.rejects(register(f.input), /protected/);
  assert.equal(writes, 0);
});

test("a completed A stays protected when pending B is retried from the prior artifact", async () => {
  const f = twoRows();
  await assert.rejects(register(f.input), /second status failed/);
  assert.deepEqual(f.input.report.appliedIds, [row.id]);
  assert.equal(f.input.report.pendingId, f.second.id);
  const next = checkpoint(2);
  restore(JSON.parse(JSON.stringify(f.input.report)), f.input.m, next);
  f.input.report = next;
  f.a.item.fieldValueByName = null;
  let writes = 0;
  f.input.api.updateStatus = async () => {
    writes++;
  };
  await assert.rejects(register(f.input), /protected/);
  assert.equal(writes, 0);
  assert.equal(f.a.item.fieldValueByName, null);
});

async function partialBatch(existing) {
  const f = twoRows();
  if (existing) {
    f.a.item.fieldValueByName = { name: "Backlog", optionId: "back" };
    f.a.issue.items = [f.a.item];
  }
  await assert.rejects(register(f.input), /second status failed/);
  return f;
}

test("prior verified progress survives a Project outage and a later preflight failure", async () => {
  for (const existing of [false, true]) {
    const f = await partialBatch(existing),
      next = checkpoint(2);
    if (existing) assert.equal(f.input.report.receipts[row.id], undefined);
    restore(JSON.parse(JSON.stringify(f.input.report)), f.input.m, next);
    assert.deepEqual(next.historicalAppliedIds, [row.id]);
    assert.deepEqual(next.appliedIds, []);
    f.input.report = next;
    f.input.api.readProject = async () => {
      throw Error("Project unavailable");
    };
    await assert.rejects(register(f.input), /unavailable/);
    assert.equal(next.step, "project-identity");
    next.status = "failed";
    const later = checkpoint(3);
    restore(JSON.parse(JSON.stringify(next)), f.input.m, later);
    f.input.report = later;
    f.input.api.readProject = f.a.api.readProject;
    f.a.issue.title = "Prerequisite draft: Operator edit";
    await assert.rejects(register(f.input), /identity/);
    assert.equal(later.step, "preflight");
    assert.deepEqual(later.historicalAppliedIds, [row.id]);
    assert.deepEqual(later.appliedIds, []);
  }
});

test("historical completion is separate from successful fresh readback", async () => {
  const f = await partialBatch(true),
    next = checkpoint(2);
  restore(JSON.parse(JSON.stringify(f.input.report)), f.input.m, next);
  f.input.report = next;
  f.input.api.updateStatus = async () => {
    await f.b.api.updateStatus();
  };
  await register(f.input);
  assert.deepEqual(next.historicalAppliedIds, [row.id]);
  assert.deepEqual(next.appliedIds, [row.id, f.second.id]);
});

test("a previously verified existing item cannot be recreated after an operator removes it", async () => {
  const f = await partialBatch(true),
    next = checkpoint(2);
  restore(JSON.parse(JSON.stringify(f.input.report)), f.input.m, next);
  f.a.issue.items = [];
  f.input.report = next;
  let adds = 0;
  f.input.api.addItem = async () => {
    adds++;
    return f.a.item.id;
  };
  await assert.rejects(register(f.input), /completed item missing/);
  assert.equal(adds, 0);
});

const invalidProgress = [
  { continuityEstablished: false },
  { continuityEstablished: undefined },
  { appliedIds: [row.id, row.id] },
  { appliedIds: ["P04-001"] },
  { historicalAppliedIds: ["P04-001"] },
  { historicalAppliedIds: [row.id, row.id] },
  { historicalAppliedIds: undefined },
  { appliedIds: undefined },
  { pendingId: row.id },
  { partialWrite: false },
  { attempt: 1.5 },
  { digest: "invalid" },
  { receipts: { [row.id]: "PVTI_new", "P03-020": "PVTI_new" } },
  { receipts: { [row.id]: "PVTI_new" } },
  { receipts: { "P03-020": "PVTI_second", "P04-001": "PVTI_other" } },
  { planned: { "P04-001": "missing" } },
  { planned: { [row.id]: "invented" } },
  { failedId: "P04-001" },
  { step: "invented" },
  { status: "registered" },
  { unexpected: true },
];

test("restored progress and pending receipt invariants are validated before any assignment", async () => {
  const f = await partialBatch(false);
  for (const changed of invalidProgress) {
    const next = checkpoint(2),
      before = structuredClone(next);
    assert.throws(() => restore({ ...f.input.report, ...changed }, f.input.m, next));
    assert.deepEqual(next, before);
  }
});

test("acknowledged add survives status failure and retry", async () => {
  const f = fixture(),
    update = f.api.updateStatus;
  f.api.updateStatus = async () => {
    throw Error("transport");
  };
  await assert.rejects(register(f.input));
  assert.equal(f.input.report.receipts[row.id], f.item.id);
  f.api.updateStatus = update;
  await register(f.input);
  await register(f.input);
  assert.equal(f.issue.items.length, 1);
  assert.deepEqual(f.input.report.appliedIds, [row.id]);
});

test("foreign scope, active or unattributed blank items never receive writes", async () => {
  for (const change of [
    (f) => {
      f.issue.repository.nameWithOwner = "elsewhere/repo";
    },
    (f) => {
      f.api.readProject = async () => ({ projectId: "other" });
    },
    (f) => {
      f.issue.items = [f.item];
    },
    (f) => {
      f.issue.items = [f.item, f.item];
    },
    (f) => {
      f.issue.assignees.totalCount = 2;
    },
    (f) => {
      f.item.fieldValueByName = { name: "Ready", optionId: "ready" };
      f.issue.items = [f.item];
    },
  ]) {
    const f = fixture();
    change(f);
    let writes = 0;
    f.api.addItem = f.api.updateStatus = async () => {
      writes++;
    };
    await assert.rejects(register(f.input));
    assert.equal(writes, 0);
  }
});

test("preview and pre-existing Backlog cause no mutations", async () => {
  const f = fixture();
  let writes = 0;
  f.api.addItem = f.api.updateStatus = async () => {
    writes++;
  };
  f.input.apply = false;
  await register(f.input);
  assert.equal(f.input.report.planned[row.id], "missing");
  f.input.apply = true;
  f.item.fieldValueByName = { name: "Backlog", optionId: "back" };
  f.issue.items = [f.item];
  await register(f.input);
  assert.equal(writes, 0);
  assert.deepEqual(f.input.report.receipts, {});
});

test("unacknowledged add cannot authorize a later blank write", async () => {
  const f = fixture();
  f.api.addItem = async () => {
    f.issue.items.push(f.item);
    throw Error("lost acknowledgement");
  };
  await assert.rejects(register(f.input));
  assert.equal(f.input.report.partialWrite, true);
  await assert.rejects(register(f.input), /protected/);
  assert.equal(f.item.fieldValueByName, null);
});

test("restore rejects a changed manifest, different run or unlisted receipt", () => {
  const next = checkpoint(2);
  const prev = checkpoint(1, {
    receipts: { [row.id]: "PVTI_new" },
    pendingId: row.id,
    partialWrite: true,
    step: "status-requested",
    failedId: row.id,
  });
  for (const changed of [
    { digest: "other" },
    { run: "11" },
    { attempt: 0 },
    { receipts: { "P04-001": "PVTI_new" } },
    { apply: false },
    { pendingId: "P04-001" },
    { receipts: { [row.id]: "invalid item" } },
  ]) {
    assert.throws(() => restore({ ...prev, ...changed }, manifest, structuredClone(next)));
  }
  restore(prev, manifest, next);
  assert.equal(next.receipts[row.id], "PVTI_new");
  assert.equal(next.partialWrite, true);
});

test("a rejected trailing receipt cannot escape through a failed artifact into another retry", async () => {
  const f = fixture();
  const prior = checkpoint(1, {
    pendingId: row.id,
    partialWrite: true,
    step: "status-requested",
    failedId: row.id,
    receipts: { [row.id]: f.item.id, "P04-001": "PVTI_invalid" },
  });
  const failed = checkpoint(2);
  assert.throws(() => restore(prior, manifest, failed), /receipt/);
  failed.status = "failed";
  const artifact = JSON.parse(JSON.stringify(failed));
  const next = checkpoint(3);
  assert.throws(() => restore(artifact, manifest, next), /continuity/);
  f.issue.items = [f.item];
  f.input.report = next;
  let writes = 0;
  f.api.updateStatus = async () => {
    writes++;
  };
  await assert.rejects(register(f.input), /continuity/);
  assert.equal(writes, 0);
  assert.deepEqual(artifact.receipts, {});
  assert.equal(artifact.pendingId, null);
});

test("rejected restore leaves the target checkpoint unchanged", () => {
  const next = checkpoint(2),
    before = structuredClone(next);
  const prior = checkpoint(1, {
    pendingId: row.id,
    partialWrite: true,
    step: "status-requested",
    failedId: row.id,
    receipts: { [row.id]: "PVTI_new", "P04-001": "PVTI_invalid" },
  });
  assert.throws(() => restore(prior, manifest, next), /receipt/);
  assert.deepEqual(next, before);
});

test("staged read paginates issue items; add uses only exact node IDs", async () => {
  const calls = [];
  const issue = { id: row.nodeId, projectItems: null };
  const http = {
    graphql: async (query, vars) => {
      calls.push(vars);
      if (query.includes("addProjectV2ItemById"))
        return { addProjectV2ItemById: { item: { id: "PVTI_new" } } };
      const last = vars.after === "next";
      return {
        node: {
          ...issue,
          projectItems: {
            nodes: [{ id: last ? "two" : "one" }],
            totalCount: 2,
            pageInfo: { hasNextPage: !last, endCursor: last ? null : "next" },
          },
        },
      };
    },
  };
  const api = createProjectApi(http, "GorillaDevLab", 1, manifest.repository);
  assert.equal((await api.readStagedIssue(row.nodeId)).items.length, 2);
  assert.equal(await api.addItem(manifest.projectId, row.nodeId), "PVTI_new");
  assert.deepEqual(calls.at(-1), { projectId: manifest.projectId, contentId: row.nodeId });
});

test("preflight validates every staged entry before adding any item", async () => {
  const f = fixture();
  const second = {
    ...row,
    id: "P03-020",
    number: 701,
    nodeId: "I_other",
    title: "Prerequisite draft: Traffic",
  };
  f.input.m = { ...manifest, entries: [row, second] };
  let writes = 0;
  f.api.addItem = async () => {
    writes++;
  };
  await assert.rejects(register(f.input), /identity/);
  assert.equal(writes, 0);
  assert.equal(f.input.report.failedId, second.id);
  assert.equal(f.input.report.step, "preflight");
});

test("the acknowledged add checkpoint precedes status and survives a blocked readback", async () => {
  const f = fixture(),
    checkpoints = [];
  f.input.save = async (r) => {
    checkpoints.push(structuredClone(r));
  };
  f.api.addItem = async () => {
    f.issue.items.push(f.item);
    f.issue.title = "Prerequisite draft: Changed";
    return f.item.id;
  };
  let writes = 0;
  f.api.updateStatus = async () => {
    writes++;
  };
  await assert.rejects(register(f.input), /identity/);
  assert.equal(writes, 0);
  assert.equal(checkpoints.at(-1).step, "add-readback");
  assert.ok(checkpoints.some((r) => r.step === "add-acknowledged"));
  assert.equal(checkpoints.at(-1).receipts[row.id], f.item.id);
  assert.equal(checkpoints.at(-1).partialWrite, true);
});

test("a failed checkpoint stops before the corresponding mutation", async () => {
  const f = fixture();
  f.input.save = async (r) => {
    if (r.step === "add-requested") throw Error("storage");
  };
  let writes = 0;
  f.api.addItem = async () => {
    writes++;
  };
  await assert.rejects(register(f.input), /storage/);
  assert.equal(writes, 0);
  assert.equal(f.input.report.step, "add-requested");
  assert.equal(f.input.report.partialWrite, true);
});

test("status readback conflicts retain precise partial evidence without rollback", async () => {
  const f = fixture();
  f.api.updateStatus = async () => {
    f.item.fieldValueByName = { name: "Ready", optionId: "ready" };
  };
  await assert.rejects(register(f.input), /protected/);
  assert.equal(f.input.report.failedId, row.id);
  assert.equal(f.input.report.step, "status-readback");
  assert.equal(f.input.report.partialWrite, true);
  assert.deepEqual(f.input.report.appliedIds, []);
  assert.equal(f.item.fieldValueByName.name, "Ready");
});

test("staged pagination refuses identity drift, truncated pages and repeated cursors", async () => {
  for (const mode of ["identity", "truncated", "cursor"]) {
    const http = {
      graphql: async (_query, vars) => ({
        node: {
          id: mode === "identity" && vars.after ? "I_changed" : row.nodeId,
          projectItems: {
            nodes: [],
            totalCount: mode === "truncated" ? 1 : 0,
            pageInfo: { hasNextPage: mode !== "truncated", endCursor: "next" },
          },
        },
      }),
    };
    const api = createProjectApi(http, "GorillaDevLab", 1, manifest.repository);
    await assert.rejects(api.readStagedIssue(row.nodeId), /changed|count|cursor/);
  }
});

test("archived items, activation labels and changed receipt identity stay protected", async () => {
  for (const change of [
    (f) => {
      f.item.isArchived = true;
      f.issue.items = [f.item];
    },
    (f) => {
      f.issue.labels = { totalCount: 1, nodes: [{ name: "agile-p3-p13" }] };
    },
    (f) => {
      f.input.report.receipts[row.id] = "PVTI_other";
      f.issue.items = [f.item];
    },
    (f) => {
      f.issue.labels.totalCount = 101;
    },
    (f) => {
      f.issue.assignees.nodes[0].login = "other";
    },
    (f) => {
      f.item.fieldValueByName = { name: "Backlog", optionId: "wrong" };
      f.issue.items = [f.item];
    },
  ]) {
    const f = fixture();
    change(f);
    let writes = 0;
    f.api.addItem = f.api.updateStatus = async () => {
      writes++;
    };
    await assert.rejects(register(f.input));
    assert.equal(writes, 0);
  }
});

function cliEnv(directory, overrides = {}) {
  return {
    ...process.env,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: manifest.repository,
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: `${manifest.repository}/.github/workflows/agile-state-sync.yml@refs/heads/main`,
    GITHUB_RUN_ID: "10",
    GITHUB_RUN_ATTEMPT: "1",
    REGISTRATION_APPLY: "true",
    RUNNER_TEMP: directory,
    PROJECT_TOKEN: "test-must-never-be-logged",
    ...overrides,
  };
}

async function isolatedCli(t) {
  const directory = await mkdtemp(join(tmpdir(), "agile-registration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scripts = join(directory, "scripts", "agile");
  await mkdir(scripts, { recursive: true });
  for (const name of ["register-project-items.mjs", "github-project.mjs", "http.mjs"]) {
    await copyFile(new URL(`../../scripts/agile/${name}`, import.meta.url), join(scripts, name));
  }
  return { directory, script: join(scripts, "register-project-items.mjs") };
}

test("CLI rejects non-main or nonmanual authority before writing a report", async (t) => {
  const { directory, script } = await isolatedCli(t);
  for (const override of [
    { GITHUB_REF: "refs/heads/other" },
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_WORKFLOW_REF: "elsewhere/workflow@refs/heads/main" },
    { REGISTRATION_APPLY: "yes" },
  ]) {
    const result = spawnSync(process.execPath, [script], {
      env: cliEnv(directory, { REGISTRATION_APPLY: "false", ...override }),
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /test-must-never-be-logged/);
    await assert.rejects(readFile(join(directory, "agile-state-plan.json")), { code: "ENOENT" });
  }
});

test("CLI fails closed with bounded evidence when the fixed reviewed manifest is absent", async (t) => {
  const { directory, script } = await isolatedCli(t);
  const result = spawnSync(process.execPath, [script], {
    env: cliEnv(directory),
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  const report = JSON.parse(await readFile(join(directory, "agile-state-plan.json"), "utf8"));
  assert.equal(report.status, "failed");
  assert.equal(report.step, "manifest");
  assert.equal(report.continuityEstablished, false);
  assert.equal(report.partialWrite, false);
  assert.deepEqual(report.receipts, {});
  assert.doesNotMatch(
    JSON.stringify(report) + result.stdout + result.stderr,
    /test-must-never-be-logged/,
  );
});

async function projectCli(t, options = [{ id: "back", name: "Backlog" }]) {
  const fixture = await isolatedCli(t);
  const hook = join(fixture.directory, "mock-project.mjs");
  const calls = join(fixture.directory, "calls.jsonl");
  await writeFile(
    hook,
    `import { appendFileSync } from "node:fs";
globalThis.fetch = async (_url, init) => {
  const call = JSON.parse(init.body);
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify(call) + "\\n");
  if (!call.query.startsWith("query")) throw Error("mutation refused");
  const field = { id: "field", name: "Status", options: ${JSON.stringify(options)} };
  const connection = nodes => ({ nodes, totalCount: nodes.length,
    pageInfo: { hasNextPage: false, endCursor: null } });
  const projectV2 = { id: "PVT_destination", fields: connection([field]), items: connection([]) };
  return new Response(JSON.stringify({ data: { organization: { projectV2 } } }));
};`,
  );
  return { ...fixture, hook, calls };
}

async function runProjectCli(f, overrides = {}) {
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(f.hook).href, f.script], {
    env: cliEnv(f.directory, { REGISTRATION_APPLY: "false", ...overrides }),
    encoding: "utf8",
  });
  const report = JSON.parse(await readFile(join(f.directory, "agile-state-plan.json"), "utf8"));
  return { result, report };
}

async function writeManifest(f, value = manifest) {
  const docs = join(f.directory, "docs", "engineering");
  await mkdir(docs, { recursive: true });
  const bytes = JSON.stringify(value);
  await writeFile(join(docs, "observed-prerequisite-registration.json"), bytes);
  return createHash("sha256").update(bytes).digest("hex");
}

async function firstPartialAttempt() {
  const f = twoRows();
  f.input.api.addItem = async (_project, id) => {
    if (id === f.second.nodeId) throw Error("B add failed");
    return f.a.api.addItem();
  };
  await assert.rejects(register(f.input), /B add failed/);
  f.input.report.status = "failed";
  assert.deepEqual(f.input.report.appliedIds, [row.id]);
  assert.equal(f.b.issue.items.length, 0);
  f.a.issue.items = [];
  return f;
}

async function brokenRestoreArtifact(t, f, mode) {
  const cli = await projectCli(t);
  const digest = await writeManifest(cli, f.input.m);
  f.input.report.digest = digest;
  await writeFile(join(cli.directory, "attempt-1.json"), JSON.stringify(f.input.report));
  const path = join(cli.directory, "r1-resume");
  await mkdir(path);
  if (mode === "read") await mkdir(join(path, "agile-state-plan.json"));
  else await writeFile(join(path, "agile-state-plan.json"), "{");
  const { result, report } = await runProjectCli(cli, {
    REGISTRATION_APPLY: "true",
    GITHUB_RUN_ATTEMPT: "2",
    PROJECT_TOKEN: "",
  });
  assert.equal(result.status, 1);
  assert.equal(report.step, "restore");
  assert.equal(report.continuityEstablished, false);
  assert.equal(report.digest, digest);
  await assert.rejects(readFile(cli.calls), { code: "ENOENT" });
  return JSON.parse(JSON.stringify(report));
}

async function denyThirdAttempt(f, prior) {
  const next = checkpoint(3, { digest: prior.digest });
  let adds = 0,
    statuses = 0;
  f.input.api.addItem = async () => {
    adds++;
    return f.a.item.id;
  };
  f.input.api.updateStatus = async () => {
    statuses++;
  };
  await assert.rejects(async () => {
    restore(prior, f.input.m, next);
    f.input.report = next;
    await register(f.input);
  }, /continuity/);
  assert.equal(adds, 0);
  assert.equal(statuses, 0);
  next.status = "failed";
  next.step = "restore";
  assert.throws(
    () =>
      restore(JSON.parse(JSON.stringify(next)), f.input.m, checkpoint(4, { digest: prior.digest })),
    /continuity/,
  );
}

test("a failed or interrupted restore cannot reset A history on the third attempt", async (t) => {
  for (const mode of ["read", "json", "interrupted"]) {
    const f = await firstPartialAttempt();
    const artifact = await brokenRestoreArtifact(t, f, mode);
    if (mode === "interrupted") artifact.status = "started";
    const prior = JSON.parse(JSON.stringify(artifact));
    await denyThirdAttempt(f, prior);
    assert.equal(prior.continuityEstablished, false);
  }
});

async function credentialFailureAfterRestore(t, f) {
  const cli = await projectCli(t);
  f.input.report.digest = await writeManifest(cli, f.input.m);
  const directory = join(cli.directory, "r1-resume");
  await mkdir(directory);
  await writeFile(join(directory, "agile-state-plan.json"), JSON.stringify(f.input.report));
  const { result, report } = await runProjectCli(cli, {
    REGISTRATION_APPLY: "true",
    GITHUB_RUN_ATTEMPT: "2",
    PROJECT_TOKEN: "",
  });
  assert.equal(result.status, 1);
  assert.equal(report.step, "project-identity");
  assert.equal(report.continuityEstablished, true);
  assert.deepEqual(report.historicalAppliedIds, [row.id]);
  await assert.rejects(readFile(cli.calls), { code: "ENOENT" });
  return JSON.parse(JSON.stringify(report));
}

test("credential construction occurs after full restore and retains legitimate retry history", async (t) => {
  const f = await firstPartialAttempt();
  const artifact = await credentialFailureAfterRestore(t, f);
  const next = checkpoint(3, { digest: artifact.digest });
  restore(artifact, f.input.m, next);
  assert.equal(next.continuityEstablished, true);
  assert.deepEqual(next.historicalAppliedIds, [row.id]);
  f.input.report = next;
  let writes = 0;
  f.input.api.addItem = f.input.api.updateStatus = async () => {
    writes++;
  };
  await assert.rejects(register(f.input), /acknowledged item changed|completed item missing/);
  assert.equal(writes, 0);
});

test("pre-continuity diagnostics are ineligible regardless of their phase", () => {
  for (const step of ["manifest", "restore", "project-identity"]) {
    const prior = checkpoint(2, { step, status: "failed", continuityEstablished: false });
    assert.throws(
      () => restore(JSON.parse(JSON.stringify(prior)), manifest, checkpoint(3)),
      /continuity/,
    );
  }
});

test("CLI identifies a missing resume artifact before any Project request", async (t) => {
  const f = await projectCli(t);
  await writeManifest(f);
  const { result, report } = await runProjectCli(f, {
    REGISTRATION_APPLY: "true",
    GITHUB_RUN_ATTEMPT: "2",
  });
  assert.equal(result.status, 1);
  assert.equal(report.step, "restore");
  assert.deepEqual(report.appliedIds, []);
  assert.deepEqual(report.historicalAppliedIds, []);
  await assert.rejects(readFile(f.calls), { code: "ENOENT" });
});

test("CLI attributes a destination API failure to Project identity instead of manifest", async (t) => {
  const f = await projectCli(t, []);
  await writeManifest(f);
  const { result, report } = await runProjectCli(f, { REGISTRATION_APPLY: "true" });
  assert.equal(result.status, 1);
  assert.equal(report.step, "project-identity");
  assert.deepEqual(report.historicalAppliedIds, []);
  assert.ok((await readFile(f.calls, "utf8")).length > 0);
});

test("bootstrap credential setup failures are attributed to Project identity", async (t) => {
  const f = await projectCli(t);
  const { result, report } = await runProjectCli(f, { PROJECT_TOKEN: "" });
  assert.equal(result.status, 1);
  assert.equal(report.step, "project-identity");
  assert.equal(report.continuityEstablished, false);
  assert.deepEqual(report.receipts, {});
  await assert.rejects(readFile(f.calls), { code: "ENOENT" });
});

test("missing-manifest trusted preview records only the fixed App destination without mutations", async (t) => {
  const f = await projectCli(t);
  const { result, report } = await runProjectCli(f);
  assert.equal(result.status, 0);
  assert.equal(report.status, "setup-required");
  assert.equal(report.step, "manifest-required");
  assert.equal(report.continuityEstablished, false);
  assert.deepEqual(report.destination, {
    repository: manifest.repository,
    projectNumber: 1,
    projectId: "PVT_destination",
    fieldId: "field",
    backlogOptionId: "back",
  });
  assert.equal(report.partialWrite, false);
  assert.deepEqual(report.receipts, {});
  assert.deepEqual(report.appliedIds, []);
  const calls = (await readFile(f.calls, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(calls.length > 0);
  assert.ok(
    calls.every(
      (c) =>
        c.query.startsWith("query") &&
        c.variables.org === "GorillaDevLab" &&
        c.variables.number === 1,
    ),
  );
});

test("missing-manifest apply never reads the App destination", async (t) => {
  const f = await projectCli(t);
  const { result, report } = await runProjectCli(f, { REGISTRATION_APPLY: "true" });
  assert.equal(result.status, 1);
  assert.equal(report.status, "failed");
  assert.equal(report.destination, undefined);
  await assert.rejects(readFile(f.calls), { code: "ENOENT" });
});

test("a malformed reviewed manifest never falls back to destination preview", async (t) => {
  const f = await projectCli(t);
  const docs = join(f.directory, "docs", "engineering");
  await mkdir(docs, { recursive: true });
  await writeFile(join(docs, "observed-prerequisite-registration.json"), "{}");
  const { result, report } = await runProjectCli(f);
  assert.equal(result.status, 1);
  assert.equal(report.status, "failed");
  assert.equal(report.continuityEstablished, false);
  assert.equal(report.destination, undefined);
  await assert.rejects(readFile(f.calls), { code: "ENOENT" });
});

test("destination preview fails closed when the App Project lacks verified Backlog setup", async (t) => {
  const f = await projectCli(t, [{ id: "ready", name: "Ready" }]);
  const { result, report } = await runProjectCli(f);
  assert.equal(result.status, 1);
  assert.equal(report.status, "failed");
  assert.equal(report.destination, undefined);
  assert.equal(report.partialWrite, false);
  assert.deepEqual(report.receipts, {});
  assert.ok((await readFile(f.calls, "utf8")).length > 0);
});

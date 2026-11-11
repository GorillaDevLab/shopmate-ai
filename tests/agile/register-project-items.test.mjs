/* global structuredClone */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { URL } from "node:url";
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
    report: { appliedIds: [], receipts: {}, planned: {}, pendingId: null },
    save: async () => {},
  };
  return { issue, item, api, input };
}

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
  const next = {
    kind: "staged-registration-v1",
    apply: true,
    digest: "hash",
    run: "10",
    attempt: 2,
    receipts: {},
  };
  const prev = { ...next, attempt: 1, receipts: { [row.id]: "PVTI_new" }, pendingId: row.id };
  for (const changed of [
    { digest: "other" },
    { run: "11" },
    { attempt: 0 },
    { receipts: { "P04-001": "PVTI_new" } },
  ]) {
    assert.throws(() => restore({ ...prev, ...changed }, manifest, structuredClone(next)));
  }
  restore(prev, manifest, next);
  assert.equal(next.receipts[row.id], "PVTI_new");
  assert.equal(next.partialWrite, true);
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
  assert.equal(checkpoints.at(-1).step, "add-acknowledged");
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
  assert.equal(f.input.report.step, "status-requested");
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
      env: cliEnv(directory, override),
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
  assert.equal(report.partialWrite, false);
  assert.deepEqual(report.receipts, {});
  assert.doesNotMatch(
    JSON.stringify(report) + result.stdout + result.stderr,
    /test-must-never-be-logged/,
  );
});

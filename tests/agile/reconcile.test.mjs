/* global Response */
import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { reconcile, verifyExternalGates } from "../../scripts/agile/reconcile.mjs";
import { createGitHub } from "../../scripts/agile/github.mjs";

const card = { id: "P03-001", dependsOn: [], integrationDependsOn: [], files: [], sharedFiles: [] };
const body = "## 硬依赖（合并后才可领取）\n- 无\n## 实际接线依赖\n- 无\n## 验收";
const config = { requiredChecks: ["quality"], defaultBranch: "main", externalGateIds: ["P2-GATE"] };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const pageInfo = { hasNextPage: false, endCursor: null };
const fullName = "GorillaDevLab/shopmate-ai";

function projectItem(state) {
  return {
    id: "item-1",
    project: { id: "project-1" },
    content: { number: 1, repository: { nameWithOwner: fullName } },
    fieldValueByName: { name: state.status, optionId: state.optionId ?? state.status },
  };
}

function projectField() {
  return {
    id: "field-1",
    name: "Status",
    options: ["Backlog", "Ready", "In progress", "In review", "Done"].map((name) => ({
      id: name,
      name,
    })),
  };
}

function projectResponse(state, query, variables) {
  if (query.includes("updateProjectV2ItemFieldValue")) {
    state.writes.push("project");
    if (state.projectFailure) return json({ errors: [{ message: "forbidden" }] });
    state.status = variables.optionId;
    return json({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "item-1" } } } });
  }
  if (query.includes("fields(first:100")) {
    return json({
      data: {
        organization: {
          projectV2: {
            id: "project-1",
            fields: { nodes: [projectField()], totalCount: 1, pageInfo },
          },
        },
      },
    });
  }
  if (query.includes("items(first:100"))
    return json({
      data: {
        organization: {
          projectV2: {
            id: "project-1",
            items: {
              nodes: [projectItem(state), ...(state.extraItems ?? [])],
              totalCount: 1 + (state.extraItems?.length ?? 0),
              pageInfo,
            },
          },
        },
      },
    });
  return json({ data: { node: projectItem(state) } });
}

function issueResponse(state, path, init) {
  if (path.endsWith("/issues/1") && init.method === "PATCH") {
    state.writes.push("issue");
    state.labels = JSON.parse(init.body).labels;
    return json({});
  }
  state.issueReads += 1;
  if (state.race && state.issueReads > 1) state.labels = ["agile:in-progress", "phase:p03"];
  const row = {
    number: 1,
    title: "[P03-001] Task",
    body,
    state: "open",
    state_reason: null,
    labels: state.labels.map((name) => ({ name })),
    assignees: (state.assignees ?? []).map((login) => ({ login })),
  };
  return json(path.endsWith("/issues") ? [row] : row);
}

function scenario(options = {}) {
  const state = {
    labels: ["agile:backlog", "phase:p03"],
    status: "Backlog",
    issueReads: 0,
    writes: [],
    ...options,
  };
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/graphql") {
      const { query, variables } = JSON.parse(init.body);
      return projectResponse(state, query, variables);
    }
    if (path.endsWith("/issues") || path.endsWith("/issues/1"))
      return issueResponse(state, path, init);
    return json({ full_name: fullName, default_branch: "main" });
  };
  return { fetch, state };
}

function client(fetch, projectToken = "project-secret") {
  return createGitHub({
    fetch,
    repoToken: "repo-secret",
    projectToken,
    owner: "GorillaDevLab",
    repo: "shopmate-ai",
    org: "GorillaDevLab",
    projectNumber: 1,
  });
}

test("dry run saves a nonsecret plan and performs no writes", async () => {
  const fake = scenario();
  const reports = [];
  const result = await reconcile({
    api: client(fake.fetch),
    cards: [card],
    config,
    persist: (report) => reports.push(report),
  });
  assert.equal(result.status, "dry-run");
  assert.deepEqual(
    result.plan.changed.map((entry) => entry.id),
    ["P03-001"],
  );
  assert.deepEqual(fake.state.writes, []);
  assert.equal(JSON.stringify(reports).includes("repo-secret"), false);
});

test("apply preserves native Project active work and aligns its lagging Issue label", async () => {
  const fake = scenario({
    labels: ["agile:ready", "phase:p03"],
    status: "In progress",
    assignees: ["alice"],
  });
  const result = await reconcile({
    api: client(fake.fetch),
    cards: [card],
    config,
    apply: true,
    persist: async () => {},
  });
  assert.equal(result.status, "applied");
  assert.equal(fake.state.status, "In progress");
  assert.deepEqual(fake.state.writes, ["issue"]);
  assert.deepEqual(fake.state.labels, ["phase:p03", "agile:in-progress"]);
});

test("conflicting active Issue and Project phases abort before writes", async () => {
  const fake = scenario({ labels: ["agile:in-progress"], status: "In review" });
  await assert.rejects(
    reconcile({
      api: client(fake.fetch),
      cards: [card],
      config,
      apply: true,
      persist: async () => {},
    }),
    /ambiguous.*active/i,
  );
  assert.deepEqual(fake.state.writes, []);
});

test("unrelated Project items in the same repository do not enter the pool", async () => {
  const fake = scenario({
    extraItems: [
      {
        ...projectItem({ status: "Ready" }),
        id: "other",
        content: { number: 999, repository: { nameWithOwner: fullName } },
      },
    ],
  });
  const result = await reconcile({ api: client(fake.fetch), cards: [card], config });
  assert.equal(result.status, "dry-run");
});

test("Project item Status option ID must match the named option", async () => {
  const fake = scenario({ optionId: "Done" });
  await assert.rejects(reconcile({ api: client(fake.fetch), cards: [card], config }), /option ID/i);
});

test("apply revalidates, preserves unrelated labels and is idempotent", async () => {
  const fake = scenario();
  const reports = [];
  const args = {
    api: client(fake.fetch),
    cards: [card],
    config,
    apply: true,
    persist: (report) => reports.push(report),
  };
  const first = await reconcile(args);
  assert.equal(first.status, "applied");
  assert.deepEqual(fake.state.writes, ["issue", "project"]);
  assert.deepEqual(fake.state.labels, ["phase:p03", "agile:ready"]);
  assert.equal(fake.state.status, "Ready");
  assert.equal(reports[0].phase, "before-write");
  const second = await reconcile(args);
  assert.equal(second.plan.changed.length, 0);
  assert.deepEqual(fake.state.writes, ["issue", "project"]);
});

test("missing Project credential requires setup unless labels-only is explicit", async () => {
  const fake = scenario();
  const noProject = client(fake.fetch, null);
  const result = await reconcile({ api: noProject, cards: [card], config, apply: true });
  assert.equal(result.status, "setup-required");
  assert.deepEqual(fake.state.writes, []);
  const repair = await reconcile({
    api: noProject,
    cards: [card],
    config,
    apply: true,
    labelsOnly: true,
    persist: async () => {},
  });
  assert.equal(repair.status, "project-incomplete");
  assert.deepEqual(fake.state.writes, ["issue"]);
});

test("concurrent change stops before write; Project failure records partial pair", async () => {
  const racing = scenario({ race: true });
  const conflict = await reconcile({
    api: client(racing.fetch),
    cards: [card],
    config,
    apply: true,
    persist: async () => {},
  });
  assert.equal(conflict.status, "conflict");
  assert.deepEqual(racing.state.writes, []);
  const failing = scenario({ projectFailure: true });
  const partial = await reconcile({
    api: client(failing.fetch),
    cards: [card],
    config,
    apply: true,
    persist: async () => {},
  });
  assert.equal(partial.status, "partial-failure");
  assert.deepEqual(partial.partialWrite, {
    id: "P03-001",
    issueLabels: true,
    projectStatus: false,
  });
  assert.deepEqual(failing.state.writes, ["issue", "project"]);
  assert.equal(failing.state.status, "Backlog");
});

function gateGraph(query) {
  if (query.includes("closedByPullRequestsReferences"))
    return json({
      data: {
        repository: {
          issue: {
            closedByPullRequestsReferences: {
              nodes: [{ number: 481, repository: { nameWithOwner: fullName } }],
              totalCount: 1,
              pageInfo,
            },
          },
        },
      },
    });
  const ref = { number: 900, repository: { nameWithOwner: fullName } };
  return json({
    data: {
      repository: {
        pullRequest: {
          number: 481,
          mergedAt: "2026-10-20",
          baseRefName: "main",
          baseRepository: { nameWithOwner: fullName },
          headRefOid: "a".repeat(40),
          closingIssuesReferences: { nodes: [ref], totalCount: 1, pageInfo },
        },
      },
    },
  });
}

function gateRest(path) {
  if (path.endsWith("/issues/900"))
    return json({
      number: 900,
      title: "P2 acceptance gate",
      state: "closed",
      state_reason: "completed",
    });
  if (path.endsWith("/actions/workflows/ci.yml"))
    return json({ id: 42, path: ".github/workflows/ci.yml" });
  if (path.endsWith("/runs"))
    return json({
      total_count: 1,
      workflow_runs: [
        {
          workflow_id: 42,
          head_sha: "a".repeat(40),
          event: "pull_request",
          conclusion: "success",
          path: ".github/workflows/ci.yml@main",
          check_suite_id: 77,
        },
      ],
    });
  return json({
    total_count: 1,
    check_runs: [
      {
        name: "quality",
        status: "completed",
        conclusion: "success",
        head_sha: "a".repeat(40),
        app: { slug: "github-actions" },
        check_suite: { id: 77 },
      },
    ],
  });
}

test("P2-GATE requires exact title, merged closing PR and trusted CI", async () => {
  const fetch = async (url, init) =>
    new URL(url).pathname === "/graphql"
      ? gateGraph(JSON.parse(init.body).query)
      : gateRest(new URL(url).pathname);
  const mapped = {
    ...config,
    externalGateSources: {
      "P2-GATE": {
        issueNumber: 900,
        expectedTitle: "P2 acceptance gate",
        repository: fullName,
      },
    },
  };
  assert.equal((await verifyExternalGates(client(fetch), mapped))["P2-GATE"].verified, true);
  mapped.externalGateSources["P2-GATE"].expectedTitle = "wrong gate";
  await assert.rejects(verifyExternalGates(client(fetch), mapped), /identity/i);
});

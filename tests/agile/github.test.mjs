/* global Response */
import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { createGitHub } from "../../scripts/agile/github.mjs";

const api = (fetch) =>
  createGitHub({
    fetch,
    repoToken: "repo-secret",
    projectToken: "project-secret",
    owner: "GorillaDevLab",
    repo: "shopmate-ai",
    org: "GorillaDevLab",
    projectNumber: 1,
  });
const json = (body, headers = {}) => new Response(JSON.stringify(body), { status: 200, headers });
const pageInfo = (after) => ({ hasNextPage: !after, endCursor: after ? "last" : "next" });
const fullName = "GorillaDevLab/shopmate-ai";
const sha = "a".repeat(40);

function projectResponse(query, after) {
  const field = {
    id: "field-1",
    name: "Status",
    options: ["Backlog", "Ready", "In progress", "In review", "Done"].map((name) => ({
      id: name,
      name,
    })),
  };
  const item = {
    id: "item-1",
    content: { number: 211, repository: { nameWithOwner: fullName } },
    fieldValueByName: { name: "Ready", optionId: "Ready" },
  };
  const key = query.includes("fields(first:100") ? "fields" : "items";
  return json({
    data: {
      organization: {
        projectV2: {
          id: "project-1",
          [key]: {
            nodes: after ? [key === "fields" ? field : item] : [],
            totalCount: 1,
            pageInfo: pageInfo(after),
          },
        },
      },
    },
  });
}

function prResponse(query, after) {
  if (query.includes("closedByPullRequestsReferences"))
    return json({
      data: {
        repository: {
          issue: {
            closedByPullRequestsReferences: {
              nodes: after ? [{ number: 481 }] : [],
              totalCount: 1,
              pageInfo: pageInfo(after),
            },
          },
        },
      },
    });
  const ref = { number: 211, repository: { nameWithOwner: fullName } };
  return json({
    data: {
      repository: {
        pullRequest: {
          number: 481,
          mergedAt: "2026-10-20T00:00:00Z",
          baseRefName: "main",
          headRefOid: sha,
          baseRepository: { nameWithOwner: fullName },
          closingIssuesReferences: {
            nodes: after ? [ref] : [],
            totalCount: 1,
            pageInfo: pageInfo(after),
          },
        },
      },
    },
  });
}

function ciResponse(url, runs, checks) {
  const path = new URL(url).pathname;
  if (path.endsWith("/actions/workflows/ci.yml"))
    return json({ id: 42, path: ".github/workflows/ci.yml" });
  if (path.endsWith("/runs")) return json({ total_count: runs.length, workflow_runs: runs });
  return json({ total_count: checks.length, check_runs: checks });
}

const run = (conclusion, time, suite = 77) => ({
  workflow_id: 42,
  head_sha: sha,
  event: "pull_request",
  conclusion,
  path: ".github/workflows/ci.yml@main",
  check_suite_id: suite,
  created_at: time,
});
const check = (name, app = "github-actions") => ({
  name,
  status: "completed",
  conclusion: "success",
  head_sha: sha,
  app: { slug: app },
  check_suite: { id: 77 },
});

test("REST Issue pages filter PRs and preserve the repository token boundary", async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url: String(url), authorization: init.headers.Authorization });
    if (String(url).includes("page=2"))
      return json([
        { number: 2, title: "[P03-002] task", state: "open", labels: [], assignees: [], body: "" },
      ]);
    return json(
      [
        { number: 1, title: "[P03-001] task", state: "open", labels: [], assignees: [], body: "" },
        { number: 50, pull_request: {}, title: "PR" },
      ],
      {
        Link: '<https://api.github.com/repos/GorillaDevLab/shopmate-ai/issues?state=all&per_page=100&page=2>; rel="next"',
      },
    );
  };
  assert.deepEqual(
    (await api(fetch).readIssues()).map((item) => item.id),
    ["P03-001", "P03-002"],
  );
  assert.equal(seen.length, 2);
  assert.ok(seen.every((call) => call.authorization === "Bearer repo-secret"));
});

test("REST pagination refuses a repeating next link and redirects", async () => {
  const link =
    '<https://api.github.com/repos/GorillaDevLab/shopmate-ai/issues?state=all&per_page=100&page=1>; rel="next"';
  await assert.rejects(api(async () => json([], { Link: link })).readIssues(), /pagination/i);
  await assert.rejects(
    api(
      async () =>
        new Response("", {
          status: 302,
          headers: {
            location: "https://other.test/",
          },
        }),
    ).readIssues(),
    /redirect/i,
  );
});

test("GraphQL pagination refuses missing cursor and GraphQL errors", async () => {
  const missing = api(async () =>
    json({
      data: {
        organization: {
          projectV2: {
            id: "P1",
            fields: { nodes: [], totalCount: 1, pageInfo: { hasNextPage: true, endCursor: null } },
          },
        },
      },
    }),
  );
  await assert.rejects(missing.readProject(), /cursor/i);
  const failed = api(async () => json({ errors: [{ message: "private data" }] }));
  await assert.rejects(failed.readProject(), /GraphQL/i);
});

test("GraphQL pagination rejects prematurely terminated connections", async () => {
  const fetch = async () =>
    json({
      data: {
        organization: {
          projectV2: {
            id: "P1",
            fields: { nodes: [], totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      },
    });
  await assert.rejects(api(fetch).readProject(), /count/i);
});

test("HTTP errors are bounded and do not echo a token or raw response", async () => {
  const fetch = async () => new Response("repo-secret private content", { status: 403 });
  await assert.rejects(api(fetch).readIssues(), (error) => {
    assert.match(error.message, /403/);
    assert.doesNotMatch(error.message, /secret|private content/);
    return true;
  });
});

test("Project fields and items paginate with only the project token", async () => {
  const seen = [];
  const fetch = async (_url, init) => {
    seen.push(init.headers.Authorization);
    const { query, variables } = JSON.parse(init.body);
    return projectResponse(query, variables.after);
  };
  const project = await api(fetch).readProject();
  assert.equal(project.items[0].status, "Ready");
  assert.equal(project.optionsByName.Done, "Done");
  assert.ok(seen.every((token) => token === "Bearer project-secret"));
});

test("closed Issue references and PR closure references paginate fully", async () => {
  const fetch = async (_url, init) => {
    const { query, variables } = JSON.parse(init.body);
    return prResponse(query, variables.after);
  };
  const prs = await api(fetch).readIssuePrs(211);
  assert.deepEqual(prs[0].closingIssueNumbers, [211]);
  assert.equal(prs[0].number, 481);
});

test("checks require trusted Actions run, suite, app and exact head", async () => {
  const fetch = async (url) =>
    ciResponse(
      url,
      [run("success", "2026-10-20T01:00:00Z")],
      [check("quality"), check("spoof", "other")],
    );
  const checks = await api(fetch).readChecks(sha);
  assert.equal(checks[0].trusted, true);
  assert.equal(checks[1].trusted, false);
  assert.equal(checks[0].headSha, sha);
});

test("newer failed CI run defeats older success at the same head", async () => {
  const runs = [run("failure", "2026-10-20T02:00:00Z", 80), run("success", "2026-10-20T01:00:00Z")];
  const fetch = async (url) => ciResponse(url, runs, [check("quality")]);
  assert.deepEqual(await api(fetch).readChecks(sha), []);
});

test("wrapped REST runs reject missing next page when total_count is larger", async () => {
  const fetch = async (url) => {
    if (new URL(url).pathname.endsWith("/runs"))
      return json({ total_count: 2, workflow_runs: [run("success", "2026-10-20T01:00:00Z")] });
    return ciResponse(url, [], [check("quality")]);
  };
  await assert.rejects(api(fetch).readChecks(sha), /count/i);
});

test("external gate Issue read retains exact title for identity verification", async () => {
  const fetch = async () =>
    json({
      number: 900,
      title: "P2 acceptance gate",
      state: "closed",
      state_reason: "completed",
      labels: [],
      assignees: [],
      body: "",
    });
  const gate = await api(fetch).readExternalIssue(900);
  assert.equal(gate.title, "P2 acceptance gate");
  assert.equal(gate.stateReason, "COMPLETED");
});

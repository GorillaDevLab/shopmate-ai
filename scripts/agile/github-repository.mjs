import { graphPages, restPages } from "./http.mjs";

const PAGE = "totalCount pageInfo { hasNextPage endCursor }";
const ISSUE_PRS = `query($owner:String!,$repo:String!,$number:Int!,$after:String){repository(owner:$owner,name:$repo){issue(number:$number){closedByPullRequestsReferences(first:100,after:$after,includeClosedPrs:true){nodes{number repository{nameWithOwner}} ${PAGE}}}}}`;
const CLOSURES = `query($owner:String!,$repo:String!,$number:Int!,$after:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){number mergedAt baseRefName baseRepository{nameWithOwner} headRefOid closingIssuesReferences(first:100,after:$after){nodes{number repository{nameWithOwner}} ${PAGE}}}}}`;

function normalizeIssue(row) {
  const id = /^\[(P\d{2}-\d{3})\]/.exec(row.title ?? "")?.[1];
  if (!id || row.pull_request) return null;
  return {
    id,
    number: row.number,
    body: row.body ?? "",
    state: row.state?.toUpperCase(),
    stateReason: row.state_reason?.toUpperCase() ?? null,
    labels: row.labels?.map((label) => label.name) ?? [],
    assignees: row.assignees?.map((person) => person.login) ?? [],
  };
}

async function readIssues(ctx) {
  const rows = await restPages(ctx.http, `${ctx.base}/issues?state=all&per_page=100&page=1`);
  return rows.map(normalizeIssue).filter(Boolean);
}

async function readIssue(ctx, number) {
  const { data } = await ctx.http.request(`${ctx.base}/issues/${number}`);
  const issue = normalizeIssue(data);
  if (!issue) throw new Error(`Issue ${number} is not a task card`);
  return issue;
}

async function readExternalIssue(ctx, number, id) {
  const { data } = await ctx.http.request(`${ctx.base}/issues/${number}`);
  if (data.pull_request || data.number !== number)
    throw new Error("external gate Issue identity mismatch");
  return {
    id,
    number,
    title: data.title,
    state: data.state?.toUpperCase(),
    stateReason: data.state_reason?.toUpperCase() ?? null,
  };
}

async function readIssuePrs(ctx, number) {
  const nodes = await graphPages(async (after) => {
    const data = await ctx.http.graphql(ISSUE_PRS, { ...ctx.variables, number, after });
    return data.repository?.issue?.closedByPullRequestsReferences;
  });
  const prs = [];
  for (const node of nodes) {
    if (!node.repository?.nameWithOwner) throw new Error("PR reference repository missing");
    if (node.repository.nameWithOwner === ctx.fullName)
      prs.push(await readPullRequest(ctx, node.number));
  }
  return prs.filter((pr) => pr.baseRepository === ctx.fullName);
}

async function readPullRequest(ctx, number) {
  const refs = await graphPages(async (after) => {
    const data = await ctx.http.graphql(CLOSURES, { ...ctx.variables, number, after });
    return data.repository?.pullRequest?.closingIssuesReferences;
  });
  const data = await ctx.http.graphql(CLOSURES, { ...ctx.variables, number, after: null });
  const row = data.repository?.pullRequest;
  if (!row) throw new Error(`PR ${number} missing`);
  return {
    number,
    mergedAt: row.mergedAt,
    baseRefName: row.baseRefName,
    baseRepository: row.baseRepository?.nameWithOwner,
    headRefOid: row.headRefOid,
    closingIssueNumbers: refs
      .filter((ref) => ref.repository?.nameWithOwner === ctx.fullName)
      .map((ref) => ref.number),
  };
}

async function readChecks(ctx, sha) {
  const { data: workflow } = await ctx.http.request(`${ctx.base}/actions/workflows/ci.yml`);
  if (workflow.path !== ".github/workflows/ci.yml")
    throw new Error("trusted CI workflow identity changed");
  const runs = await restPages(
    ctx.http,
    `${ctx.base}/actions/workflows/${workflow.id}/runs?head_sha=${sha}&event=pull_request&per_page=100&page=1`,
    "workflow_runs",
  );
  const trusted = runs.filter(
    (run) =>
      run.workflow_id === workflow.id &&
      run.head_sha === sha &&
      run.event === "pull_request" &&
      run.path?.split("@")[0] === workflow.path,
  );
  if (trusted.length > 1 && trusted.some((run) => !run.created_at))
    throw new Error("CI run order unavailable");
  trusted.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  const latest = trusted[0];
  if (!latest || latest.conclusion !== "success") return [];
  const checks = await restPages(
    ctx.http,
    `${ctx.base}/check-suites/${latest.check_suite_id}/check-runs?per_page=100&page=1`,
    "check_runs",
  );
  return checks.map((check) => ({
    name: check.name,
    status: check.status,
    conclusion: check.conclusion,
    headSha: check.head_sha,
    trusted:
      check.app?.slug === "github-actions" && check.check_suite?.id === latest.check_suite_id,
  }));
}

async function readRepo(ctx) {
  const { data } = await ctx.http.request(ctx.base);
  if (data.full_name !== ctx.fullName || !data.default_branch)
    throw new Error("repository identity mismatch");
  return { defaultBranch: data.default_branch };
}

export function createRepositoryApi(http, owner, repo) {
  const ctx = {
    http,
    base: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    fullName: `${owner}/${repo}`,
    variables: { owner, repo },
  };
  return {
    fullName: ctx.fullName,
    readIssues: () => readIssues(ctx),
    readIssue: (number) => readIssue(ctx, number),
    readExternalIssue: (number, id = "P2-GATE") => readExternalIssue(ctx, number, id),
    readIssuePrs: (number) => readIssuePrs(ctx, number),
    readPullRequest: (number) => readPullRequest(ctx, number),
    readChecks: (sha) => readChecks(ctx, sha),
    readRepo: () => readRepo(ctx),
    updateIssueLabels: (number, labels) =>
      ctx.http.request(`${ctx.base}/issues/${number}`, { method: "PATCH", body: { labels } }),
  };
}

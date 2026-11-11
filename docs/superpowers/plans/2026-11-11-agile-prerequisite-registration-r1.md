# R1 Project registration implementation plan

> **For agentic workers:** Use the already selected subagent-driven-development workflow. Steps use checkboxes. Parent owns branch, claim, review and merge.

**Goal:** Add a manual registration mode to the existing Project App workflow for the approved 30 staged prerequisite Issues.

**Architecture:** Read the fixed manifest from trusted main, verify each live Issue and destination, then add its Project item and initialize Backlog. Save an acknowledged add receipt before attempting Status. A retry may reuse only the receipt for that exact item, manifest and workflow run.

**Tech stack:** Node 22 ESM, node:test, existing GitHub App Project client, GitHub Actions and runner-bundled `gh`.

## Global constraints

R1 has a four-hour planning cap. Implementation BASE `5ec217f66aeba5c69cef8fa5682b943eeb8cee82` after normal merge of PR546; approved spec originally `f50bccc`, preserved on its original branch and cherry-picked onto the implementation branch without rewriting history. Intended tracked plan `docs/superpowers/plans/2026-11-11-agile-prerequisite-registration-r1.md`. Keep functions and test callbacks under 40 physical lines. Use existing credentials, workflow permissions, trusted checkout, pinned actions, concurrency group and attempt-scoped artifact. R2 owns the reviewed manifest/catalog/staging Issues, R3 owns activation. Preserve the existing automatic deployment policy.

Own `scripts/agile/register-project-items.mjs` and `tests/agile/register-project-items.test.mjs`. Lock `scripts/agile/github-project.mjs`, `.github/workflows/agile-state-sync.yml`, `tests/agile/workflow.test.mjs`. Existing `sync.mjs`, policy, reconciliation and `http.mjs` are reference-only. All commands below are for future implementation. Each task ends in a separate commit.

## 1. Validate the reviewed manifest

- [ ] RED: start `tests/agile/register-project-items.test.mjs` with this test. `node --test tests/agile/register-project-items.test.mjs` must fail on the missing module.

```js
import assert from "node:assert/strict";
import test from "node:test";
import { validate } from "../../scripts/agile/register-project-items.mjs";
const row = { id: "P03-019", number: 700, nodeId: "I_test", title: "Prerequisite draft: Finance" };
const manifest = { version: 1, repository: "GorillaDevLab/shopmate-ai", projectNumber: 1,
  projectId: "PVT_test", entries: [row] };
test("manifest is closed, unique and scoped", () => {
  assert.equal(validate(manifest), manifest);
  for (const bad of [{ entries: [row, row] }, { projectNumber: 2 }, { apply: true },
    { entries: [{ ...row, id: "P04-032" }] }, { entries: [{ ...row, title: "[P03-019] live" }] }]) {
    assert.throws(() => validate({ ...manifest, ...bad }));
  }
});
```

- [ ] GREEN: create `register-project-items.mjs` with these imports and checks. R2 supplies entries for all staged cards. A reviewed subset permits a bounded batch. An absent file prevents writes.

```js
import { createHash } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createHttp } from "./http.mjs";
import { createProjectApi } from "./github-project.mjs";
const repo = "GorillaDevLab/shopmate-ai";
const owner = "hannnnnnnny";
class RegistrationError extends Error {}
function check(ok, message) { if (!ok) throw new RegistrationError(message); }
function shape(obj, keys) {
  return obj && typeof obj === "object" && !Array.isArray(obj) &&
    Object.keys(obj).sort().join("|") === keys.split(" ").sort().join("|");
}
const nodeId = (v) => typeof v === "string" && /^[A-Za-z0-9_=-]{1,160}$/.test(v);
function validRow(r) {
  return shape(r,"id number nodeId title") && typeof r.id==="string" && /^(P03-0(19|2\d|3[0-6])|P04-0(3[3-9]|4[0-4]))$/.test(r.id) &&
    Number.isSafeInteger(r.number) && r.number > 0 && nodeId(r.nodeId) &&
    typeof r.title === "string" && /^Prerequisite draft: [^\p{Cc}]{1,180}$/u.test(r.title);
}
export function validate(m) {
  check(shape(m,"version repository projectNumber projectId entries") && m.version === 1 &&
    m.repository === repo && m.projectNumber === 1 && nodeId(m.projectId),"manifest identity");
  check(Array.isArray(m.entries) && m.entries.length >= 1 && m.entries.length <= 30 &&
    m.entries.every(validRow),"manifest entries");
  for (const k of ["id","number","nodeId","title"]) {
    check(new Set(m.entries.map((r) => r[k])).size === m.entries.length,"duplicate entry");
  }
  return m;
}
```

- [ ] Run the focused test, expect one pass. Commit `feat(agile): validate the staged registration manifest`.

## 2. Read the live staged identity and expose the existing App's add operation

- [ ] RED: add this transport test to the same test file. Run the focused target and expect missing `readStagedIssue`/`addItem` methods.

```js
import { createProjectApi } from "../../scripts/agile/github-project.mjs";
test("staged read paginates issue items; add uses only exact node IDs", async () => {
  const calls = [];
  const issue = { id: row.nodeId, projectItems: null };
  const http = { graphql: async (query, vars) => {
    calls.push(vars);
    if (query.includes("addProjectV2ItemById")) return { addProjectV2ItemById: { item: { id: "PVTI_new" } } };
    const last = vars.after === "next";
    return { node: { ...issue, projectItems: { nodes: [{ id: last ? "two" : "one" }], totalCount: 2,
      pageInfo: { hasNextPage: !last, endCursor: last ? null : "next" } } } };
  } };
  const api = createProjectApi(http,"GorillaDevLab",1,manifest.repository);
  assert.equal((await api.readStagedIssue(row.nodeId)).items.length,2);
  assert.equal(await api.addItem(manifest.projectId,row.nodeId),"PVTI_new");
  assert.deepEqual(calls.at(-1),{ projectId: manifest.projectId, contentId: row.nodeId });
});
```

- [ ] GREEN: add these declarations to `github-project.mjs`, then add both methods inside `createProjectApi`'s existing return object. Use `graphPages` from its existing import.

```js
const STAGED = `query($id:ID!,$after:String){node(id:$id){... on Issue{id number title state repository{nameWithOwner} assignees(first:2){totalCount nodes{login}} labels(first:100){totalCount nodes{name}} projectItems(first:100,after:$after,includeArchived:true){nodes{id isArchived project{id} fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name optionId}}} ${PAGE}}}}}`;
const ADD = `mutation($projectId:ID!,$contentId:ID!){addProjectV2ItemById(input:{projectId:$projectId,contentId:$contentId}){item{id}}}`;
async function staged(ctx,id) {
  let identity;
  const items = await graphPages(async (after) => {
    const {node} = await client(ctx).graphql(STAGED,{id,after});
    if (!node?.projectItems) throw new Error("staged issue unavailable");
    const { projectItems, ...current } = node;
    if (identity && JSON.stringify(identity) !== JSON.stringify(current)) throw new Error("staged issue changed");
    identity = current;
    return projectItems;
  });
  return { ...identity, items };
}
```

```js
readStagedIssue: (id) => staged(ctx,id),
addItem: async (projectId,contentId) => {
  const data = await client(ctx).graphql(ADD,{projectId,contentId});
  return data.addProjectV2ItemById?.item?.id;
},
```

- [ ] Run focused tests and `node --test tests/agile/github.test.mjs`. Commit `feat(agile): read staged issues and add exact Project items`.

## 3. Implement idempotent registration with mutation evidence

- [ ] RED: import `register` next to `validate`. Add the fixture and tests below. Run the focused target; expect missing `register`.

```js
function fixture() {
  const issue = { id: row.nodeId, number: row.number, title: row.title, state: "OPEN",
    repository:{ nameWithOwner:manifest.repository }, assignees:{ totalCount:1,nodes:[{login:"hannnnnnnny"}] },
    labels:{totalCount:0,nodes:[]},items:[] };
  const item = { id:"PVTI_new",isArchived:false,project:{id:manifest.projectId},fieldValueByName:null };
  const api = { readProject:async()=>({projectId:manifest.projectId,fieldId:"field",optionsByName:{Backlog:"back"}}),
    readStagedIssue:async()=>structuredClone(issue),addItem:async()=>{ issue.items.push(item); return item.id; },
    updateStatus:async()=>{ item.fieldValueByName={name:"Backlog",optionId:"back"}; } };
  const input={api,m:manifest,apply:true,report:{appliedIds:[],receipts:{},planned:{},pendingId:null},save:async()=>{}};
  return {issue,item,api,input};
}
test("acknowledged add survives status failure and retry",async()=>{
  const f=fixture(), update=f.api.updateStatus;
  f.api.updateStatus=async()=>{throw Error("transport");};
  await assert.rejects(register(f.input));
  assert.equal(f.input.report.receipts[row.id],f.item.id);
  f.api.updateStatus=update;
  await register(f.input); await register(f.input);
  assert.equal(f.issue.items.length,1); assert.deepEqual(f.input.report.appliedIds,[row.id]);
});
test("foreign scope, active or unattributed blank items never receive writes",async()=>{
  for(const change of [f=>{f.issue.repository.nameWithOwner="elsewhere/repo";},
    f=>{f.api.readProject=async()=>({projectId:"other"});}, f=>{f.issue.items=[f.item];},
    f=>{f.issue.items=[f.item,f.item];}, f=>{f.issue.assignees.totalCount=2;},
    f=>{f.item.fieldValueByName={name:"Ready",optionId:"ready"};f.issue.items=[f.item];}]) {
    const f=fixture(); change(f); let writes=0;
    f.api.addItem=f.api.updateStatus=async()=>{writes++;};
    await assert.rejects(register(f.input));assert.equal(writes,0);
  }
});
test("preview and pre-existing Backlog cause no mutations",async()=>{
  const f=fixture(); let writes=0;
  f.api.addItem=f.api.updateStatus=async()=>{writes++;};f.input.apply=false;
  await register(f.input); assert.equal(f.input.report.planned[row.id],"missing");
  f.input.apply=true; f.item.fieldValueByName={name:"Backlog",optionId:"back"}; f.issue.items=[f.item];
  await register(f.input); assert.equal(writes,0); assert.deepEqual(f.input.report.receipts,{});
});
test("unacknowledged add cannot authorize a later blank write",async()=>{
  const f=fixture();f.api.addItem=async()=>{f.issue.items.push(f.item);throw Error("lost acknowledgement");};
  await assert.rejects(register(f.input)); assert.equal(f.input.report.partialWrite,true);
  await assert.rejects(register(f.input),/protected/); assert.equal(f.item.fieldValueByName,null);
});
```

- [ ] GREEN: append to the registration module. `register` receives already verified resume evidence from task 4. Preflight all entries before the first mutation. Re-read the issue with its Project item before and after each mutation. Each write is bounded to one item/field. Mutation acknowledgement loss leaves a potential partial write and requires inspection. A blank without an acknowledged receipt stays blocked even if an add request was sent.

```js
async function itemFor(x,r) {
  const i=await x.api.readStagedIssue(r.nodeId);
  check(i.id===r.nodeId && i.number===r.number && i.title===r.title && i.state==="OPEN" &&
    i.repository?.nameWithOwner===repo && i.assignees?.totalCount===1 &&
    i.assignees.nodes?.length===1 && i.assignees.nodes[0]?.login===owner,"staged identity changed");
  check(Array.isArray(i.labels?.nodes) && i.labels.totalCount===i.labels.nodes.length &&
    i.labels.nodes.every(l=>typeof l?.name==="string" && !/^agile[-:]/.test(l.name)),"staged labels changed");
  const matches=i.items.filter(it=>it.project?.id===x.m.projectId);
  check(matches.length<=1 && (!matches.length || (matches[0].isArchived===false && nodeId(matches[0].id))),"ambiguous item");
  return matches[0] ?? null;
}
function state(x,r,item) {
  const receipt=x.report.receipts[r.id];
  if(receipt) check(item?.id===receipt,"acknowledged item changed");
  if(!item) return "missing";
  const status=item.fieldValueByName;
  if(status?.name==="Backlog" && status.optionId===x.backlog) return "ready";
  check(status===null && receipt===item.id,"existing status protected");
  return "blank";
}
async function step(x,r,name,partialWrite) {
  if(partialWrite) x.report.pendingId=r.id;
  if(name==="verified-backlog" && x.report.pendingId===r.id) x.report.pendingId=null;
  Object.assign(x.report,{failedId:r.id,step:name,partialWrite:x.report.pendingId!==null});
  await x.save(x.report);
}
async function one(x,r) {
  await step(x,r,"read",false);
  let item=await itemFor(x,r), stage=state(x,r,item);
  if(!x.apply) return;
  if(stage==="missing") {
    await step(x,r,"add-requested",true);
    const id=await x.api.addItem(x.m.projectId,r.nodeId);
    check(nodeId(id),"add acknowledgement missing");
    x.report.receipts[r.id]=id;
    await step(x,r,"add-acknowledged",true);
    item=await itemFor(x,r); stage=state(x,r,item);
  }
  if(stage==="blank") {
    await step(x,r,"status-requested",true);
    await x.api.updateStatus(x.m.projectId,item.id,x.field,x.backlog);
    check(state(x,r,await itemFor(x,r))==="ready","status readback failed");
  }
  if(!x.report.appliedIds.includes(r.id)) x.report.appliedIds.push(r.id);
  await step(x,r,"verified-backlog",false);
}
export async function register(x) {
  validate(x.m);
  const p=await x.api.readProject();
  check(p.projectId===x.m.projectId && nodeId(p.fieldId) && nodeId(p.optionsByName?.Backlog),"project identity");
  x.field=p.fieldId; x.backlog=p.optionsByName.Backlog;
  for(const r of x.m.entries) {
    await step(x,r,"preflight",false);
    x.report.planned[r.id]=state(x,r,await itemFor(x,r));
  }
  for(const r of x.m.entries) await one(x,r);
  Object.assign(x.report,{status:x.apply?"registered":"preview",failedId:null,step:"complete",partialWrite:false});
  await x.save(x.report);
}
```

- [ ] Run focused tests. Commit `feat(agile): register staged items with replayable add receipts`. Project Status has no compare-and-swap. R3's coordinator serializes the registration window with other operators. A manual write between the final read and GitHub mutation is an external race; record conflicts on readback and avoid automatic rollback or retry.

## 4. Restrict workflow entry and persist resumable reports

- [ ] RED: append to `tests/agile/workflow.test.mjs`, run it and expect the missing registration input/conditions.

```js
test("registration is manual and normal reconciliation keeps its guards",async()=>{
  const y=await read(".github/workflows/agile-state-sync.yml");
  assert.match(y,/register_prerequisites:/);
  assert.match(y,/inputs\.register_prerequisites != true && inputs\.apply != true/);
  assert.match(y,/github\.event_name != 'workflow_dispatch' \|\| \(inputs\.register_prerequisites != true && inputs\.apply == true\)/);
  assert.match(y,/gh run download "\$GITHUB_RUN_ID"/);
  assert.match(y,/node scripts\/agile\/register-project-items\.mjs/);
});
```

- [ ] Add `restore` to the registration test import and run the focused target. Expect a missing export. This test checks that retry authority comes from an authenticated previous attempt, specific to the reviewed bytes and exact Issue.

```js
test("restore rejects a changed manifest, different run or unlisted receipt",()=>{
  const next={kind:"staged-registration-v1",apply:true,digest:"hash",run:"10",attempt:2,receipts:{}};
  const prev={...next,attempt:1,receipts:{[row.id]:"PVTI_new"},pendingId:row.id};
  for(const changed of [{digest:"other"},{run:"11"},{attempt:0},{receipts:{"P04-001":"PVTI_new"}}]) {
    assert.throws(()=>restore({...prev,...changed},manifest,structuredClone(next)));
  }
  restore(prev,manifest,next);assert.equal(next.receipts[row.id],"PVTI_new");assert.equal(next.partialWrite,true);
});
```

- [ ] GREEN: append the CLI below. Restrict retry input to the prior attempt's authenticated GitHub Actions artifact from this same trusted workflow/run, plus identical manifest digest and apply mode. Accept only known row keys and valid returned item IDs. A new dispatch has no receipt authority over existing blanks. A lost add acknowledgement or missing/corrupt artifact can require operator inspection. Do not read resume data from workflow inputs.

```js
const manifestPath=new URL("../../docs/engineering/observed-prerequisite-registration.json",import.meta.url);
async function persist(path,value) {
  await writeFile(path+".tmp",JSON.stringify(value),{mode:0o600}); await rename(path+".tmp",path);
}
function trusted(e) {
  check(e.GITHUB_EVENT_NAME==="workflow_dispatch" && e.GITHUB_REPOSITORY===repo &&
    e.GITHUB_REF==="refs/heads/main" && e.GITHUB_WORKFLOW_REF===`${repo}/.github/workflows/agile-state-sync.yml@refs/heads/main` &&
    /^\d+$/.test(e.GITHUB_RUN_ID) && /^[1-9]\d*$/.test(e.GITHUB_RUN_ATTEMPT) &&
    ["true","false"].includes(e.REGISTRATION_APPLY),"untrusted registration mode");
}
export function restore(prior,m,report) {
  check(prior.kind===report.kind && prior.apply===true && prior.digest===report.digest &&
    prior.run===report.run && prior.attempt===report.attempt-1 && prior.receipts &&
    typeof prior.receipts==="object" && !Array.isArray(prior.receipts),"untrusted resume report");
  check(prior.pendingId===null || m.entries.some(r=>r.id===prior.pendingId),"invalid pending entry");
  report.pendingId=prior.pendingId;report.partialWrite=prior.pendingId!==null;
  for(const [id,item] of Object.entries(prior.receipts)) {
    check(m.entries.some(r=>r.id===id) && nodeId(item),"invalid add receipt");report.receipts[id]=item;
  }
}
async function resume(e,m,report) {
  if(+e.GITHUB_RUN_ATTEMPT===1 || !report.apply) return;
  const path=join(e.RUNNER_TEMP,"r1-resume","agile-state-plan.json");
  restore(JSON.parse(await readFile(path,"utf8")),m,report);
}
async function main(e) {
  trusted(e);
  const path=join(e.RUNNER_TEMP,"agile-state-plan.json");
  const report={kind:"staged-registration-v1",run:e.GITHUB_RUN_ID,attempt:+e.GITHUB_RUN_ATTEMPT,
    apply:e.REGISTRATION_APPLY==="true",status:"started",step:"manifest",partialWrite:false,
    failedId:null,appliedIds:[],receipts:{},planned:{},pendingId:null};
  try {
    const bytes=await readFile(manifestPath);check(bytes.length<=32768,"manifest size");
    report.digest=createHash("sha256").update(bytes).digest("hex");
    const m=validate(JSON.parse(bytes));await resume(e,m,report);
    const api=createProjectApi(createHttp(globalThis.fetch,e.PROJECT_TOKEN),"GorillaDevLab",1,repo);
    await register({api,m,apply:report.apply,report,save:r=>persist(path,r)});
  } catch(error) {
    report.reason=error instanceof RegistrationError ? error.message : "authority, API, file or checkpoint unavailable";
    report.status="failed";await persist(path,report);process.exitCode=1;
  }
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main(process.env).catch(()=>{process.stderr.write("Registration failed before checkpoint\n");process.exitCode=1;});
}
```

- [ ] Add this boolean alongside `apply` under existing `workflow_dispatch.inputs`.

```yaml
      register_prerequisites:
        description: Register the staged Issues listed on trusted main
        type: boolean
        default: false
```

- [ ] Replace only the Preview/Reconcile `if` expressions with the following respective values. Insert the two steps below immediately before existing artifact upload. The upload retains its current name/path/`always()` behavior. The new mode never runs automatically on labels, renames, merges or CI. During R3's catalog/Issue transition, all ordinary events continue through strict normal reconciliation. Neither suppressed triggers nor a special policy exemption are needed.

```yaml
        if: github.event_name == 'workflow_dispatch' && inputs.register_prerequisites != true && inputs.apply != true
```

```yaml
        if: github.event_name != 'workflow_dispatch' || (inputs.register_prerequisites != true && inputs.apply == true)
```

```yaml
      - name: Restore prior registration acknowledgement
        if: github.event_name == 'workflow_dispatch' && inputs.register_prerequisites == true && inputs.apply == true && github.run_attempt != '1' && github.ref == 'refs/heads/main'
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          previous=$((GITHUB_RUN_ATTEMPT - 1))
          gh run download "$GITHUB_RUN_ID" --repo "$GITHUB_REPOSITORY" --name "agile-state-plan-${GITHUB_RUN_ID}-${previous}" --dir "$RUNNER_TEMP/r1-resume"

      - name: Register staged Project items
        if: github.event_name == 'workflow_dispatch' && inputs.register_prerequisites == true
        env:
          REGISTRATION_APPLY: ${{ inputs.apply }}
          PROJECT_TOKEN: ${{ steps.app-token.outputs.token }}
        run: node scripts/agile/register-project-items.mjs
```

- [ ] Run `node --test tests/agile/*.test.mjs` and `pnpm exec prettier --write scripts/agile/register-project-items.mjs scripts/agile/github-project.mjs tests/agile/register-project-items.test.mjs tests/agile/workflow.test.mjs`. Re-run the focused suite after formatting, expect zero failed/skipped and nonzero registered targets. Check `git diff --check`, changed-function lengths, secret-free logs and effective permissions. Commit `feat(ci): enable trusted manual Project registration`. One reviewed R1 PR. The first live read-only preview and authorized registration canary belong to R3 after the R2 allowlist lands.

**Self-review:** Tasks 1–2 cover exact manifest/Issue/Project identity and pagination. Task 3 covers replay, authority rechecks, add/status readback, active/blank protection and partial writes. Task 4 covers trusted workflow dispatch, same-run receipt continuity, dormant missing manifest and normal reconciliation. Existing Status option identity is checked via the Project client. A missing or expired artifact does not confer ownership of a blank item. GitHub quota or transport failure stops at the recorded step, without another dispatch. The existing App has no GitHub-side status CAS. The operational proof requires R3's coordinated window and final readback. No extra product choice is needed.

Coordinator preflight: existing createProjectApi/updateStatus, createHttp and graphPages interfaces match the plan. USER approved Choice A and scoped R1 workflow extension on 2026-11-11. This authorization overrides the older foundation prohibition only for the listed existing agile-state-sync workflow and Project registration paths. Existing CI/deploy workflows, billing, credentials and App permissions remain unchanged. Use the already selected SDD execution, no extra execution-choice question.

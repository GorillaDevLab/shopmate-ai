import assert from "node:assert/strict";
import test from "node:test";
import { register, validate } from "../../scripts/agile/register-project-items.mjs";
import { createProjectApi } from "../../scripts/agile/github-project.mjs";

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

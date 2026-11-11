const repo = "GorillaDevLab/shopmate-ai";
const owner = "hannnnnnnny";

class RegistrationError extends Error {}

function check(ok, message) {
  if (!ok) throw new RegistrationError(message);
}

function shape(obj, keys) {
  return obj && typeof obj === "object" && !Array.isArray(obj) &&
    Object.keys(obj).sort().join("|") === keys.split(" ").sort().join("|");
}

const nodeId = (v) => typeof v === "string" && /^[A-Za-z0-9_=-]{1,160}$/.test(v);

function validRow(r) {
  return shape(r,"id number nodeId title") && typeof r.id === "string" &&
    /^(P03-0(19|2\d|3[0-6])|P04-0(3[3-9]|4[0-4]))$/.test(r.id) &&
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

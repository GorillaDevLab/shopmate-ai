import { graphPages } from "./http.mjs";

const PAGE = "totalCount pageInfo { hasNextPage endCursor }";
const FIELDS = `query($org:String!,$number:Int!,$after:String){organization(login:$org){projectV2(number:$number){id fields(first:100,after:$after){nodes{... on ProjectV2SingleSelectField{id name options{id name}}} ${PAGE}}}}}`;
const ITEMS = `query($org:String!,$number:Int!,$after:String){organization(login:$org){projectV2(number:$number){id items(first:100,after:$after){nodes{id content{... on Issue{number repository{nameWithOwner}}} fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name optionId}}} ${PAGE}}}}}`;
const ITEM = `query($id:ID!){node(id:$id){... on ProjectV2Item{id project{id} content{... on Issue{number repository{nameWithOwner}}} fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name optionId}}}}}`;
const UPDATE = `mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$optionId:String!){updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{singleSelectOptionId:$optionId}}){projectV2Item{id}}}`;

function projectItem(row, fullName) {
  if (row.content?.repository?.nameWithOwner !== fullName) return null;
  return {
    number: row.content.number,
    itemId: row.id,
    status: row.fieldValueByName?.name ?? null,
    optionId: row.fieldValueByName?.optionId ?? null,
  };
}

function client(ctx) {
  if (!ctx.http) throw new Error("Project setup required: PROJECT_TOKEN missing");
  return ctx.http;
}

async function connection(ctx, query, key) {
  return graphPages(async (after) => {
    const data = await client(ctx).graphql(query, { ...ctx.variables, after });
    return data.organization?.projectV2?.[key];
  });
}

async function readProject(ctx) {
  const fields = await connection(ctx, FIELDS, "fields");
  const status = fields.filter((field) => field?.name === "Status");
  if (status.length !== 1) throw new Error("Project Status field missing or ambiguous");
  const options = status[0].options;
  const optionsByName = Object.fromEntries(options.map((option) => [option.name, option.id]));
  if (
    Object.keys(optionsByName).length !== options.length ||
    new Set(Object.values(optionsByName)).size !== options.length
  )
    throw new Error("Project Status options ambiguous");
  const items = await connection(ctx, ITEMS, "items");
  const data = await client(ctx).graphql(FIELDS, { ...ctx.variables, after: null });
  const projectId = data.organization?.projectV2?.id;
  if (!projectId) throw new Error("Project missing");
  return {
    projectId,
    fieldId: status[0].id,
    optionsByName,
    items: items.map((item) => projectItem(item, ctx.fullName)).filter(Boolean),
  };
}

async function readProjectItem(ctx, itemId) {
  const data = await client(ctx).graphql(ITEM, { id: itemId });
  const row = data.node;
  if (!row?.project?.id) throw new Error("Project item missing");
  const item = projectItem(row, ctx.fullName);
  if (!item) throw new Error("Project item repository mismatch");
  return { ...item, projectId: row.project.id };
}

export function createProjectApi(http, org, number, fullName) {
  const ctx = { http, variables: { org, number }, fullName };
  return {
    readProject: () => readProject(ctx),
    readProjectItem: (id) => readProjectItem(ctx, id),
    updateStatus: (projectId, itemId, fieldId, optionId) =>
      client(ctx).graphql(UPDATE, { projectId, itemId, fieldId, optionId }),
  };
}

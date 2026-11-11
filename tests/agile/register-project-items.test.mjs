import assert from "node:assert/strict";
import test from "node:test";
import { validate } from "../../scripts/agile/register-project-items.mjs";
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

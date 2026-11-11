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

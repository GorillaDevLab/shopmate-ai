import assert from "node:assert/strict";
import test from "node:test";
import { loadDemoScenario } from "../src/demo-scenarios.ts";
test("rejects invalid scenario writes before requesting database identity", async () => {
  const actor = { userId: "u", merchantId: "m" };
  assert.deepEqual(await loadDemoScenario(actor, "s", {}), { status: "CONFLICT" });
  assert.deepEqual(await loadDemoScenario({ ...actor, userId: "../bad" }, "s", {}), {
    status: "NOT_FOUND",
  });
});

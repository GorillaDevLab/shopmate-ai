import pg from "pg";
import assert from "node:assert/strict";

export async function measuredLatest(testContext, action) {
  const original = pg.Client.prototype.query;
  const plans = [];
  const spy = testContext.mock.method(pg.Client.prototype, "query", async function (sql, ...args) {
    if (
      typeof sql === "string" &&
      sql.startsWith("SELECT") &&
      sql.includes('FROM mock_platform."EntityVersion"')
    ) {
      const result = await original.call(
        this,
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
        ...args,
      );
      plans.push(result.rows[0]["QUERY PLAN"][0]);
    }
    return original.call(this, sql, ...args);
  });
  try {
    return { page: await action(), plans };
  } finally {
    spy.mock.restore();
  }
}

export function planNodes(plan) {
  return [plan, ...(plan.Plans ?? []).flatMap(planNodes)];
}

export function assertEntitySeeks(plans) {
  for (const measured of plans) {
    const nodes = planNodes(measured.Plan);
    assert.ok(
      nodes.some((node) => node["Node Type"].includes("Index")),
      JSON.stringify(measured),
    );
    assert.ok(
      !nodes.some(
        (node) =>
          node["Node Type"] === "Sort" ||
          (node["Relation Name"] === "EntityVersion" && node["Node Type"] === "Seq Scan"),
      ),
      JSON.stringify(measured),
    );
    assert.ok(
      nodes
        .filter((node) => node["Relation Name"] === "EntityVersion")
        .every((node) => node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0) <= 1),
      JSON.stringify(measured),
    );
  }
}

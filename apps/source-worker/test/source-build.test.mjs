import assert from "node:assert/strict";
import { test } from "node:test";
import * as source from "@shopmate/database/mock-platform";
import { buildSource } from "../dist/build.js";
import { generationTools } from "../dist/generation-tools.js";
import { createSourceGroupGenerator } from "@shopmate/api/mock-generator";
import {
  leasePortDatabase,
  closeLeasePortDatabase,
} from "../../../packages/database/test/helpers/mock-source-lease-port-fixture.mjs";
import {
  scopeFor,
  configFor,
  hashConfig,
} from "../../../packages/database/test/helpers/mock-platform-fixture.mjs";

async function configure(context, scope) {
  const config = { ...configFor(scope, "mature", 7), productCount: 100, dailyOrders: 15 };
  await context.admin.query(
    'UPDATE demo."DemoCommerceSession" SET config=$1,"configHash"=$2 WHERE id=$3',
    [config, hashConfig(config), scope.sessionId],
  );
  return config;
}

async function publishedCount(context, scope) {
  const result = await context.admin.query(
    'SELECT count(*)::int AS count FROM mock_platform."EntityVersion" WHERE "sessionId"=$1 AND generation=$2',
    [scope.sessionId, scope.generation],
  );
  return result.rows[0].count;
}

function expectedLatest(config, until) {
  const generator = createSourceGroupGenerator(config),
    records = new Map();
  let after = new Date(Date.parse(config.historyStart) - 1).toISOString();
  while (after < until) {
    const end = new Date(Math.min(Date.parse(after) + 86_400_000, Date.parse(until))).toISOString();
    for (const group of generator.window(after, end))
      for (const event of group.events)
        records.set(JSON.stringify(source.eventTuple(event).entityKey), event.after);
    after = end;
  }
  return records;
}

async function assertLatest(context, scope, config, until) {
  const result = await context.admin.query(
    'SELECT DISTINCT ON (kind,"entityKey" COLLATE "C") "entityKey",payload FROM mock_platform."EntityVersion" WHERE "sessionId"=$1 AND generation=$2 ORDER BY kind,"entityKey" COLLATE "C","eventSeq" DESC',
    [scope.sessionId, scope.generation],
  );
  const expected = expectedLatest(config, until);
  assert.equal(result.rows.length, expected.size);
  for (const row of result.rows) {
    const payload = { ...row.payload, source: { ...row.payload.source, version: null } };
    assert.deepEqual(payload, expected.get(JSON.stringify(JSON.parse(row.entityKey))));
  }
}

test("source host recovers an acknowledged opening prefix without duplicate facts", async () => {
  const context = await leasePortDatabase(source, "host");
  const scope = scopeFor(),
    work = { actor: { grantId: "source-grant-a" }, scope };
  try {
    const config = await configure(context, scope);
    let lost = false;
    const observations = [];
    const interrupted = new Proxy(context.worker, {
      get(target, key) {
        if (key !== "appendChunk") {
          const method = Reflect.get(target, key);
          if (typeof method !== "function") return method;
          return async (...args) => {
            const result = await method(...args);
            observations.push([key, result?.status]);
            return result;
          };
        }
        return async (...args) => {
          const result = await target.appendChunk(...args);
          if (!lost && result.status === "COMMITTED") {
            lost = true;
            throw new source.SourceStorageError("SOURCE_STORAGE");
          }
          return result;
        };
      },
    });
    await assert.rejects(
      async () => {
        const outcome = await buildSource(interrupted, work, generationTools);
        assert.fail(
          `Expected lost append response, got ${outcome.status}: ${JSON.stringify(observations)}`,
        );
      },
      { code: "SOURCE_STORAGE" },
    );
    assert.equal(await publishedCount(context, scope), 80);
    const reader = source.createMockSourceReader(context.env);
    try {
      assert.equal(
        await reader.findPublication(
          { userId: "source-human", merchantId: "source-merchant-a" },
          scope,
        ),
        null,
      );
    } finally {
      await reader.close();
    }
    const recovered = await buildSource(context.worker, work, generationTools);
    assert.equal(recovered.status, "PUBLISHED");
    assert.equal(await publishedCount(context, scope), 401);
    assert.equal((await buildSource(context.worker, work, generationTools)).status, "IDLE");
    for (const days of [1, 2]) {
      const until = new Date(Date.parse(config.historyStart) + days * 86_400_000).toISOString();
      await context.admin.query(
        'UPDATE demo."DemoCommerceSession" SET "clockNow"=$1,"clockRevision"="clockRevision"+1,revision=revision+1 WHERE id=$2',
        [until, scope.sessionId],
      );
      assert.equal((await buildSource(context.worker, work, generationTools)).status, "PUBLISHED");
      await assertLatest(context, scope, config, until);
    }
    const count = await publishedCount(context, scope);
    await context.admin.query('UPDATE demo."MockWorkerGrant" SET status=$1 WHERE id=$2', [
      "REVOKED",
      "source-grant-a",
    ]);
    assert.equal((await buildSource(context.worker, work, generationTools)).status, "DENIED");
    assert.equal(await publishedCount(context, scope), count);
  } finally {
    await closeLeasePortDatabase(context);
  }
});

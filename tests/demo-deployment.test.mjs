import assert from "node:assert/strict";
import test from "node:test";

import { DEMO_INIT_COMMANDS, initializeDemo, requireDatabaseUrl } from "../scripts/demo-init.mjs";

test("Demo 初始化缺少 DATABASE_URL 时明确失败", () => {
  assert.throws(() => requireDatabaseUrl({}), /DATABASE_URL/);
});

test("Demo 初始化按 Migration → Seed 顺序执行", () => {
  const calls = [];

  initializeDemo({
    env: {
      DATABASE_URL: "postgresql://local-demo",
    },
    execute(args) {
      calls.push(args);
    },
  });

  assert.deepEqual(calls, DEMO_INIT_COMMANDS);
});

test("Migration 失败后不会继续执行 Seed", () => {
  const calls = [];

  assert.throws(() => {
    initializeDemo({
      env: {
        DATABASE_URL: "postgresql://local-demo",
      },
      execute(args) {
        calls.push(args);

        if (args.includes("prisma:migrate:deploy")) {
          throw new Error("migration failed");
        }
      },
    });
  }, /migration failed/);

  assert.equal(calls.length, 1);

  assert.equal(calls[0].includes("prisma:migrate:deploy"), true);
});

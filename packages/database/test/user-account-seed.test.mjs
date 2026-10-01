import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { demoUserAccounts } from "../src/user-account-seed-data.ts";

test("demo users are isolated across three analytics merchants", () => {
  assert.equal(demoUserAccounts.length, 3);

  assert.deepEqual(
    demoUserAccounts.map((account) => account.id),
    ["demo-user-a", "demo-user-b", "demo-user-c"],
  );

  assert.deepEqual(
    demoUserAccounts.map((account) => account.merchantId),
    ["analytics-demo-a", "analytics-demo-b", "analytics-demo-c"],
  );

  assert.equal(new Set(demoUserAccounts.map((account) => account.email)).size, 3);

  assert.equal(new Set(demoUserAccounts.map((account) => account.merchantId)).size, 3);
});

test("user seed defaults to dry run without exposing passwords", () => {
  const env = {
    ...process.env,
    DATABASE_URL: "",
    DEMO_DATABASE_WRITE: "",
    DEMO_USER_A_PASSWORD: "",
    DEMO_USER_B_PASSWORD: "",
    DEMO_USER_C_PASSWORD: "",
  };

  const result = spawnSync(process.execPath, ["--import", "tsx", "src/user-account-seed.ts"], {
    env,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);

  const preview = JSON.parse(result.stdout);

  assert.equal(preview.dryRun, true);
  assert.equal(preview.users.length, 3);
  assert.ok(preview.users.every((account) => !Object.hasOwn(account, "password")));
});

test("applying user seed requires explicit demo passwords", () => {
  const env = {
    ...process.env,
    DATABASE_URL: "",
    DEMO_DATABASE_WRITE: "isolated-demo-only",
    DEMO_USER_A_PASSWORD: "",
    DEMO_USER_B_PASSWORD: "",
    DEMO_USER_C_PASSWORD: "",
  };

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/user-account-seed.ts", "--apply"],
    {
      env,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /DEMO_USER_A_PASSWORD/);
});

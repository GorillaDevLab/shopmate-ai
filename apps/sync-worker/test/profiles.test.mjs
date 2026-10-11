import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";
import { createMockSourceWorker } from "@shopmate/database/mock-platform";
import { createMockSourceReadPorts } from "@shopmate/database/mock-platform-read";
import { SyncWorkerPorts } from "@shopmate/database/sync-host";
import { SyncCommerce, SyncPageRunner, SYNC_STREAMS } from "../dist/index.js";
import {
  createSyncDatabase,
  closeSyncDatabase,
} from "../../../packages/database/test/helpers/sync-host-fixture.mjs";
import {
  sourceEnv,
  loginUrl,
} from "../../../packages/database/test/helpers/mock-platform-fixture.mjs";
import { maintenanceClient } from "../../../packages/database/test/helpers/mock-source-control-fixture.mjs";
import {
  profileState,
  publishProfile,
  createProfileGrant,
  sourceFacts,
  canonicalFacts,
} from "./profile-fixture.mjs";

const profiles = ["growing", "problematic", "mature", "new"];
const full = process.env.P2_ACCEPTANCE_FULL === "true";
const selected = process.env.P2_ACCEPTANCE_PROFILE;
if (selected && !profiles.includes(selected)) throw new Error("INVALID_ACCEPTANCE_PROFILE");
let database, context, sources, savedUrl;
test.before(async () => {
  database = await createSyncDatabase("worker");
  const env = { ...sourceEnv(database.url), MOCK_SOURCE_CURSOR_KEY: "k".repeat(32) };
  context = {
    env,
    admin: maintenanceClient(database.admin, "source-human"),
    worker: createMockSourceWorker(env),
  };
  sources = createMockSourceReadPorts(env);
  savedUrl = process.env.SYNC_WORKER_DATABASE_URL;
  process.env.SYNC_WORKER_DATABASE_URL = loginUrl(database.url, "sync_worker_login");
});
test.after(async () => {
  await sources?.close();
  await context?.worker.close();
  if (savedUrl === undefined) delete process.env.SYNC_WORKER_DATABASE_URL;
  else process.env.SYNC_WORKER_DATABASE_URL = savedUrl;
  if (database) await closeSyncDatabase(database);
});

async function syncProfile(state, grant) {
  const host = await SyncWorkerPorts.connectGrant(grant);
  try {
    const opened = await new SyncCommerce(host, sources).open({
      requestId: "profile-pg",
      deadlineAt: new Date(Date.now() + 25000).toISOString(),
    });
    assert.equal(opened.ok, true);
    assert.ok(opened.data);
    const runner = new SyncPageRunner(
      host,
      opened.data.connector,
      opened.data.bootstrap.runtimeOpening,
    );
    const jobs = [];
    for (const stream of SYNC_STREAMS) {
      const job = await host.createWindow(stream, state.until);
      const result = await runner.run(job, { maxPages: 1000, budgetMs: 3600000 });
      assert.equal(result.reason, "SUCCEEDED");
      assert.equal(result.job.successfulThrough, state.until);
      assert.equal(result.job.sourceWatermark, state.until);
      jobs.push({ stream, pages: result.job.pageCount });
    }
    return jobs;
  } finally {
    await host.close();
  }
}

async function acceptProfile(profile) {
  const started = Date.now(),
    state = await profileState(context, profile, full);
  const oracle = await publishProfile(context, state);
  const sourceMs = Date.now() - started;
  const facts = await sourceFacts(database.admin, state, oracle);
  assertActiveHistory(profile, state, facts);
  const jobs = await syncProfile(state, await createProfileGrant(database.admin, state));
  const counts = await canonicalFacts(database.admin, state, facts);
  reportProfile({
    profile,
    configuredDays: 180,
    activeDays: profile === "new" ? 14 : 180,
    volume: full ? "default" : "compact",
    dailyOrders: state.config.dailyOrders,
    sourceEvents: oracle.eventCount,
    counts,
    jobs,
    sourceMs,
    totalMs: Date.now() - started,
  });
}
function assertActiveHistory(profile, state, facts) {
  if (profile === "new") {
    assert.equal(
      Date.parse(state.opening) - Date.parse(state.config.historyStart),
      166 * 86_400_000,
    );
    assert.ok(
      facts
        .filter((row) => row.kind === "ORDER")
        .every((row) => row.payload.orderedAt >= state.opening),
    );
  }
}
function reportProfile(result) {
  process.stdout.write(JSON.stringify(result) + "\n");
}
for (const profile of profiles.filter((value) => !selected || value === selected)) {
  test(`${profile}: 180 configured days, ${full ? "default" : "compact"} volume, persistent five-stream backfill`, () =>
    acceptProfile(profile));
}

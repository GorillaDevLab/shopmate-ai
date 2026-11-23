import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import pg from "pg";
import { isolatedPostgres } from "./helpers/isolated-postgres.mjs";
import {
  configFor,
  createSourceSession,
  grantSource,
  hashConfig,
  loginUrl,
  readerActor,
  scopeFor,
  sourceFixtures,
} from "./helpers/mock-platform-fixture.mjs";
import { eventFor, kinds } from "./helpers/mock-source-append-fixture.mjs";
import {
  beginControl,
  beginWorker,
  grantControl,
  operatorControl,
  waitLock,
} from "./helpers/mock-source-control-fixture.mjs";
import { beginOperation, CONTROL, outcome } from "./helpers/mock-source-control-race-fixture.mjs";
import { claim, scopeValues, sourceTransaction } from "./helpers/mock-source-lease-fixture.mjs";
import {
  certificates,
  publish,
  publishSettings,
  updatePublish,
  readerTransaction,
  seal,
  visibleVersions,
} from "./helpers/mock-source-publish-fixture.mjs";

const databaseRoot = new URL("../", import.meta.url);
const root = new URL("prisma/migrations/", databaseRoot);
const migrationPattern = /^\d{14}_mock_observed_generation_admission$/u;
const mode = "--restricted-observed-generation-admission";
const restricted = process.argv.includes(mode);
const observedSchema = restricted
  ? (await import("@shopmate/contracts")).MockObservedGenerationConfigV3Schema
  : undefined;
const v3 = "mock-source-v3";
const modelVersion = "mock-business-observed-v1";
const namespace = 'mock/店𠮷"\\e\u0301';
const day = 86_400_000;
const vectors = {
  "mock-source-v1": "6a384aac570b53f23caaf8447f40e58f278a94ea7b8e404f6322b01647d8085e",
  "mock-source-v2": "92a81771c1363c37d38c72cc1fde5bd1fb373ebf073ea73259cf292355f83ebd",
  v3: "bba65b59b42fd4e1a79db7e9b54ee39b0f3c3ca9e722e589f87d928bc07e5985",
  plan: "5a5d1b0c6cbf8dc5c0f7801cee8f7f651bef9272d551cad362e6e14cbfa96edb",
  reversed: "9b0f33a466ebc643621109a6cbf537660f8a5bdcef31c2e8da5aa245b2e37b81",
};

const runtimeSql = `INSERT INTO mock_platform."Runtime"
  ("sessionId",generation,"organizationId","workspaceId","storeId","connectionId","externalStoreId",
   "sourceConfig","configHash","generatorVersion","runtimeVersion","openingAt","baselineEnd")
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,'mock-runtime-v2',$11::timestamp,$12::timestamp)
  RETURNING "sourceConfig","configHash","generatorVersion","runtimeVersion"`;

const configureSql = `UPDATE demo."DemoCommerceSession"
  SET config=$2::jsonb,"configHash"=$3,"generatorVersion"=$4 WHERE id=$1`;

async function migrationNames() {
  return (await readdir(root)).filter((name) => /^\d{14}_/u.test(name)).sort();
}

function migrationSql(name) {
  return readFile(new URL(`${name}/migration.sql`, root), "utf8");
}

test("observed generation admission installs through one additive migration", async () => {
  const matches = (await migrationNames()).filter((name) => migrationPattern.test(name));
  assert.equal(matches.length, 1);
  const sql = await migrationSql(matches[0]);
  for (const table of ["Runtime", "BuildJob"]) {
    assert.ok(
      sql.includes(
        `ALTER TABLE mock_platform."${table}" DROP CONSTRAINT "${table}_generatorVersion_check"`,
      ),
    );
    assert.ok(
      sql.includes(
        `ALTER TABLE mock_platform."${table}" ADD CONSTRAINT "${table}_generatorVersion_check"`,
      ),
    );
  }
});

function mutation(skuIndex) {
  return {
    skuIndex,
    retainDemandBps: 10000,
    priceBps: 1000,
    discountBps: 9000,
    refundBps: 10000,
    cancelBps: 0,
    restockBps: 100000,
    launchRampDays: 14,
    restockDelayDays: 5,
  };
}

function scenarioFor(config) {
  return {
    version: "mock-scenario-v1",
    scenarioId: "SCENARIO_015",
    externalStoreId: config.binding.externalStoreId,
    startDay: 0,
    endDay: config.days,
    mutations: [mutation(0), mutation(179)],
    campaignSpendBps: 12345,
    campaignConversionBps: 10000,
    delivery: { kind: "INTERRUPT", durationMs: 86400000 },
  };
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  );
}

function decodeConfig(config) {
  return observedSchema.parse({
    generatorVersion: v3,
    generation: 0,
    configHash: "0".repeat(64),
    config,
  }).config;
}

function request(config, version = v3, overrides = {}) {
  const start = Date.parse(config.historyStart);
  const offset = config.profile === "new" ? Math.max(0, config.days - 14) : 0;
  return {
    version,
    config,
    json: JSON.stringify(config),
    hash: hashConfig(version === v3 ? decodeConfig(config) : config),
    openingAt: new Date(start + offset * day).toISOString(),
    baselineEnd: new Date(start + config.days * day).toISOString(),
    ...overrides,
  };
}

async function connect(state, url) {
  const client = new pg.Client({
    connectionString: url,
    types: {
      getTypeParser: (type) =>
        type === 1114 ? (value) => new Date(value + "Z") : pg.types.getTypeParser(type),
    },
  });
  await client.connect();
  state.clients.push(client);
  await client.query("SET statement_timeout='15s'");
  return client;
}

function prisma(url, args) {
  return execFileSync(
    process.execPath,
    [fileURLToPath(new URL("node_modules/prisma/build/index.js", databaseRoot)), ...args],
    {
      cwd: fileURLToPath(databaseRoot),
      env: { ...process.env, DATABASE_URL: url, DOTENV_CONFIG_OVERRIDE: "false" },
      encoding: "utf8",
      windowsHide: true,
      stdio: "pipe",
    },
  );
}

async function deployPreviousHistory(url, names) {
  const stage = await mkdtemp(join(tmpdir(), "shopmate-admission-prisma-"));
  try {
    const config = join(stage, "prisma.config.mjs");
    const schema = fileURLToPath(new URL("prisma/schema.prisma", databaseRoot));
    await writeFile(
      config,
      `export default { schema: ${JSON.stringify(schema)},
      migrations: { path: ${JSON.stringify(stage)} }, datasource: { url: process.env.DATABASE_URL } };`,
    );
    await copyFile(new URL("migration_lock.toml", root), join(stage, "migration_lock.toml"));
    for (const name of names) {
      await mkdir(join(stage, name));
      await copyFile(new URL(`${name}/migration.sql`, root), join(stage, name, "migration.sql"));
    }
    prisma(url, ["migrate", "deploy", "--config", config]);
  } finally {
    // The directory was allocated for this fixture only.
    await rm(stage, { recursive: true, force: true });
  }
}

function schemaParity(url) {
  const result = prisma(url, [
    "migrate",
    "diff",
    "--from-config-datasource",
    "--to-schema",
    "prisma/schema.prisma",
    "--exit-code",
    "--script",
  ]);
  assert.match(result, /empty migration/u);
}

async function prepare(state) {
  state.server = await isolatedPostgres();
  state.owner = await connect(state, state.server.url);
  await state.owner.query('CREATE DATABASE "shopmate_tenant_test_admission"');
  state.created = true;
  const url = new URL(state.server.url);
  url.pathname = "/shopmate_tenant_test_admission";
  state.url = url.toString();
  state.admin = await connect(state, state.url);
  const names = await migrationNames();
  await deployPreviousHistory(
    state.url,
    names.filter((name) => !migrationPattern.test(name)),
  );
  await sourceFixtures(state.admin);
  await grantControl(state.admin, "source_control_login");
  state.control = await connect(state, loginUrl(state.url, "source_control_login"));
  state.worker = await connect(state, loginUrl(state.url, "source_worker_login"));
  state.reader = await connect(state, loginUrl(state.url, "source_read_login"));
  await seedHistory(state);
  const result = prisma(state.url, ["migrate", "deploy"]);
  state.deployed = names.find((name) => migrationPattern.test(name)) ?? "";
  assert.match(
    result,
    /migrations? have been successfully applied|already up to date|No pending migrations/u,
  );
  const { createMockSourceReader, createMockSourceWorker } = await import(
    "@shopmate/database/mock-platform"
  );
  state.typedWorker = createMockSourceWorker({
    MOCK_PLATFORM_WORKER_DATABASE_URL: loginUrl(state.url, "source_worker_login"),
  });
  state.typedReader = createMockSourceReader({
    MOCK_PLATFORM_READ_DATABASE_URL: loginUrl(state.url, "source_read_login"),
  });
}

async function shutdown(state) {
  const results = await Promise.allSettled([
    state.typedWorker?.close(),
    state.typedReader?.close(),
    ...state.clients.filter((client) => client !== state.owner).map((client) => client.end()),
  ]);
  try {
    if (state.created) await state.owner.query('DROP DATABASE "shopmate_tenant_test_admission"');
  } finally {
    await state.owner?.end();
    await state.server?.stop();
  }
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length) throw new AggregateError(failed.map((result) => result.reason));
}

async function contextFor(state, suffix, externalStoreId = namespace) {
  const scope = {
    ...scopeFor(),
    storeId: `admission-store-${suffix}`,
    sessionId: `admission-session-${suffix}`,
    connectionId: `admission-connection-${suffix}`,
    externalStoreId,
  };
  const grant = `admission-grant-${suffix}`;
  await createSourceSession(state.admin, scope);
  await grantSource(state.admin, scope, grant);
  return { scope, grant };
}

function configV3(context) {
  return { modelVersion, ...configFor(context.scope), scenarioPlan: null };
}

async function provision(state, context, candidate) {
  const updated = await operatorControl(
    state.control,
    configureSql,
    [context.scope.sessionId, candidate.json, candidate.hash, candidate.version],
    context.scope,
  );
  assert.equal(updated.rowCount, 1);
}

function runtimeValues(context, candidate) {
  return [
    ...scopeValues(context.scope),
    candidate.json,
    candidate.hash,
    candidate.version,
    candidate.openingAt,
    candidate.baselineEnd,
  ];
}

function insertRuntime(state, context, candidate, grant = context.grant) {
  return sourceTransaction(
    state.worker,
    context.scope,
    "CLAIM",
    () => state.worker.query(runtimeSql, runtimeValues(context, candidate)),
    null,
    grant,
  );
}

async function buildPublication(state, context, version, eventKinds = ["STORE"]) {
  const claimed = await claim(state.worker, context);
  assert.equal(claimed.rowCount, 1);
  context.job = claimed.rows[0];
  assert.equal(context.job.generatorVersion, version);
  assert.equal(context.job.runtimeVersion, "mock-runtime-v2");
  assert.equal(context.job.codec, "source-snapshot-v1");
  await seal(
    state.worker,
    context,
    eventKinds.map((kind) => eventFor(context, kind)),
  );
  const published = await publish(state.worker, context);
  assert.equal(published.rowCount, 1);
  assert.equal(published.rows[0].state, "PUBLISHED");
  const rows = (await certificates(state.reader, context)).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].certificateHash, published.rows[0].certificateHash);
  assert.equal(rows[0].generatorVersion, version);
  const versions = (await visibleVersions(state.reader, context)).rows;
  assert.deepEqual(versions.map((row) => row.kind).sort(), [...eventKinds].sort());
  return rows[0];
}

async function historicBytes(state, context) {
  const certificate = await sourceTransaction(
    state.worker,
    context.scope,
    "CLAIM",
    () =>
      state.worker.query(
        `SELECT mock_platform.publication_certificate(j)::text AS "certificateBytes","certificateHash"
       FROM mock_platform."BuildJob" j WHERE "sessionId"=$1 AND state='PUBLISHED'`,
        [context.scope.sessionId],
      ),
    null,
    context.grant,
  );
  const facts = await readerTransaction(state.reader, context, () =>
    state.reader.query(
      'SELECT payload::text AS bytes FROM mock_platform."EntityVersion" WHERE "sessionId"=$1 ORDER BY "eventSeq"',
      [context.scope.sessionId],
    ),
  );
  assert.equal(certificate.rowCount, 1);
  assert.equal(facts.rowCount, 1);
  return { certificate: certificate.rows[0], facts: facts.rows };
}

async function seedHistory(state) {
  state.history = [];
  for (const version of ["mock-source-v1", "mock-source-v2"]) {
    const context = await contextFor(state, version);
    const config = configFor(context.scope);
    if (version === "mock-source-v2") config.scenarioPlan = scenarioFor(config);
    const candidate = request(config, version);
    assert.equal(candidate.hash, vectors[version]);
    await provision(state, context, candidate);
    assert.equal((await insertRuntime(state, context, candidate)).rowCount, 1);
    await buildPublication(state, context, version);
    state.history.push({ context, candidate, bytes: await historicBytes(state, context) });
  }
}

function boundedSnapshotError(error) {
  assert.equal(error.code, "23514");
  assert.equal(error.message, "Invalid source snapshot");
  assert.equal(error.detail, undefined);
  assert.equal(error.hint, undefined);
  return true;
}

async function assertDatabaseConfigBytes(state, candidate) {
  const result = await state.worker.query(
    "SELECT mock_platform.observed_config_json($1::jsonb) AS bytes",
    [candidate.json],
  );
  assert.equal(result.rows[0].bytes, JSON.stringify(decodeConfig(candidate.config)));
}

async function testV3Publication(state) {
  const context = await contextFor(state, "v3");
  const config = configV3(context);
  const candidate = request(config);
  assert.equal(candidate.hash, vectors.v3);
  await assertDatabaseConfigBytes(state, candidate);
  await provision(state, context, candidate);
  const rows = (await insertRuntime(state, context, candidate)).rows;
  assert.deepEqual(rows, [
    {
      sourceConfig: config,
      configHash: candidate.hash,
      generatorVersion: v3,
      runtimeVersion: "mock-runtime-v2",
    },
  ]);
  const certificate = await buildPublication(state, context, v3, kinds);
  assert.equal(certificate.externalStoreId, namespace);
  assert.equal(certificate.eventCount, "6");
}

async function testPlanVector(state) {
  const context = await contextFor(state, "plan");
  const config = configV3(context);
  config.scenarioPlan = scenarioFor(config);
  const candidate = request(config);
  assert.equal(candidate.hash, vectors.plan);
  const json = JSON.stringify(sortKeys(config))
    .replace('"days":30', '"days":30.000')
    .replace('"adSpendMinor":10000', '"adSpendMinor":1e4')
    .replace('"growthBps":0', '"growthBps":-0.0')
    .replace('"skuIndex":179', '"skuIndex":179.00');
  const reversed = {
    ...config,
    scenarioPlan: {
      ...config.scenarioPlan,
      mutations: [...config.scenarioPlan.mutations].reverse(),
    },
  };
  const outOfOrder = request(reversed);
  assert.equal(outOfOrder.hash, vectors.reversed);
  await provision(state, context, { ...outOfOrder, hash: candidate.hash });
  await assert.rejects(
    insertRuntime(state, context, { ...outOfOrder, hash: candidate.hash }),
    boundedSnapshotError,
  );
  assert.equal(hashConfig(decodeConfig(JSON.parse(json))), candidate.hash);
  assert.notEqual(json, JSON.stringify(decodeConfig(config)));
  await assertDatabaseConfigBytes(state, { ...candidate, json });
  await provision(state, context, { ...candidate, json });
  const rows = (await insertRuntime(state, context, candidate)).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].configHash, candidate.hash);
  assert.deepEqual(rows[0].sourceConfig, config);
}

const invalidRoot = [
  ["mis-pinned model", { modelVersion: "mock-business-v1" }],
  ["missing model", { modelVersion: undefined }],
  ["extra top-level field", { oracle: "private" }],
  ["missing resolved field", { adSpendMinor: undefined }],
  ["noninteger number", { adSpendMinor: 1.5 }],
  ["number outside its range", { seed: 4294967296 }],
  ["unsafe number", { seed: 9007199254740992 }],
  ["stringified integer", { adSpendMinor: "5" }],
  ["noncanonical Gregorian date", { historyStart: "2025-02-29T16:00:00.000Z" }],
  ["non-Shanghai midnight", { historyStart: "2025-12-31T00:00:00.000Z" }],
  ["overflowing settlement date", { historyStart: "9999-12-31T16:00:00.000Z" }],
  ["invalid scalar scenario", { scenarioPlan: 1 }],
  ["oversize configuration", { profile: "a".repeat(1_000_000) }],
];

const invalidPlans = [
  ["nonarray scenario mutations", { mutations: {} }],
  ["overlong mutation array", { mutations: [0, 1, 2, 3].map(mutation) }],
  ["conflicting scenario store", { externalStoreId: "foreign" }],
  ["unknown frozen scenario ID", { scenarioId: "SCENARIO_016" }],
  ["duplicate scenario SKU", { mutations: [mutation(0), mutation(0)] }],
  ["SKU outside configured catalog", { mutations: [mutation(180)] }],
  ["extra mutation field", { mutations: [{ ...mutation(0), hiddenCause: "private" }] }],
  ["scenario beyond frozen horizon", { endDay: 31 }],
  ["inverted scenario range", { startDay: 10, endDay: 10 }],
  ["delivery missing required duration", { delivery: { kind: "INTERRUPT" } }],
  ["delivery outside duration range", { delivery: { kind: "INTERRUPT", durationMs: 0 } }],
  ["delivery with irrelevant fields", { delivery: { kind: "NORMAL", repetitions: 1 } }],
  ["invalid saved-page repetitions", { delivery: { kind: "REPLAY_SAVED_PAGE", repetitions: 4 } }],
];

async function rejectConfig(state, label, change) {
  const context = (state.invalid ??= await contextFor(state, "invalid"));
  const config = configV3(context);
  const valid = request(config);
  const rejected = change(config);
  const candidate = { ...valid, json: JSON.stringify(rejected), hash: hashConfig(rejected) };
  await provision(state, context, candidate);
  await assert.rejects(insertRuntime(state, context, candidate), boundedSnapshotError, label);
  assert.equal(await runtimeCount(state, context), 0);
}

async function testAbsentScenario(state) {
  const context = await contextFor(state, "absent-plan");
  const config = configV3(context);
  const valid = request(config);
  const missing = { ...config, scenarioPlan: undefined };
  const candidate = {
    ...valid,
    json: JSON.stringify(missing),
    hash: hashConfig(sortKeys(missing)),
  };
  assert.throws(() => decodeConfig(missing));
  await provision(state, context, candidate);
  await assert.rejects(insertRuntime(state, context, candidate), boundedSnapshotError);
  assert.equal(await runtimeCount(state, context), 0);
}

async function testSortedDigest(state) {
  const context = await contextFor(state, "sorted");
  const config = configV3(context);
  config.scenarioPlan = scenarioFor(config);
  const oldHash = hashConfig(sortKeys(config));
  const candidate = request(config, v3, { hash: oldHash });
  assert.notEqual(oldHash, hashConfig(decodeConfig(config)));
  await provision(state, context, candidate);
  await assert.rejects(insertRuntime(state, context, candidate), boundedSnapshotError);
  assert.equal(await runtimeCount(state, context), 0);
}

async function testMismatchedSnapshot(state) {
  const context = await contextFor(state, "pins");
  const config = configV3(context);
  const candidate = request(config);
  const copiedBadHash = request(config, v3, { hash: "0".repeat(64) });
  await provision(state, context, copiedBadHash);
  await assert.rejects(insertRuntime(state, context, copiedBadHash), boundedSnapshotError);
  await provision(state, context, candidate);
  await assert.rejects(insertRuntime(state, context, copiedBadHash), boundedSnapshotError);
  await assert.rejects(
    insertRuntime(state, context, request({ ...config, seed: 43 })),
    boundedSnapshotError,
  );
  await assert.rejects(
    insertRuntime(state, context, {
      ...candidate,
      baselineEnd: candidate.openingAt,
    }),
    { code: "23514", message: "Invalid source calendar" },
  );
}

async function testUnsupportedVersion(state) {
  const context = await contextFor(state, "unsupported");
  const candidate = request({ ...configV3(context) }, "mock-source-v4");
  await provision(state, context, candidate);
  await assert.rejects(insertRuntime(state, context, candidate), boundedSnapshotError);
  assert.equal((await claim(state.worker, context)).rowCount, 0);
}

async function testTypedGeneration(state) {
  const context = await contextFor(state, "typed-v3");
  const { scope, grant } = context;
  const config = { ...configV3(context), profile: "new" };
  config.scenarioPlan = scenarioFor(config);
  const candidate = request(sortKeys(config));
  await provision(state, context, candidate);
  const result = await state.typedWorker.initializeGeneration({ grantId: grant }, scope);
  assert.equal(result.status, "CREATED");
  const { createdAt, ...generation } = result.generation;
  assert.match(createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  assert.deepEqual(generation, {
    scope,
    sourceConfig: config,
    configHash: candidate.hash,
    generatorVersion: v3,
    runtimeVersion: "mock-runtime-v2",
    openingAt: candidate.openingAt,
    baselineEnd: candidate.baselineEnd,
  });
  assert.deepEqual(await state.typedReader.findGeneration(readerActor, scope), result.generation);
  assert.deepEqual(await state.typedWorker.initializeGeneration({ grantId: grant }, scope), {
    status: "EXISTS",
    generation: result.generation,
  });
}

async function testRejectedTypedGenerations(state) {
  const context = await contextFor(state, "invalid-typed-v3");
  const { scope, grant } = context;
  const config = configV3(context);
  const candidate = request(config);
  const omittedPlan = { ...config };
  delete omittedPlan.scenarioPlan;
  const candidates = [
    { ...candidate, json: JSON.stringify(omittedPlan) },
    { ...candidate, json: JSON.stringify({ ...config, modelVersion: "other" }) },
    {
      ...candidate,
      json: JSON.stringify({
        ...config,
        scenarioPlan: { ...scenarioFor(config), externalStoreId: "another-store" },
      }),
    },
    { ...candidate, hash: "0".repeat(64) },
    request(config, "mock-source-v4"),
    { ...request(configFor(scope), "mock-source-v1"), version: v3, hash: candidate.hash },
  ];
  for (const invalid of candidates) {
    await provision(state, context, invalid);
    await assert.rejects(state.typedWorker.initializeGeneration({ grantId: grant }, scope), {
      code: "SOURCE_INTEGRITY",
      message: "SOURCE_INTEGRITY",
    });
    assert.equal(await state.typedReader.findGeneration(readerActor, scope), null);
  }
}

async function testRestrictedRole(state) {
  const context = await contextFor(state, "authority");
  const candidate = request(configV3(context));
  await provision(state, context, candidate);
  await assert.rejects(insertRuntime(state, context, candidate, "source-grant-b"), {
    code: "SM001",
    message: "Source control access denied",
  });
  await assert.rejects(
    sourceTransaction(
      state.worker,
      context.scope,
      "CLAIM",
      () =>
        state.worker.query(
          `INSERT INTO mock_platform."BuildJob"
            ("sessionId",generation,"organizationId","workspaceId","storeId","connectionId","externalStoreId","leaseOwner","generatorVersion")
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [...scopeValues(context.scope), randomUUID(), v3],
        ),
      null,
      context.grant,
    ),
    { code: "42501" },
  );
}

async function testHelperAccess(state) {
  const signatures = [
    "mock_platform.observed_config_json(jsonb)",
    "mock_platform.observed_config_properties(jsonb,text[])",
    "mock_platform.observed_config_scenario_json(jsonb)",
    "mock_platform.observed_config_shape(jsonb,jsonb)",
  ];
  const sql = "SELECT has_function_privilege(current_user, $1, 'EXECUTE') AS allowed";
  for (const name of signatures) {
    assert.equal((await state.reader.query(sql, [name])).rows[0].allowed, false);
    assert.equal((await state.worker.query(sql, [name])).rows[0].allowed, true);
  }
}

async function testReplay(state) {
  for (const { context, candidate, bytes } of state.history) {
    assert.deepEqual(await historicBytes(state, context), bytes);
    assert.equal(
      (await certificates(state.reader, context)).rows[0].generatorVersion,
      candidate.version,
    );
    const frozen = await readerTransaction(state.reader, context, () =>
      state.reader.query(
        'SELECT "sourceConfig","configHash" FROM mock_platform."Runtime" WHERE "sessionId"=$1',
        [context.scope.sessionId],
      ),
    );
    assert.deepEqual(frozen.rows, [{ sourceConfig: candidate.config, configHash: candidate.hash }]);
  }
}

async function testSeededMigration(state) {
  const rows = (
    await state.admin.query(
      'SELECT migration_name FROM public."_prisma_migrations" WHERE migration_name=$1 AND finished_at IS NOT NULL',
      [state.deployed],
    )
  ).rows;
  assert.deepEqual(rows, [{ migration_name: state.deployed }]);
  schemaParity(state.url);
}

async function testLongNamespace(state) {
  const context = await contextFor(state, "wide-namespace", "𠮷".repeat(101));
  const candidate = request(configV3(context));
  await provision(state, context, candidate);
  await assert.rejects(insertRuntime(state, context, candidate), boundedSnapshotError);
}

async function testScenarioDelivery(state, delivery) {
  const context = await contextFor(state, delivery.kind.toLowerCase());
  const config = { ...configV3(context), profile: "new", historyStart: "2024-02-29T16:00:00.000Z" };
  config.scenarioPlan = { ...scenarioFor(config), delivery };
  const candidate = request(config);
  await provision(state, context, candidate);
  const stored = (await insertRuntime(state, context, candidate)).rows[0];
  assert.deepEqual(stored.sourceConfig.scenarioPlan.delivery, delivery);
  const calendar = await readerTransaction(state.reader, context, () =>
    state.reader.query(
      `SELECT "openingAt" AS opening, "baselineEnd" AS baseline
     FROM mock_platform."Runtime" WHERE "sessionId"=$1`,
      [context.scope.sessionId],
    ),
  );
  assert.deepEqual(calendar.rows, [
    {
      opening: new Date("2024-03-16T16:00:00.000Z"),
      baseline: new Date("2024-03-30T16:00:00.000Z"),
    },
  ]);
}

const disconnectSql = `UPDATE public."PlatformConnection" SET status='DISCONNECTED',generation=generation+1
  WHERE id=$1 RETURNING generation`;

async function disconnect(connection, context) {
  const result = await connection.query(disconnectSql, [context.scope.connectionId]);
  assert.deepEqual(result.rows, [{ generation: 1 }]);
}

async function runtimeCount(state, context) {
  const result = await state.admin.query(
    'SELECT count(*)::integer AS count FROM mock_platform."Runtime" WHERE "sessionId"=$1',
    [context.scope.sessionId],
  );
  return result.rows[0].count;
}

async function testControlFirst(state) {
  const context = await contextFor(state, "control-first");
  const candidate = request(configV3(context));
  await provision(state, context, candidate);
  await beginControl(state.control, context.scope.sessionId);
  const pending = outcome(insertRuntime(state, context, candidate));
  try {
    await waitLock(state.admin, CONTROL, false, state.worker.processID);
    await disconnect(state.control, context);
    await state.control.query("COMMIT");
    const { error } = await pending;
    assert.equal(error?.code, "SM001");
    assert.equal(await runtimeCount(state, context), 0);
  } finally {
    await state.control.query("ROLLBACK");
    await pending;
  }
}

async function testAdmissionFirst(state) {
  const context = await contextFor(state, "admission-first");
  const candidate = request(configV3(context));
  await provision(state, context, candidate);
  await beginWorker(state.worker, context.scope, context.grant);
  let pending;
  try {
    const inserted = await state.worker.query(runtimeSql, runtimeValues(context, candidate));
    assert.equal(inserted.rowCount, 1);
    pending = outcome(
      operatorControl(state.control, disconnectSql, [context.scope.connectionId], context.scope),
    );
    await waitLock(state.admin, CONTROL, false, state.control.processID);
    await state.worker.query("COMMIT");
    const { error, result } = await pending;
    assert.ifError(error);
    assert.deepEqual(result.rows, [{ generation: 1 }]);
    assert.equal(await runtimeCount(state, context), 1);
  } finally {
    await state.worker.query("ROLLBACK");
    await pending;
  }
}

async function leaseTimeRemaining(state, context) {
  const result = await state.admin.query(
    "SELECT extract(epoch FROM $1::timestamptz-clock_timestamp())*1000 AS remaining",
    [context.job.leaseUntil.toISOString()],
  );
  return Number(result.rows[0].remaining);
}

async function waitForLeaseExpiry(state, context) {
  const remaining = await leaseTimeRemaining(state, context);
  assert.ok(remaining > 0, "lease must be live while the publication is blocked");
  await delay(remaining + 50);
  assert.ok((await leaseTimeRemaining(state, context)) <= 0);
}

async function testLeaseExpiresWhilePublishing(state) {
  const context = await contextFor(state, "expires");
  const candidate = request(configV3(context));
  await provision(state, context, candidate);
  assert.equal((await insertRuntime(state, context, candidate)).rowCount, 1);
  context.job = (await claim(state.worker, context)).rows[0];
  await seal(state.worker, context, [eventFor(context)]);
  await beginControl(state.control, context.scope.sessionId);
  await beginOperation(state.worker, context, "PUBLISH");
  await state.worker.query("SET LOCAL statement_timeout='50s'");
  await state.worker.query("SET LOCAL lock_timeout='45s'");
  await publishSettings(state.worker, context.job);
  const pending = outcome(updatePublish(state.worker, context));
  try {
    await waitLock(state.admin, CONTROL, false, state.worker.processID);
    await waitForLeaseExpiry(state, context);
    await state.control.query("COMMIT");
    const { error } = await pending;
    assert.equal(error?.code, "SM003");
  } finally {
    await state.control.query("ROLLBACK");
    await pending;
    await state.worker.query("ROLLBACK");
  }
  assert.equal((await certificates(state.reader, context)).rowCount, 0);
  assert.equal((await visibleVersions(state.reader, context)).rowCount, 0);
}

function registerConfigurationCases(state) {
  for (const [label, patch] of invalidRoot) {
    test(`strict v3 rejects ${label}`, () =>
      rejectConfig(state, label, (config) => ({ ...config, ...patch })));
  }
  for (const [label, patch] of invalidPlans) {
    test(`strict v3 rejects ${label}`, () =>
      rejectConfig(state, label, (config) => ({
        ...config,
        scenarioPlan: { ...scenarioFor(config), ...patch },
      })));
  }
  test("strict v3 rejects extra binding fields", () =>
    rejectConfig(state, "extra binding", (c) => ({
      ...c,
      binding: { ...c.binding, token: "private" },
    })));
  test("v3 requires a scenario key even for a planless generation", () =>
    testAbsentScenario(state));
  test("v3 rejects the superseded sorted-key digest for an otherwise valid plan", () =>
    testSortedDigest(state));
  test("strict v3 enforces the UTF-16 namespace limit", () => testLongNamespace(state));
  for (const delivery of [{ kind: "NORMAL" }, { kind: "REPLAY_SAVED_PAGE", repetitions: 3 }]) {
    test(`strict v3 admits ${delivery.kind} and derives new-profile leap-year dates`, () =>
      testScenarioDelivery(state, delivery));
  }
}

function registerRestrictedCases() {
  const state = { clients: [] };
  before(() => prepare(state));
  after(() => shutdown(state));
  test("Prisma deploy upgrades the seeded database with no schema drift", () =>
    testSeededMigration(state));
  test("v3 admits the contract digest and explicit null scenario and publishes six transport kinds", () =>
    testV3Publication(state));
  test("v3 digests Unicode, reordered keys and normalized integers in the contract declaration order", () =>
    testPlanVector(state));
  test("v3 rejects copied or forged hashes and derived dates", () => testMismatchedSnapshot(state));
  test("only known generator versions can create a Runtime or build", () =>
    testUnsupportedVersion(state));
  test("typed worker initializes and reader reloads an explicitly provisioned v3 snapshot", () =>
    testTypedGeneration(state));
  test("typed initialization rejects malformed, mismatched and unknown frozen snapshots", () =>
    testRejectedTypedGenerations(state));
  test("existing scoped grants and derived-only BuildJob columns control admission", () =>
    testRestrictedRole(state));
  test("the internal codecs are executable only by the source worker capability", () =>
    testHelperAccess(state));
  test("the seeded upgrade replays exact historical v1 and v2 certificate and payload bytes", () =>
    testReplay(state));
  registerConfigurationCases(state);
  test("a committed disconnect blocks a waiting v3 admission", () => testControlFirst(state));
  test("a v3 admission holding the control lock commits before disconnect", () =>
    testAdmissionFirst(state));
  test("a v3 publication rechecks wall-clock lease expiry after the control lock wait", () =>
    testLeaseExpiresWhilePublishing(state));
}

if (restricted) registerRestrictedCases();

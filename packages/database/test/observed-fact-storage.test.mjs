import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import process from "node:process";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import pg from "pg";
import { requireIsolatedDatabaseUrl } from "./helpers/isolated-postgres.mjs";
import { configFor, hashConfig } from "./helpers/mock-platform-fixture.mjs";
import { beginControl, operatorControl } from "./helpers/mock-source-control-fixture.mjs";

const root = new URL("../", import.meta.url);
const migrations = new URL("prisma/migrations/", root);
const mode = "--restricted-observed-storage";
const observedMigration = /^\d{14}_observed_fact_storage$/u;
const tables = [
  "observed_scopes",
  "observed_page_receipts",
  "observed_facts",
  "observed_receipt_members",
];
const grantTable = "observed_principal_grants";
const capabilityRoles = [
  "shopmate_observed_publisher",
  "shopmate_observed_consumer",
  "shopmate_observed_reader",
  "shopmate_observed_definition_provisioner",
];
const guardRole = "shopmate_observed_guard";
const principal = "observed-operator";

const modelVersion = "mock-business-observed-v1";
const hash = "a".repeat(64);
const periodStart = "2026-10-10T16:00:00.000Z";
const periodEnd = "2026-10-11T16:00:00.000Z";
const subject = { kind: "SKU", externalSkuId: "sku/甲" };
const binding = {
  organizationId: "legacy-org-observed-a",
  workspaceId: "legacy-workspace-observed-a",
  storeId: "observed-store-a",
  connectionId: "observed-connection-a",
  externalStoreId: "shop/甲",
};

test("observed fact storage has one additive migration with mapped history and grants", async () => {
  const names = (await readdir(migrations)).filter((name) => observedMigration.test(name));
  assert.equal(names.length, 1);
  const sql = await readFile(new URL(`${names[0]}/migration.sql`, migrations), "utf8");
  const prisma = await readFile(new URL("prisma/schema.prisma", root), "utf8");
  for (const table of [...tables, grantTable]) {
    assert.ok(sql.includes(`CREATE TABLE public.${table}`), table);
    assert.ok(prisma.includes(`@@map("${table}")`), table);
  }
});

function prisma(url, args) {
  return execFileSync(
    process.execPath,
    [fileURLToPath(new URL("node_modules/prisma/build/index.js", root)), ...args],
    {
      cwd: fileURLToPath(root),
      env: { ...process.env, DATABASE_URL: url, DOTENV_CONFIG_OVERRIDE: "false" },
      encoding: "utf8",
      windowsHide: true,
      stdio: "pipe",
    },
  );
}

async function seedBinding(client, scope = binding, merchant = "observed-a") {
  await client.query(
    'INSERT INTO public."Merchant" (id, name, slug, "updatedAt") VALUES ($1, $1, $1, now())',
    [merchant],
  );
  await client.query(
    `INSERT INTO public."Store" (id, "merchantId", name, city, platform, "organizationId", "workspaceId")
     VALUES ($1, $2, $1, $3, $4, $5, $6)`,
    [scope.storeId, merchant, "Shanghai", "MOCK", scope.organizationId, scope.workspaceId],
  );
  await client.query(
    `INSERT INTO public."PlatformConnection"
     (id, "organizationId", "workspaceId", "storeId", "externalStoreId", generation)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      scope.connectionId,
      scope.organizationId,
      scope.workspaceId,
      scope.storeId,
      scope.externalStoreId,
      7,
    ],
  );
}

async function insertScope(client, fields = {}, generation = 7) {
  const b = { ...binding, ...fields };
  return (
    await client.query(
      `INSERT INTO public.observed_scopes
     ("organizationId", "workspaceId", "storeId", "connectionId", "externalStoreId", generation)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING "scopeId"`,
      [b.organizationId, b.workspaceId, b.storeId, b.connectionId, b.externalStoreId, generation],
    )
  ).rows[0].scopeId;
}

const insertReceiptSql = `INSERT INTO public.observed_page_receipts
  ("scopeId", "receiptId", domain, "subjectKind", "subjectId", "periodStart", "periodEnd",
   through, "modelVersion", "configHash", "publicationId", "publicationHash", "pageId", "pageIndex",
   "pageHash", "priorPageHash", "expectedCursor", "nextCursor", "terminalCoverageBps",
   "recordCount", "recordedAt")
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
  RETURNING "receiptKey", "recordedAt"`;

const receiptDefaults = {
  domain: "PRICE",
  subjectKind: subject.kind,
  subjectId: subject.externalSkuId,
  pageIndex: 0,
  priorPageHash: null,
  expectedCursor: null,
  nextCursor: null,
  terminalCoverageBps: 10000,
  periodStart,
  periodEnd,
  through: periodEnd,
  recordedAt: periodStart,
  configHash: hash,
  publicationHash: hash,
  pageHash: hash,
};

async function insertReceipt(client, scopeId, id, count, fields = {}) {
  const r = {
    ...receiptDefaults,
    publicationId: `publication-${id}`,
    pageId: `page-${id}`,
    ...fields,
  };
  return (
    await client.query(insertReceiptSql, [
      scopeId,
      id,
      r.domain,
      r.subjectKind,
      r.subjectId,
      r.periodStart,
      r.periodEnd,
      r.through,
      modelVersion,
      r.configHash,
      r.publicationId,
      r.publicationHash,
      r.pageId,
      r.pageIndex,
      r.pageHash,
      r.priorPageHash,
      r.expectedCursor,
      r.nextCursor,
      r.terminalCoverageBps,
      count,
      r.recordedAt,
    ])
  ).rows[0];
}

function priceFact(factId, sequence, priorSequence = null, fields = {}) {
  const generation = fields.generation ?? 7;
  const entity = fields.subject ?? subject;
  return {
    schemaVersion: 1,
    ledgerVersion: "observed-facts-v1",
    binding,
    generation,
    domain: "PRICE",
    subject: entity,
    factId,
    sequence,
    priorVersion: priorSequence === null ? null : `observed-v1:g:${generation}:e:${priorSequence}`,
    sourceVersion: `observed-v1:g:${generation}:e:${sequence}`,
    producerVersion: "producer-实",
    modelVersion,
    occurredAt: periodStart,
    observedAt: periodStart,
    payload: {
      externalSkuId: entity.externalSkuId,
      effectiveAt: periodStart,
      priorPriceMinor: 1500,
      priceMinor: 1200,
      priceVersion: "price/第一版",
      currency: "CNY",
    },
    payloadHash: hash,
    ...fields,
  };
}

function subjectId(entity) {
  return entity.externalSkuId ?? entity.externalCampaignId ?? entity.connectionId ?? "";
}

async function insertFact(
  client,
  scopeId,
  receipt,
  fact,
  priorSequence = null,
  bytes = factBytes(fact),
) {
  return (
    await client.query(
      `INSERT INTO public.observed_facts
     ("scopeId", domain, "subjectKind", "subjectId", "factId", sequence, "priorSequence",
      "producerVersion", "modelVersion", "occurredAt", "observedAt", "payloadHash", payload,
      "originReceiptKey", "factBytes")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING "factKey"`,
      [
        scopeId,
        fact.domain,
        fact.subject.kind,
        subjectId(fact.subject),
        fact.factId,
        fact.sequence,
        priorSequence,
        fact.producerVersion,
        fact.modelVersion,
        fact.occurredAt,
        fact.observedAt,
        fact.payloadHash,
        JSON.stringify(fact.payload),
        receipt.receiptKey,
        bytes,
      ],
    )
  ).rows[0].factKey;
}

function factBytes(fact) {
  return Buffer.from(JSON.stringify(fact, null, 2), "utf8");
}

function member(client, scopeId, receipt, factKey, ordinal, fact = priceFact("member", 1)) {
  return client.query(
    `INSERT INTO public.observed_receipt_members
     ("receiptKey", ordinal, "factKey", "scopeId", domain, "subjectKind", "subjectId")
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      receipt.receiptKey,
      ordinal,
      factKey,
      scopeId,
      fact.domain,
      fact.subject.kind,
      subjectId(fact.subject),
    ],
  );
}

async function transaction(client, callback) {
  await client.query("BEGIN");
  try {
    const value = await callback();
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function insertOrigin(client, scopeId, id, fact, priorSequence = null, window = {}) {
  const receipt = await insertReceipt(client, scopeId, id, 1, {
    ...factPartition(fact),
    ...window,
  });
  const factKey = await insertFact(client, scopeId, receipt, fact, priorSequence);
  await member(client, scopeId, receipt, factKey, 0, fact);
  return { receipt, factKey };
}

function factPartition(fact) {
  return {
    domain: fact.domain,
    subjectKind: fact.subject.kind,
    subjectId: subjectId(fact.subject),
  };
}

const readMembers = `
  SELECT f."factId", f.sequence::text, f."priorSequence"::text, f."factBytes", f.payload,
         r."receiptId", r."recordedAt", origin."receiptId" AS "originReceiptId",
         origin."recordedAt" AS "originRecordedAt"
  FROM public.observed_receipt_members AS m
  JOIN public.observed_facts AS f USING ("factKey")
  JOIN public.observed_page_receipts AS r USING ("receiptKey")
  JOIN public.observed_page_receipts AS origin ON origin."receiptKey"=f."originReceiptKey"
  WHERE m."scopeId"=$1 ORDER BY r."receiptId", m.ordinal`;

async function readFromNewConnection(url, scopeId) {
  const reader = new pg.Client({ connectionString: url });
  await reader.connect();
  try {
    return (await reader.query(readMembers, [scopeId])).rows;
  } finally {
    await reader.end();
  }
}

function registerStorageCases() {
  const state = {};
  before(async () => prepareDatabase(state));
  after(async () => closeDatabase(state));
  test("fresh migration matches the Prisma schema", () => schemaParity(state));
  test("storage accepts an original edge, later publication and correction across reconnect", () =>
    roundTrip(state));
  test("storage binds all five connector identities and retains distinct generations", () =>
    bindingKeys(state));
  test("scope, subject and domain cannot be relabeled by membership", () => wrongMembership(state));
  test("receipts require a scope visible to their insert trigger", () =>
    receiptScopeVisibility(state));
  test("facts require a scope visible to their byte validation trigger", () =>
    factScopeVisibility(state));
  test("a fact must have its original membership at commit", () => missingOrigin(state));
  test("committed receipts require bounded, gapless, ordered, distinct membership", () =>
    invalidMemberships(state));
  test("only an earlier same-fact predecessor is valid, with one root and one successor", () =>
    invalidCorrections(state));
  test("the retained UTF-8 fact has exactly the stored envelope and payload", () =>
    invalidFactBytes(state));
  test("all historical rows reject update, delete and truncate", () => immutableHistory(state));
  test("receipt metadata enforces window, hash and page identity bounds", () =>
    receiptMetadata(state));
  test("maximum-width opaque identities compare exactly without overflowing indexes", () =>
    wideIdentities(state));
  registerPayloadCases(state, financePayloadCases);
  registerPayloadCases(state, measurementPayloadCases);
  registerPayloadCases(state, catalogPayloadCases);
  registerPayloadCases(state, inventoryPayloadCases);
  registerPayloadCases(state, [syncPayloadCase]);
  test("sync transition and receipt subjects match the exact binding connection", () =>
    syncConnectionIdentity(state));
  registerMeasurementMemberships(state);
  registerAuthorityCases(state);
}

function validatedRunnerUrl(value) {
  try {
    return requireIsolatedDatabaseUrl(value);
  } catch {
    throw new Error("Restricted observed storage requires a runner-issued loopback database");
  }
}

async function prepareDatabase(state) {
  const validated = validatedRunnerUrl(process.env.TEST_DATABASE_URL);
  const { AppendObservedPageV1Schema, ObservedFactV1Schema } = await import("@shopmate/contracts");
  state.appendSchema = AppendObservedPageV1Schema;
  state.factSchema = ObservedFactV1Schema;
  state.server = new pg.Client({ connectionString: validated });
  await state.server.connect();
  Object.assign(state, await createDisposableDatabase(state.server, validated));
  prisma(state.url, ["migrate", "deploy"]);
  state.client = new pg.Client({ connectionString: state.url });
  await state.client.connect();
  await state.client.query("SELECT pg_catalog.set_config('TimeZone',$1,false)", [
    "Pacific/Auckland",
  ]);
  await seedBinding(state.client);
}

async function createDisposableDatabase(server, validated) {
  // This identifier is locally generated as SQL DDL cannot bind identifiers.
  const name = `shopmate_tenant_test_${randomBytes(8).toString("hex")}`;
  const testUrl = new URL(validated);
  testUrl.pathname = `/${name}`;
  const url = requireIsolatedDatabaseUrl(testUrl.toString());
  await server.query(`CREATE DATABASE "${name}"`);
  return { name, url };
}

function schemaParity({ url }) {
  const diff = prisma(url, [
    "migrate",
    "diff",
    "--from-config-datasource",
    "--to-schema",
    "prisma/schema.prisma",
    "--exit-code",
    "--script",
  ]);
  assert.match(diff, /empty migration/u);
}

async function closeDatabase({ client, server, name, logins = [] }) {
  try {
    if (client) await client.end();
    if (name) await server.query(`DROP DATABASE "${name}"`);
    for (const login of logins) await server.query(`DROP ROLE "${login}"`);
  } finally {
    if (server) await server.end();
  }
}

function registerAuthorityCases(state) {
  test("observed roles are safe and only private policies can read forced-RLS storage", () =>
    roleCatalog(state));
  test("operator grants bind an actual login and scoped membership to exact domains", () =>
    operatorGrants(state));
  test("each runtime capability denies raw storage and grant provisioning", () =>
    rawStorageDenial(state));
  test("restricted authority accepts each scoped capability and checks login, domain and generation", () =>
    scopedAuthority(state));
  test("restricted authority revalidates live tenant, membership and grant state", () =>
    liveAuthority(state));
  test("grant revocation committed first denies a waiting authority check", () =>
    revokeBeforeAuthority(state));
  test("generation reset committed first denies a waiting authority check", () =>
    resetBeforeAuthority(state));
  test("authority locks serialize concurrent generation, grant and membership changes", () =>
    authorityBeforeChanges(state));
  test("authority denies a grant that expires while waiting on its locked row", () =>
    expiryWhileWaiting(state));
  test("authorized restricted inserts enforce immutable receipt graph at actual commit", () =>
    restrictedGraph(state));
  test("seeded upgrade rejects unsafe guard authority and preserves existing tenant data", () =>
    seededUpgrade(state));
}

async function roleCatalog({ client }) {
  const roles = [...capabilityRoles, guardRole];
  const result = await client.query(
    `SELECT rolname, NOT (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb
       OR rolcreaterole OR rolreplication) AS safe
     FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname`,
    [roles],
  );
  assert.deepEqual(
    result.rows,
    roles.sort().map((rolname) => ({ rolname, safe: true })),
  );
  const policies = await client.query(
    `SELECT c.relname, c.relrowsecurity AND c.relforcerowsecurity AS forced,
       EXISTS (SELECT FROM pg_catalog.aclexplode(c.relacl) WHERE grantee=0) AS public
     FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname`,
    [[...tables, grantTable]],
  );
  assert.deepEqual(
    policies.rows,
    [...tables, grantTable].sort().map((relname) => ({ relname, forced: true, public: false })),
  );
  const privateMembership = await client.query(
    `SELECT count(*)::integer AS count FROM pg_catalog.pg_auth_members m
     WHERE m.roleid=$1::regrole OR m.member=ANY($2::regrole[])`,
    [guardRole, roles],
  );
  assert.equal(privateMembership.rows[0].count, 0);
}

async function restrictedLogin(state, capability) {
  const name = `observed_test_${randomBytes(12).toString("hex")}`;
  const password = randomBytes(32).toString("hex");
  const { rows } = await state.client.query(
    `SELECT pg_catalog.format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
      $1::text,$2::text) AS command`,
    [name, password],
  );
  await state.client.query(rows[0].command);
  (state.logins ??= []).push(name);
  if (capability) {
    assert.ok(capabilityRoles.includes(capability));
    await state.client.query(`GRANT "${capability}" TO "${name}"`);
  }
  const url = new URL(state.url);
  url.username = name;
  url.password = password;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  assert.equal((await client.query("SELECT SESSION_USER AS login")).rows[0].login, name);
  return { client, name };
}

async function seedMember(client, userId, role = "OPERATOR", scope = binding) {
  await client.query(
    `INSERT INTO public."OrganizationMember"(id,"organizationId","userId",role,"updatedAt")
     VALUES ($1,$2,$1,$3,clock_timestamp())`,
    [userId, scope.organizationId, role],
  );
  await client.query(
    `INSERT INTO public."WorkspaceMember"(id,"organizationId","workspaceId","userId")
     VALUES ($1,$2,$3,$1)`,
    [userId, scope.organizationId, scope.workspaceId],
  );
}

async function putGrant(client, scopeId, login, fields = {}) {
  const grant = {
    organizationId: binding.organizationId,
    userId: principal,
    capability: "PUBLISH",
    domains: ["PRICE"],
    ...fields,
  };
  const { rows } = await client.query(
    `INSERT INTO public.observed_principal_grants
     ("scopeId","organizationId","databaseRole","principalUserId",capability,"allowedDomains","expiresAt")
     VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '1 hour') RETURNING "grantId"`,
    [scopeId, grant.organizationId, login, grant.userId, grant.capability, grant.domains],
  );
  return rows[0].grantId;
}

async function operatorGrants(state) {
  const { client } = state;
  const login = await restrictedLogin(state, capabilityRoles[0]);
  try {
    const scopeId = await insertScope(client, {}, 101);
    await seedMember(client, principal);
    for (const fields of [
      { domains: [] },
      { domains: ["PRICE", "PRICE"] },
      { domains: ["PRICE", null] },
      { domains: ["UNKNOWN"] },
    ])
      await assert.rejects(putGrant(client, scopeId, login.name, fields), { code: "23514" });
    await assert.rejects(putGrant(client, scopeId, login.name, { capability: "READ" }), {
      code: "23514",
    });
    await assert.rejects(putGrant(client, scopeId, "observed_missing_login"), { code: "23514" });
    await assert.rejects(putGrant(client, scopeId, login.name, { userId: "unknown" }), {
      code: "23503",
    });
    assert.match(await putGrant(client, scopeId, login.name), /^[\da-f-]{36}$/u);
  } finally {
    await login.client.end();
  }
}

async function rawStorageDenial(state) {
  for (const capability of capabilityRoles) {
    const { client } = await restrictedLogin(state, capability);
    try {
      for (const table of [...tables, grantTable]) {
        for (const statement of [
          `SELECT * FROM public.${table}`,
          `INSERT INTO public.${table} DEFAULT VALUES`,
          `UPDATE public.${table} SET "scopeId"=$1 WHERE false`,
          `DELETE FROM public.${table} WHERE false`,
          `TRUNCATE public.${table}`,
        ]) {
          const parameters = statement.includes("$1")
            ? ["00000000-0000-0000-0000-000000000000"]
            : [];
          await assert.rejects(client.query(statement, parameters), { code: "42501" });
        }
      }
      await assert.rejects(client.query(`SET ROLE ${guardRole}`), { code: "42501" });
    } finally {
      await client.end();
    }
  }
}

const capabilities = ["PUBLISH", "CONSUME", "READ", "PROVISION_DEFINITION"];
const authorityDenied = { code: "42501", message: "Observed scope access denied" };
const authoritySql =
  "SELECT public.observed_authorize($1::uuid,$2::text,$3::text,$4::text,$5::text)";

async function authorityFixture(state, index = 0, role = "OPERATOR", domains = ["PRICE"]) {
  const merchant = `observed-${randomBytes(6).toString("hex")}`;
  const scope = {
    organizationId: `legacy-org-${merchant}`,
    workspaceId: `legacy-workspace-${merchant}`,
    storeId: `store-${merchant}`,
    connectionId: `connection-${merchant}`,
    externalStoreId: `shop/${merchant}`,
  };
  await seedBinding(state.client, scope, merchant);
  const scopeId = await insertScope(state.client, scope);
  const userId = `user-${merchant}`;
  await seedMember(state.client, userId, role, scope);
  const login = await restrictedLogin(state, capabilityRoles[index]);
  const grant = {
    organizationId: scope.organizationId,
    userId,
    capability: capabilities[index],
    domains,
  };
  try {
    const grantId = await putGrant(state.client, scopeId, login.name, grant);
    return { ...login, ...grant, scopeId, scope, grantId, merchant, admin: state.client };
  } catch (error) {
    await login.client.end();
    throw error;
  }
}

function authorize(fixture, fields = {}) {
  const {
    client,
    scopeId,
    userId,
    capability,
    domain = "PRICE",
    grantId,
  } = { ...fixture, ...fields };
  return client.query(authoritySql, [scopeId, userId, capability, domain, grantId]);
}

async function scopedAuthority(state) {
  for (const [index, capability] of capabilities.entries()) {
    const fixture = await authorityFixture(state, index, index === 2 ? "VIEWER" : "OPERATOR");
    try {
      assert.equal(
        (await authorize(fixture, { grantId: index < 2 ? fixture.grantId : null })).rowCount,
        1,
      );
      if (index < 2) await requiresExplicitGrant(fixture);
      for (const other of capabilities.filter((candidate) => candidate !== capability)) {
        await assert.rejects(authorize(fixture, { capability: other }), authorityDenied);
      }
      await assert.rejects(authorize(fixture, { domain: "LISTING" }), authorityDenied);
      await assert.rejects(authorize(fixture, { userId: principal }), authorityDenied);
      await assert.rejects(authorize(fixture, { domain: null }), authorityDenied);
      if (index === 0) {
        await mismatchedAuthority(state, fixture);
        await crossBindingAuthority(state, fixture);
        await unsafeSchemaAuthority(state, fixture);
      }
    } finally {
      await fixture.client.end();
    }
  }
}

async function requiresExplicitGrant(fixture) {
  const { client, scopeId, userId, capability } = fixture;
  await assert.rejects(authorize(fixture, { grantId: null }), authorityDenied);
  await assert.rejects(
    client.query("SELECT public.observed_authorize($1::uuid,$2::text,$3::text,$4::text)", [
      scopeId,
      userId,
      capability,
      "PRICE",
    ]),
    authorityDenied,
  );
}

async function mismatchedAuthority(state, fixture) {
  const { admin, scope, name, client } = fixture;
  const oldScope = await insertScope(admin, scope, 6);
  const oldGrant = await putGrant(admin, oldScope, name, fixture);
  await assert.rejects(
    authorize(fixture, { scopeId: oldScope, grantId: oldGrant }),
    authorityDenied,
  );
  await assert.rejects(authorize(fixture, { grantId: oldGrant }), authorityDenied);
  await assert.rejects(authorize(fixture, { grantId: "malformed" }), authorityDenied);
  const other = await restrictedLogin(state, capabilityRoles[0]);
  try {
    await other.client.query("SELECT set_config('app.user_id',$1,false)", [fixture.userId]);
    await assert.rejects(authorize(fixture, { client: other.client }), authorityDenied);
  } finally {
    await other.client.end();
  }
  await assert.rejects(
    client.query("SELECT public.observed_login_safe($1,$2)", [name, "PUBLISH"]),
    {
      code: "42501",
    },
  );
  await client.query(`SET ROLE ${capabilityRoles[0]}`);
  await assert.rejects(authorize(fixture), authorityDenied);
  await client.query("RESET ROLE");
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  await assert.rejects(authorize(fixture), authorityDenied);
  await client.query("ROLLBACK");
  await admin.query(`GRANT pg_write_all_data TO "${name}"`);
  await assert.rejects(authorize(fixture), authorityDenied);
  await admin.query(`REVOKE pg_write_all_data FROM "${name}"`);
}

async function crossBindingAuthority(state, fixture) {
  const target = await authorityFixture(state);
  try {
    assert.equal((await authorize(target)).rowCount, 1);
    await assert.rejects(authorize(target, { client: fixture.client }), authorityDenied);
    assert.equal((await authorize(fixture)).rowCount, 1);
  } finally {
    await target.client.end();
  }
}

async function unsafeSchemaAuthority(state, fixture) {
  const { admin, name } = fixture;
  const group = "shopmate_observed_test_schema_creator";
  await admin.query(`CREATE ROLE ${group} NOLOGIN`);
  state.logins.push(group);
  await admin.query(`GRANT ${group} TO "${name}"`);
  for (const role of [name, group]) {
    await admin.query(`GRANT CREATE ON SCHEMA public TO "${role}"`);
    try {
      await assert.rejects(authorize(fixture), authorityDenied);
    } finally {
      await admin.query(`REVOKE CREATE ON SCHEMA public FROM "${role}"`);
    }
    assert.equal((await authorize(fixture)).rowCount, 1);
  }
}

async function liveAuthority(state) {
  const f = await authorityFixture(state);
  const { admin, client, scope, userId, grantId, merchant } = f;
  const cases = [
    ['public."Organization"', "status", "id", scope.organizationId, "SUSPENDED", "ACTIVE"],
    ['public."Workspace"', "status", "id", scope.workspaceId, "SUSPENDED", "ACTIVE"],
    ['public."Merchant"', "status", "id", merchant, "INACTIVE", "ACTIVE"],
    ['public."OrganizationMember"', "status", "id", userId, "INACTIVE", "ACTIVE"],
    ['public."WorkspaceMember"', "status", "id", userId, "INACTIVE", "ACTIVE"],
    ['public."OrganizationMember"', "role", "id", userId, "VIEWER", "OPERATOR"],
    ["public.observed_principal_grants", "active", "grantId", grantId, false, true],
  ];
  try {
    for (const [table, column, key, id, inactive, restored] of cases) {
      const change = `UPDATE ${table} SET "${column}"=$2 WHERE "${key}"=$1`;
      assert.equal((await admin.query(change, [id, inactive])).rowCount, 1);
      await assert.rejects(authorize(f), authorityDenied);
      await admin.query(change, [id, restored]);
      assert.equal((await authorize(f)).rowCount, 1);
    }
    await disconnectedAuthority(f);
    await admin.query(
      'UPDATE public.observed_principal_grants SET "expiresAt"=clock_timestamp() WHERE "grantId"=$1',
      [grantId],
    );
    await assert.rejects(authorize(f), authorityDenied);
  } finally {
    await client.end();
  }
}

async function seedSourceControl({ admin, scope, merchant, userId }) {
  const sessionId = `session-${merchant}`;
  const operator = `${userId}-owner`;
  const config = configFor(scope);
  await seedMember(admin, operator, "OWNER", scope);
  await admin.query('INSERT INTO public."DemoTenant"("organizationId") VALUES ($1)', [
    scope.organizationId,
  ]);
  await admin.query('UPDATE public."TenantBootstrapEnvironment" SET environment=$1 WHERE id=$2', [
    "DEMO",
    "singleton",
  ]);
  await admin.query(
    `INSERT INTO demo."DemoCommerceSession"
       (id,"organizationId","workspaceId","storeId","connectionId","externalStoreId",
        config,"configHash","generatorVersion","clockNow")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      sessionId,
      scope.organizationId,
      scope.workspaceId,
      scope.storeId,
      scope.connectionId,
      scope.externalStoreId,
      config,
      hashConfig(config),
      "mock-source-v1",
      config.historyStart,
    ],
  );
  return { sessionId, operator };
}

async function disconnectedAuthority(f) {
  const { operator, sessionId } = await seedSourceControl(f);
  const change = 'UPDATE public."PlatformConnection" SET status=$2 WHERE id=$1';
  await operatorControl(
    f.admin,
    change,
    [f.scope.connectionId, "DISCONNECTED"],
    { sessionId },
    operator,
  );
  await assert.rejects(authorize(f), authorityDenied);
  await operatorControl(f.admin, change, [f.scope.connectionId, "ACTIVE"], { sessionId }, operator);
  assert.equal((await authorize(f)).rowCount, 1);
}

const revokeGrant = 'UPDATE public.observed_principal_grants SET active=false WHERE "grantId"=$1';
const resetGeneration =
  'UPDATE public."PlatformConnection" SET generation=generation+1 WHERE id=$1';

async function waitForLock(observer, waiter, blocker, operation = "authority check") {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query(
      "SELECT $2::integer=ANY(pg_blocking_pids($1::integer)) AS blocked",
      [waiter.processID, blocker.processID],
    );
    if (rows[0].blocked) return;
    await delay(15);
  }
  assert.fail(`expected PostgreSQL to report a transaction lock for ${operation}`);
}

async function withLockFixture(state, check) {
  const f = await authorityFixture(state);
  const observer = new pg.Client({ connectionString: state.url });
  try {
    await observer.connect();
    for (const client of [f.client, f.admin]) {
      await client.query("SELECT set_config('statement_timeout',$1,false)", ["8s"]);
    }
    await check(f, observer);
  } finally {
    try {
      await f.client.end();
    } finally {
      await f.admin.query("ROLLBACK");
      await f.admin.query("RESET statement_timeout");
      await observer.end();
    }
  }
}

function revokeBeforeAuthority(state) {
  return withLockFixture(state, async (f, observer) => {
    await f.admin.query("BEGIN");
    await f.admin.query(revokeGrant, [f.grantId]);
    const denial = authorize(f).then(
      () => null,
      (error) => error,
    );
    await waitForLock(observer, f.client, f.admin);
    await f.admin.query("COMMIT");
    assert.match((await denial)?.message ?? "", /^Observed scope access denied$/u);
    assert.equal((await denial)?.code, "42501");
  });
}

function resetBeforeAuthority(state) {
  return withLockFixture(state, async (f, observer) => {
    const { operator, sessionId } = await seedSourceControl(f);
    await beginControl(f.admin, sessionId, operator);
    assert.equal((await f.admin.query(resetGeneration, [f.scope.connectionId])).rowCount, 1);
    await f.client.query("SET lock_timeout='200ms'");
    await assert.rejects(authorize(f, { domain: "LISTING" }), authorityDenied);
    await f.client.query("RESET lock_timeout");
    const denial = authorize(f).then(
      () => null,
      (error) => error,
    );
    await waitForLock(observer, f.client, f.admin);
    await f.admin.query("COMMIT");
    assert.match((await denial)?.message ?? "", /^Observed scope access denied$/u);
    assert.equal((await denial)?.code, "42501");
  });
}

function authorityBeforeChanges(state) {
  return withLockFixture(state, async (f, observer) => {
    const { operator, sessionId } = await seedSourceControl(f);
    await f.client.query("BEGIN");
    assert.equal((await authorize(f)).rowCount, 1);
    const changes = [
      [resetGeneration, f.scope.connectionId],
      [revokeGrant, f.grantId],
      ["UPDATE public.\"OrganizationMember\" SET status='INACTIVE' WHERE id=$1", f.userId],
      ["UPDATE public.\"WorkspaceMember\" SET status='INACTIVE' WHERE id=$1", f.userId],
    ];
    for (const [statement, parameter] of changes) {
      if (statement === resetGeneration) await beginControl(f.admin, sessionId, operator);
      else await f.admin.query("BEGIN");
      const mutation = f.admin.query(statement, [parameter]).then(
        (result) => result,
        (error) => ({ error }),
      );
      await waitForLock(observer, f.admin, f.client, statement);
      await f.client.query("COMMIT");
      const result = await mutation;
      if (result.error) throw result.error;
      assert.equal(result.rowCount, 1);
      await f.admin.query("ROLLBACK");
      await f.client.query("BEGIN");
      assert.equal((await authorize(f)).rowCount, 1);
    }
    await f.client.query("COMMIT");
    await f.admin.query(revokeGrant, [f.grantId]);
    await assert.rejects(authorize(f), authorityDenied);
  });
}

function expiryWhileWaiting(state) {
  return withLockFixture(state, async (f, observer) => {
    const expiry = `UPDATE public.observed_principal_grants
      SET "expiresAt"=clock_timestamp()+interval '3 seconds' WHERE "grantId"=$1`;
    await f.admin.query(expiry, [f.grantId]);
    await f.admin.query("BEGIN");
    await f.admin.query(
      'SELECT "grantId" FROM public.observed_principal_grants WHERE "grantId"=$1 FOR UPDATE',
      [f.grantId],
    );
    const denial = authorize(f).then(
      () => null,
      (error) => error,
    );
    await waitForLock(observer, f.client, f.admin);
    const live = await observer.query(
      `SELECT "expiresAt">clock_timestamp() AS live
      FROM public.observed_principal_grants WHERE "grantId"=$1`,
      [f.grantId],
    );
    assert.equal(live.rows[0].live, true);
    await observer.query(
      `SELECT pg_sleep(greatest(0,extract(epoch FROM "expiresAt"-clock_timestamp())))
      FROM public.observed_principal_grants WHERE "grantId"=$1`,
      [f.grantId],
    );
    await f.admin.query("COMMIT");
    assert.match((await denial)?.message ?? "", /^Observed scope access denied$/u);
    assert.equal((await denial)?.code, "42501");
  });
}

const fixtureWriter = "shopmate_observed_test_writer";
const fixturePrivileges = `
  GRANT USAGE ON SCHEMA public TO shopmate_observed_test_writer;
  GRANT SELECT ON public.observed_scopes TO shopmate_observed_test_writer;
  GRANT SELECT ("receiptKey") ON public.observed_page_receipts TO shopmate_observed_test_writer;
  GRANT SELECT ("factKey") ON public.observed_facts TO shopmate_observed_test_writer;
  GRANT INSERT ON public.observed_page_receipts,public.observed_facts,public.observed_receipt_members
    TO shopmate_observed_test_writer;
  CREATE POLICY observed_test_read ON public.observed_scopes FOR SELECT TO shopmate_observed_test_writer USING (true);
  CREATE POLICY observed_test_read ON public.observed_page_receipts FOR SELECT TO shopmate_observed_test_writer USING (true);
  CREATE POLICY observed_test_read ON public.observed_facts FOR SELECT TO shopmate_observed_test_writer USING (true);
  CREATE POLICY observed_test_insert ON public.observed_page_receipts FOR INSERT TO shopmate_observed_test_writer WITH CHECK (true);
  CREATE POLICY observed_test_insert ON public.observed_facts FOR INSERT TO shopmate_observed_test_writer WITH CHECK (true);
  CREATE POLICY observed_test_insert ON public.observed_receipt_members FOR INSERT TO shopmate_observed_test_writer WITH CHECK (true);
  GRANT EXECUTE ON FUNCTION public.observed_authorize(uuid,text,text,text,text),
    public.observed_fact_envelope(public.observed_facts,public.observed_scopes) TO shopmate_observed_test_writer;
  DO $$
  DECLARE
    signature_ REGPROCEDURE;
  BEGIN
    FOR signature_ IN SELECT p.oid::regprocedure FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND starts_with(p.proname,'observed_') AND p.provolatile='i'
    LOOP
      EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO shopmate_observed_test_writer',signature_);
    END LOOP;
  END
  $$;
`;
const fixtureWriteDefinition = `
  CREATE FUNCTION observed_test.write_fact(
    scope_ UUID, user_ TEXT, grant_ TEXT, receipt_ TEXT, bytes_ BYTEA,
    start_ TIMESTAMPTZ, end_ TIMESTAMPTZ, total_ INTEGER
  ) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
  DECLARE
    f_ JSONB := convert_from(bytes_,'UTF8')::jsonb;
    kind_ TEXT := f_->'subject'->>'kind';
    subject_ TEXT := coalesce(f_->'subject'->>'externalSkuId','');
    receipt_key_ UUID;
    fact_key_ UUID;
  BEGIN
    PERFORM public.observed_authorize(scope_,user_,'CONSUME',f_->>'domain',grant_);
    INSERT INTO public.observed_page_receipts ("scopeId","receiptId",domain,"subjectKind","subjectId",
      "periodStart","periodEnd",through,"modelVersion","configHash","publicationId","publicationHash",
      "pageId","pageIndex","pageHash","terminalCoverageBps","recordCount","recordedAt")
    VALUES (scope_,receipt_,f_->>'domain',kind_,subject_,start_,end_,end_,f_->>'modelVersion',
      repeat('a',64),receipt_,repeat('a',64),receipt_,0,repeat('a',64),10000,total_,clock_timestamp())
    RETURNING "receiptKey" INTO receipt_key_;
    INSERT INTO public.observed_facts ("scopeId",domain,"subjectKind","subjectId","factId",sequence,
      "producerVersion","modelVersion","occurredAt","observedAt","payloadHash",payload,"originReceiptKey","factBytes")
    VALUES (scope_,f_->>'domain',kind_,subject_,f_->>'factId',(f_->>'sequence')::bigint,
      f_->>'producerVersion',f_->>'modelVersion',(f_->>'occurredAt')::timestamptz,(f_->>'observedAt')::timestamptz,
      f_->>'payloadHash',f_->'payload',receipt_key_,bytes_)
    RETURNING "factKey" INTO fact_key_;
    INSERT INTO public.observed_receipt_members ("receiptKey",ordinal,"factKey","scopeId",domain,"subjectKind","subjectId")
    VALUES (receipt_key_,0,fact_key_,scope_,f_->>'domain',kind_,subject_);
  END
  $$;
`;

async function installWriteFixture(state) {
  const { client } = state;
  await client.query(`CREATE ROLE ${fixtureWriter} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  state.logins.push(fixtureWriter);
  await client.query(`CREATE SCHEMA observed_test AUTHORIZATION ${fixtureWriter}`);
  await client.query(fixturePrivileges);
  await client.query(fixtureWriteDefinition);
  const signature =
    "observed_test.write_fact(uuid,text,text,text,bytea,timestamptz,timestamptz,integer)";
  await client.query(`ALTER FUNCTION ${signature} OWNER TO ${fixtureWriter}`);
  await client.query(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
  await client.query(`GRANT USAGE ON SCHEMA observed_test TO ${capabilityRoles[1]}`);
  await client.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${capabilityRoles[1]}`);
}

function graphFact(f, sequence, payload = feePayload) {
  return priceFact(`restricted-${sequence}`, sequence, null, {
    binding: f.scope,
    domain: "FEE",
    subject: storeSubject,
    occurredAt: periodEnd,
    observedAt: periodEnd,
    payload,
  });
}

function writeFixture(f, fact, fields = {}) {
  const { count = 1, start = periodStart } = fields;
  return f.client.query("SELECT observed_test.write_fact($1,$2,$3,$4,$5,$6,$7,$8)", [
    f.scopeId,
    f.userId,
    f.grantId,
    fact.factId,
    factBytes(fact),
    start,
    periodEnd,
    count,
  ]);
}

async function restrictedGraph(state) {
  const f = await authorityFixture(state, 1, "OPERATOR", ["FEE"]);
  try {
    await installWriteFixture(state);
    const fact = state.factSchema.parse(graphFact(f, 1));
    await transaction(f.client, () => writeFixture(f, fact));
    const persisted = await readFromNewConnection(state.url, f.scopeId);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].receiptId, fact.factId);
    assert.equal(persisted[0].originReceiptId, fact.factId);
    assert.deepEqual(persisted[0].factBytes, factBytes(fact));
    await restrictedGraphDenials(state, f);
    assert.deepEqual(await readFromNewConnection(state.url, f.scopeId), persisted);
  } finally {
    await f.client.end();
  }
}

async function restrictedGraphDenials(state, f) {
  const admitted = state.factSchema.parse(graphFact(f, 2));
  for (const fields of [{ count: 2 }, { start: offsetMillisecond(periodStart, 1) }]) {
    await f.client.query("BEGIN");
    assert.equal((await writeFixture(f, admitted, fields)).rowCount, 1);
    await assert.rejects(f.client.query("COMMIT"), {
      code: "23514",
      constraint: "observed_receipt_members_valid",
    });
  }
  await assert.rejects(
    writeFixture(f, graphFact(f, 3, { ...feePayload, amountMinor: "invalid" })),
    {
      code: "23514",
      constraint: "observed_facts_payload_valid",
    },
  );
  await assert.rejects(
    writeFixture(f, priceFact("restricted-denied-domain", 4, null, { binding: f.scope })),
    authorityDenied,
  );
}

async function applyMigrations(client, names) {
  for (const name of names) {
    await client.query(await readFile(new URL(`${name}/migration.sql`, migrations), "utf8"));
  }
}

async function upgradeHistory(client) {
  const names = (await readdir(migrations)).filter((name) => /^\d{14}_/u.test(name)).sort();
  const index = names.findIndex((name) => observedMigration.test(name));
  assert.ok(index > 0);
  await applyMigrations(client, names.slice(0, index));
  const sql = await readFile(new URL(`${names[index]}/migration.sql`, migrations), "utf8");
  return { sql, later: names.slice(index + 1) };
}

async function tenantSnapshot(client) {
  const { rows } = await client.query(
    `SELECT to_jsonb(c) AS connection, to_jsonb(s) AS store, to_jsonb(o) AS organization,
       to_jsonb(w) AS workspace, to_jsonb(m) AS member, to_jsonb(wm) AS assignment
     FROM public."PlatformConnection" c
     JOIN public."Store" s ON s.id=c."storeId"
     JOIN public."Organization" o ON o.id=s."organizationId"
     JOIN public."Workspace" w ON w.id=s."workspaceId"
     JOIN public."OrganizationMember" m ON m."organizationId"=o.id AND m."userId"=$2
     JOIN public."WorkspaceMember" wm ON wm."workspaceId"=w.id AND wm."userId"=m."userId"
     WHERE c.id=$1`,
    [binding.connectionId, principal],
  );
  assert.equal(rows.length, 1);
  return rows[0];
}

async function rejectUpgrade(client, sql, message) {
  await assert.rejects(client.query(sql), { code: "42501", message });
  await client.query("ROLLBACK");
  const { rows } = await client.query("SELECT to_regclass($1) AS relation", [
    `public.${grantTable}`,
  ]);
  assert.equal(rows[0].relation, null);
}

async function rejectExistingGuardObjects(client, sql) {
  const ownershipCases = [
    [
      `CREATE FUNCTION public.observed_test_existing() RETURNS name
       LANGUAGE SQL SECURITY DEFINER SET search_path=pg_catalog AS 'SELECT CURRENT_USER';
       ALTER FUNCTION public.observed_test_existing() OWNER TO ${guardRole}`,
      "DROP FUNCTION public.observed_test_existing()",
    ],
    [
      `CREATE TABLE public.observed_test_existing (id integer);
       ALTER TABLE public.observed_test_existing OWNER TO ${guardRole}`,
      "DROP TABLE public.observed_test_existing",
    ],
    [
      `CREATE SCHEMA observed_test_existing AUTHORIZATION ${guardRole}`,
      "DROP SCHEMA observed_test_existing",
    ],
  ];
  for (const [create, remove] of ownershipCases) {
    await client.query(create);
    try {
      await rejectUpgrade(client, sql, "Unsafe observed guard ownership");
    } finally {
      await client.query(remove);
    }
  }
}

async function upgradeWithGuardMembership(client, sql, state) {
  const operator = "shopmate_observed_test_migration_admin";
  await client.query(`CREATE ROLE ${operator} NOLOGIN CREATEROLE BYPASSRLS`);
  (state.logins ??= []).push(operator);
  await rejectExistingGuardObjects(client, sql);
  await client.query(`ALTER ROLE ${guardRole} BYPASSRLS`);
  try {
    await rejectUpgrade(client, sql, "Unsafe observed capability role");
  } finally {
    await client.query(`ALTER ROLE ${guardRole} NOBYPASSRLS`);
  }
  await client.query(`GRANT ${guardRole} TO ${operator} WITH ADMIN TRUE, INHERIT FALSE, SET TRUE`);
  await rejectUpgrade(client, sql, "Unsafe observed capability role membership");
  await client.query(`GRANT ${guardRole} TO ${operator} WITH SET FALSE`);
  try {
    await client.query(sql);
  } finally {
    await client.query("ROLLBACK");
    await client.query(`REVOKE ${guardRole} FROM ${operator}`);
  }
}

async function seededUpgrade(state) {
  const { name, url } = await createDisposableDatabase(state.server, state.url);
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    const { sql, later } = await upgradeHistory(client);
    await seedBinding(client);
    await seedMember(client, principal);
    const before = await tenantSnapshot(client);
    await upgradeWithGuardMembership(client, sql, state);
    assert.deepEqual(await tenantSnapshot(client), before);
    assert.equal(
      (await client.query("SELECT count(*)::int AS count FROM public.observed_principal_grants"))
        .rows[0].count,
      0,
    );
    await applyMigrations(client, later);
    schemaParity({ url });
  } finally {
    await client.end();
    await state.server.query(`DROP DATABASE "${name}"`);
  }
}

async function roundTrip({ client, url }) {
  const scopeId = await insertScope(client);
  const fact = priceFact("z/一", 1);
  const correction = priceFact(fact.factId, 3, 1);
  const other = priceFact("a/二", 2);
  const before = Date.now();
  await transaction(client, async () => {
    const { factKey } = await insertOrigin(client, scopeId, "01-origin", fact);
    await insertOrigin(client, scopeId, "02-interleaved", other);
    const later = await insertReceipt(client, scopeId, "03-later", 1);
    await member(client, scopeId, later, factKey, 0);
    await insertOrigin(client, scopeId, "04-correction", correction, 1);
    await insertReceipt(client, scopeId, "05-empty", 0);
  });
  const rows = await readFromNewConnection(url, scopeId);
  assert.deepEqual(
    rows.map(({ sequence }) => sequence),
    ["1", "2", "1", "3"],
  );
  assert.deepEqual(
    rows.map(({ originReceiptId }) => originReceiptId),
    ["01-origin", "02-interleaved", "01-origin", "04-correction"],
  );
  assert.equal(rows[3].priorSequence, "1");
  assert.equal(JSON.parse(rows[3].factBytes.toString("utf8")).priorVersion, "observed-v1:g:7:e:1");
  assert.equal(rows[2].factId, fact.factId);
  assert.deepEqual(rows[2].factBytes, factBytes(fact));
  assert.deepEqual(rows[2].payload, fact.payload);
  assert.ok(rows[0].recordedAt.getTime() >= before);
  assert.deepEqual(rows[2].originRecordedAt, rows[0].recordedAt);
}

async function bindingKeys({ client }) {
  for (const key of Object.keys(binding)) {
    await assert.rejects(insertScope(client, { [key]: "foreign" }, 123), { code: "23503" });
  }
  const next = await insertScope(client, {}, 8);
  const prior = await insertScope(client, {}, 6);
  assert.notEqual(next, prior);
  await assert.rejects(insertScope(client, {}, 8), { code: "23505" });
}

const scopeVisibilityFixtureSql = `
  CREATE ROLE observed_scope_visibility_fixture
    NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  GRANT USAGE ON SCHEMA public TO observed_scope_visibility_fixture;
  GRANT SELECT ON public.observed_scopes TO observed_scope_visibility_fixture;
  GRANT INSERT, SELECT ON public.observed_page_receipts, public.observed_facts
    TO observed_scope_visibility_fixture;
  GRANT EXECUTE ON FUNCTION public.observed_opaque_text(text, integer),
    public.observed_time(timestamptz), public.observed_subject_valid(text, text, text),
    public.observed_fact_envelope(public.observed_facts, public.observed_scopes)
    TO observed_scope_visibility_fixture;
  ALTER TABLE public.observed_scopes ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.observed_scopes FORCE ROW LEVEL SECURITY;
  CREATE POLICY observed_scope_visibility_fixture ON public.observed_scopes
    FOR SELECT TO observed_scope_visibility_fixture USING (generation <> 18);
  CREATE POLICY observed_receipt_visibility_fixture ON public.observed_page_receipts
    TO observed_scope_visibility_fixture USING (true) WITH CHECK (true);
  CREATE POLICY observed_fact_visibility_fixture ON public.observed_facts
    TO observed_scope_visibility_fixture USING (true) WITH CHECK (true)
`;

async function withHiddenScope(client, verify) {
  await client.query("BEGIN");
  try {
    const scopeId = await insertScope(client, {}, 18);
    const receipt = await insertReceipt(client, scopeId, "hidden-scope-origin", 0);
    await client.query(scopeVisibilityFixtureSql);
    await client.query("SET LOCAL ROLE observed_scope_visibility_fixture");
    const result = await client.query(
      `SELECT current_user AS role, pg_catalog.has_table_privilege($1, $2) AS granted,
        pg_catalog.row_security_active($1::regclass) AS filtered,
        EXISTS (SELECT 1 FROM public.observed_scopes WHERE "scopeId"=$3) AS visible`,
      ["public.observed_scopes", "SELECT", scopeId],
    );
    assert.deepEqual(result.rows, [
      { role: "observed_scope_visibility_fixture", granted: true, filtered: true, visible: false },
    ]);
    await verify(scopeId, receipt);
  } finally {
    await client.query("ROLLBACK");
  }
}

const missingScopeId = "00000000-0000-0000-0000-000000000000";

async function receiptScopeVisibility({ client }) {
  const expected = { code: "23503", constraint: "observed_receipts_scope_fkey" };
  await assert.rejects(insertReceipt(client, missingScopeId, "absent-parent", 0), expected);
  await withHiddenScope(client, async (scopeId) => {
    const fields = { domain: "SYNC_TRANSITION", subjectKind: "CONNECTION", subjectId: "foreign" };
    await assert.rejects(insertReceipt(client, scopeId, "hidden-parent", 0, fields), expected);
  });
  await withHiddenScope(client, (scopeId) =>
    assert.rejects(insertReceipt(client, scopeId, "hidden-price-parent", 0), expected),
  );
}

async function factScopeVisibility({ client }) {
  const expected = { code: "23503", constraint: "observed_facts_scope_fkey" };
  const fact = priceFact("hidden-parent", 1, null, { generation: 18 });
  await assert.rejects(
    insertFact(client, missingScopeId, { receiptKey: missingScopeId }, fact),
    expected,
  );
  const mismatched = factBytes({ ...fact, sourceVersion: "observed-v1:g:18:e:2" });
  await withHiddenScope(client, (scopeId, receipt) =>
    assert.rejects(insertFact(client, scopeId, receipt, fact, null, mismatched), expected),
  );
}

async function rejectsTransaction(client, callback, code, constraint) {
  await assert.rejects(transaction(client, callback), { code, constraint });
}

async function wrongMembership({ client }) {
  const scopeId = await insertScope(client, {}, 9);
  const fact = priceFact("graph-membership", 1, null, { generation: 9 });
  const { factKey } = await transaction(client, () => insertOrigin(client, scopeId, "valid", fact));
  await rejectsTransaction(
    client,
    async () => {
      const otherScope = await insertScope(client, {}, 10);
      const receipt = await insertReceipt(client, otherScope, "cross-scope", 1);
      await member(client, otherScope, receipt, factKey, 0);
    },
    "23503",
    "observed_members_fact_fkey",
  );
  await rejectsTransaction(
    client,
    async () => {
      const receipt = await insertReceipt(client, scopeId, "cross-subject", 1, {
        subjectId: "other",
      });
      await member(client, scopeId, receipt, factKey, 0);
    },
    "23503",
    "observed_members_receipt_fkey",
  );
  await rejectsTransaction(
    client,
    async () => {
      const receipt = await insertReceipt(client, scopeId, "cross-domain", 1, {
        domain: "LISTING",
      });
      await member(client, scopeId, receipt, factKey, 0);
    },
    "23503",
    "observed_members_receipt_fkey",
  );
}

async function missingOrigin({ client }) {
  await rejectsTransaction(
    client,
    async () => {
      const scopeId = await insertScope(client, {}, 11);
      const other = await insertReceipt(client, scopeId, "wrong-origin", 0);
      const receipt = await insertReceipt(client, scopeId, "actual-member", 1);
      const fact = priceFact("missing-origin", 1, null, { generation: 11 });
      const factKey = await insertFact(client, scopeId, other, fact);
      await member(client, scopeId, receipt, factKey, 0);
    },
    "23503",
    "observed_facts_origin_member_fkey",
  );
}

async function membershipVersion(client, scopeId, id, sequence, priorSequence = null) {
  const fact = priceFact(id, sequence, priorSequence, { generation: 12 });
  return (await insertOrigin(client, scopeId, `membership-${sequence}`, fact, priorSequence))
    .factKey;
}

async function invalidMemberships({ client }) {
  const scopeId = await insertScope(client, {}, 12);
  const [first, second, correction] = await transaction(client, async () => [
    await membershipVersion(client, scopeId, "z", 1),
    await membershipVersion(client, scopeId, "a", 2),
    await membershipVersion(client, scopeId, "z", 3, 1),
  ]);
  const valid = await transaction(client, async () => {
    const receipt = await insertReceipt(client, scopeId, "ordered", 2);
    await member(client, scopeId, receipt, first, 0);
    await member(client, scopeId, receipt, second, 1);
    return receipt;
  });
  await rejectsReceiptMembers(client, scopeId, "count", 1, []);
  await rejectsReceiptMembers(client, scopeId, "gap", 1, [[first, 1]]);
  await rejectsReceiptMembers(client, scopeId, "reordered", 2, [
    [second, 0],
    [first, 1],
  ]);
  await rejectsReceiptMembers(client, scopeId, "logical-duplicate", 2, [
    [first, 0],
    [correction, 1],
  ]);
  await assert.rejects(member(client, scopeId, valid, correction, 2), {
    code: "23514",
    constraint: "observed_receipt_members_valid",
  });
}

function rejectsReceiptMembers(client, scopeId, id, count, edges) {
  return rejectsTransaction(
    client,
    async () => {
      const receipt = await insertReceipt(client, scopeId, id, count);
      for (const [factKey, ordinal] of edges)
        await member(client, scopeId, receipt, factKey, ordinal);
    },
    "23514",
    "observed_receipt_members_valid",
  );
}

async function invalidCorrections({ client }) {
  const scopeId = await insertScope(client, {}, 13);
  const fact = (id, sequence, priorSequence = null, fields = {}) =>
    priceFact(id, sequence, priorSequence, { generation: 13, ...fields });
  await transaction(client, async () => {
    await insertOrigin(client, scopeId, "root", fact("root", 1));
    await insertOrigin(client, scopeId, "other-root", fact("other-root", 2));
    await insertOrigin(client, scopeId, "correction", fact("root", 3, 1), 1);
  });
  const cases = [
    [fact("unknown", 4, 5), 5, "23514", "observed_facts_sequence_valid"],
    [fact("unknown", 5, 4), 4, "23503", "observed_facts_predecessor_fkey"],
    [fact("different", 4, 1), 1, "23503", "observed_facts_predecessor_fkey"],
    [
      fact("other-root", 4, 2, { subject: { kind: "SKU", externalSkuId: "other" } }),
      2,
      "23503",
      "observed_facts_predecessor_fkey",
    ],
    [fact("root", 4, 1), 1, "23505", "observed_facts_chain_key"],
    [fact("root", 4), null, "23505", "observed_facts_chain_key"],
    [fact("root", 4, 4), 4, "23514", "observed_facts_sequence_valid"],
    [fact("different", 3), null, "23505", "observed_facts_sequence_key"],
    [
      fact("different", Number.MAX_SAFE_INTEGER + 1),
      null,
      "23514",
      "observed_facts_sequence_valid",
    ],
  ];
  for (const [candidate, prior, code, constraint] of cases) {
    await rejectsTransaction(
      client,
      () => insertOrigin(client, scopeId, "invalid", candidate, prior),
      code,
      constraint,
    );
  }
}

async function invalidFactBytes({ client }) {
  const scopeId = await insertScope(client, {}, 14);
  const fact = priceFact("stored-exact", 1, null, { generation: 14 });
  const variants = [
    factBytes({ ...fact, sourceVersion: "observed-v1:g:14:e:01" }),
    factBytes({ ...fact, payload: { ...fact.payload, priceMinor: 3 } }),
    factBytes({ ...fact, binding: { ...binding, externalStoreId: "other" } }),
    Buffer.from(`{"sequence":1,${JSON.stringify(fact).slice(1)}`),
  ];
  for (const bytes of variants) {
    await rejectsTransaction(
      client,
      async () => {
        const receipt = await insertReceipt(client, scopeId, "bad-bytes", 1);
        const factKey = await insertFact(client, scopeId, receipt, fact, null, bytes);
        await member(client, scopeId, receipt, factKey, 0);
      },
      "23514",
      "observed_facts_exact_bytes",
    );
  }
}

async function assertTruncateGuards(client) {
  // A single TRUNCATE can stop at a foreign key or the first guard it reaches.
  const { rows } = await client.query(
    `SELECT c.relname AS name FROM pg_catalog.pg_trigger AS t
     JOIN pg_catalog.pg_class AS c ON c.oid=t.tgrelid
     JOIN pg_catalog.pg_namespace AS n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname=ANY($1::text[])
       AND t.tgfoid='public.observed_reject_history_mutation()'::regprocedure
       AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal
       AND pg_catalog.pg_get_triggerdef(t.oid) LIKE $2`,
    [tables, "% BEFORE TRUNCATE % FOR EACH STATEMENT EXECUTE FUNCTION %"],
  );
  assert.deepEqual(rows.map(({ name }) => name).sort(), [...tables].sort());
}

async function immutableHistory({ client }) {
  await assertTruncateGuards(client);
  const scopeId = await insertScope(client, {}, 15);
  const fact = priceFact("immutable", 1, null, { generation: 15 });
  await transaction(client, () => insertOrigin(client, scopeId, "immutable", fact));
  const mutations = [
    "UPDATE public.observed_scopes SET generation=generation",
    'UPDATE public.observed_page_receipts SET "receiptId"="receiptId"',
    'UPDATE public.observed_facts SET "factId"="factId"',
    "UPDATE public.observed_receipt_members SET ordinal=ordinal",
    "DELETE FROM public.observed_scopes",
    "DELETE FROM public.observed_page_receipts",
    "DELETE FROM public.observed_facts",
    "DELETE FROM public.observed_receipt_members",
    "TRUNCATE public.observed_scopes, public.observed_page_receipts, public.observed_facts, public.observed_receipt_members, public.observed_principal_grants",
  ];
  for (const statement of mutations) {
    await assert.rejects(client.query(statement), {
      code: "23514",
      constraint: "observed_history_immutable",
    });
  }
}

async function receiptMetadata({ client }) {
  const scopeId = await insertScope(client, {}, 16);
  const cases = [
    [201, {}, "observed_receipts_page_valid"],
    [0, { pageIndex: 1 }, "observed_receipts_page_valid"],
    [0, { nextCursor: "after" }, "observed_receipts_page_valid"],
    [0, { terminalCoverageBps: 10001 }, "observed_receipts_page_valid"],
    [0, { publicationHash: "A".repeat(64) }, "observed_receipts_hashes_valid"],
    [0, { through: periodStart }, "observed_receipts_window_valid"],
    [0, { periodStart: "2026-10-10T16:00:00.0001Z" }, "observed_receipts_window_valid"],
  ];
  for (const [count, fields, constraint] of cases) {
    await assert.rejects(insertReceipt(client, scopeId, "invalid-receipt", count, fields), {
      code: "23514",
      constraint,
    });
  }
  await duplicatePages(client, scopeId);
}

async function duplicatePages(client, scopeId) {
  const page = {
    publicationId: "two-pages",
    pageId: "page-1",
    nextCursor: "more",
    terminalCoverageBps: null,
  };
  await insertReceipt(client, scopeId, "first-page", 0, page);
  await assert.rejects(
    insertReceipt(client, scopeId, "reindexed", 0, {
      ...page,
      pageIndex: 1,
      priorPageHash: hash,
      expectedCursor: "more",
    }),
    { code: "23505", constraint: "observed_receipts_page_id_key" },
  );
  await assert.rejects(
    insertReceipt(client, scopeId, "same-index", 0, {
      ...page,
      pageId: "new-page",
    }),
    { code: "23505", constraint: "observed_receipts_page_index_key" },
  );
}

async function wideIdentities({ client }) {
  const scopeId = await insertScope(client, {}, 17);
  const entity = { kind: "SKU", externalSkuId: "甲".repeat(256) };
  const opaque = "界".repeat(255);
  const publicationId = "发".repeat(256);
  await transaction(client, async () => {
    for (const [suffix, sequence] of [
      ["A", 1],
      ["a", 2],
    ]) {
      const factId = opaque + suffix;
      const fact = priceFact(factId, sequence, null, { generation: 17, subject: entity });
      const fields = wideReceiptPage(fact, publicationId);
      const receipt = await insertReceipt(client, scopeId, factId, 1, fields);
      const key = await insertFact(client, scopeId, receipt, fact);
      await member(client, scopeId, receipt, key, 0, fact);
    }
  });
  await assert.rejects(
    insertReceipt(client, scopeId, "🚀".repeat(129), 0, {
      publicationId,
      pageId: "third-page",
    }),
    { code: "23514", constraint: "observed_receipts_identity_valid" },
  );
}

function wideReceiptPage(fact, publicationId) {
  const first = fact.sequence === 1;
  return {
    subjectId: fact.subject.externalSkuId,
    publicationId,
    pageId: fact.factId,
    pageIndex: fact.sequence - 1,
    priorPageHash: first ? null : hash,
    expectedCursor: first ? null : "next",
    nextCursor: first ? "next" : null,
    terminalCoverageBps: first ? null : 10000,
  };
}

const financeLine = {
  externalSkuId: subject.externalSkuId,
  externalOrderId: "order/甲",
  externalLineId: "line/1",
};
const frozenCost = {
  ...financeLine,
  quantity: 1,
  frozenAt: periodStart,
  skuCostVersion: "cost/历史",
  unitCostMinor: 0,
  basis: "CONFIRMED",
  currency: "CNY",
  reason: null,
};
const refundAllocation = {
  ...financeLine,
  externalRefundId: "refund/1",
  quantity: 0,
  merchandiseMinor: 0,
  buyerShippingMinor: 0,
  settledAt: periodStart,
  currency: "CNY",
  reason: null,
};
const returnReceipt = {
  ...financeLine,
  externalRefundId: "refund/1",
  externalReceiptId: "return/1",
  acceptedAt: periodStart,
  resellableQuantity: 0,
  reason: null,
};

const financePayloadCases = [
  {
    domain: "FROZEN_COST",
    generation: 20,
    payload: frozenCost,
    accepted: [
      { basis: "ESTIMATED", reason: "COST_ESTIMATED" },
      { basis: "UNAVAILABLE", unitCostMinor: null, reason: "COST_MISSING" },
      { basis: "UNAVAILABLE", skuCostVersion: null, unitCostMinor: null, reason: "COST_MISSING" },
    ],
    rejected: [
      { unitCostMinor: "0" },
      { unitCostMinor: Number.MAX_SAFE_INTEGER + 1 },
      { quantity: 0 },
      { quantity: 1.5 },
      { reason: undefined },
      { oracle: null },
      { skuCostVersion: null },
      { skuCostVersion: " cost/历史" },
      { externalLineId: 1 },
      { externalSkuId: "another-sku" },
      { frozenAt: "tomorrow" },
      { frozenAt: "2026-02-30T16:00:00.000Z" },
      { frozenAt: "2026-10-10T16:00:00Z" },
      { frozenAt: "2026-10-10T16:00:00.000+00:00" },
      { frozenAt: "2026-10-10T24:00:00.000Z" },
      { frozenAt: "0000-01-01T00:00:00.000Z" },
      { frozenAt: "2026-10-11T16:00:00.001Z" },
      { basis: "UNAVAILABLE", reason: "COST_MISSING" },
      { basis: "ESTIMATED" },
      { currency: "USD" },
    ],
    shapes: [null, [], 1, "frozen cost"],
  },
  {
    domain: "REFUND_ALLOCATION",
    generation: 21,
    payload: refundAllocation,
    accepted: [{ merchandiseMinor: null, reason: "REFUND_UNKNOWN" }],
    rejected: [
      { merchandiseMinor: null },
      { reason: "REFUND_UNKNOWN" },
      { quantity: undefined },
      { buyerShippingMinor: -1 },
      { settledAt: "2026-10-11T16:00:00.001Z" },
      { externalRefundId: "🚀".repeat(129) },
    ],
  },
  {
    domain: "RETURN_RECEIPT",
    generation: 22,
    payload: returnReceipt,
    accepted: [
      { acceptedAt: null, resellableQuantity: null, reason: "RETURN_UNKNOWN" },
      { resellableQuantity: null, reason: "RETURN_UNKNOWN" },
    ],
    rejected: [
      { acceptedAt: null },
      { acceptedAt: "2026-10-11T16:00:00.001Z" },
      { resellableQuantity: null },
      { reason: "REFUND_UNKNOWN" },
      { externalReceiptId: "bad\u200Breceipt" },
    ],
  },
];

const storeSubject = { kind: "STORE" };
const campaignSubject = { kind: "CAMPAIGN", externalCampaignId: "campaign/甲" };
const measurementWindow = { periodStart, periodEnd, timezone: "Asia/Shanghai", currency: "CNY" };
const historicalWindow = {
  ...measurementWindow,
  periodStart: "1990-06-30T15:00:00.000Z",
  periodEnd: "1990-07-01T15:00:00.000Z",
};
const feePayload = {
  chargeId: "charge/1",
  kind: "ADVERTISING_PROMOTION",
  externalOrderId: null,
  externalCampaignId: campaignSubject.externalCampaignId,
  window: measurementWindow,
  amountMinor: 0,
  basis: "CONFIRMED",
  coverageBasisPoints: 10000,
  reason: null,
};
const trafficPayload = {
  window: measurementWindow,
  visitors: 0,
  cart: 2,
  checkout: 3,
  paidOrders: 1,
  measurementVersion: "traffic/1",
  coverageBasisPoints: 7500,
  reason: "PARTIAL_COVERAGE",
};
const campaignPayload = {
  externalCampaignId: campaignSubject.externalCampaignId,
  businessDate: "1990-07-01",
  window: historicalWindow,
  spendMinor: 0,
  attributedRevenueMinor: 0,
  eligibleCount: 10,
  measuredCount: 1,
  measurementVersion: "campaign/1",
  attributionPolicyVersion: "attribution/旧",
  coverageBasisPoints: 10000,
  currency: "CNY",
  reason: null,
};

const measurementPayloadCases = [
  {
    domain: "FEE",
    generation: 23,
    subject: storeSubject,
    payload: feePayload,
    accepted: [
      { basis: "ESTIMATED", reason: "FEE_ESTIMATED" },
      { basis: "UNAVAILABLE", amountMinor: null, reason: "FEE_MISSING" },
      { externalOrderId: "order/1", externalCampaignId: null },
      { coverageBasisPoints: 0, reason: "PARTIAL_COVERAGE" },
    ],
    rejected: [
      { coverageBasisPoints: 10001 },
      { coverageBasisPoints: 1 },
      { basis: "UNAVAILABLE", reason: "FEE_MISSING" },
      { basis: "CONFIRMED", amountMinor: null },
      { kind: "PAYOUT" },
      { externalCampaignId: { id: "campaign/1" } },
      { externalOrderId: undefined },
      { window: { ...measurementWindow, timezone: "UTC" } },
      { window: { ...measurementWindow, currency: "USD" } },
      { window: { ...measurementWindow, oracle: null } },
      { window: { ...measurementWindow, periodStart: periodEnd } },
      { window: { ...measurementWindow, periodEnd: "2026-10-11T16:00:00.001Z" } },
      { window: { ...measurementWindow, periodStart: "2026-10-00T16:00:00.000Z" } },
      { window: ["Asia/Shanghai", "CNY"] },
    ],
  },
  {
    domain: "TRAFFIC",
    generation: 24,
    payload: trafficPayload,
    accepted: [
      { coverageBasisPoints: 10000, reason: null },
      { visitors: null, coverageBasisPoints: 10000, reason: "TRAFFIC_MISSING" },
    ],
    rejected: [
      { cart: null },
      { coverageBasisPoints: 10000 },
      { paidOrders: false },
      { visitors: "0" },
      { checkout: Number.MAX_SAFE_INTEGER + 1 },
      { measurementVersion: "" },
      { window: null },
      { window: { ...measurementWindow, periodEnd: "2026-10-11T16:00:00.001Z" } },
    ],
  },
  {
    label: "STORE TRAFFIC",
    domain: "TRAFFIC",
    generation: 25,
    subject: storeSubject,
    payload: trafficPayload,
    rejected: [{ oracle: null }],
  },
  {
    domain: "CAMPAIGN_MEASUREMENT",
    generation: 26,
    subject: campaignSubject,
    payload: campaignPayload,
    receiptWindow: { ...historicalWindow, through: "1990-07-01T16:00:00.000Z" },
    observedAt: "1990-07-01T16:00:00.000Z",
    accepted: [
      { eligibleCount: null, reason: "ATTRIBUTION_MISSING" },
      { coverageBasisPoints: 1, measuredCount: 10, reason: "PARTIAL_COVERAGE" },
    ],
    rejected: [
      { businessDate: "1990-06-30" },
      { businessDate: "1990-06-31" },
      { businessDate: 19900701 },
      { window: { ...historicalWindow, periodStart: "1990-06-30T14:59:59.999Z" } },
      { window: { ...historicalWindow, periodEnd: "1990-07-01T15:00:00.001Z" } },
      { measuredCount: 11 },
      { measuredCount: 11, spendMinor: null, reason: "ATTRIBUTION_MISSING" },
      { spendMinor: null },
      { externalCampaignId: "other-campaign" },
      { externalCampaignId: ["campaign/甲"] },
      { attributionPolicyVersion: null },
      { reason: undefined },
    ],
  },
];

const catalogPayloadCases = [
  {
    domain: "LISTING",
    generation: 27,
    payload: {
      externalSkuId: subject.externalSkuId,
      listedAt: periodStart,
      effectiveAt: periodStart,
      fromStatus: "UNLISTED",
      toStatus: "LISTED",
    },
    accepted: [
      { fromStatus: "DELISTED", effectiveAt: periodEnd },
      { toStatus: "DELISTED", effectiveAt: periodEnd },
    ],
    rejected: [
      { effectiveAt: periodEnd },
      { fromStatus: "LISTED" },
      { listedAt: periodEnd, fromStatus: "DELISTED" },
      { effectiveAt: "2026-10-11T16:00:00.001Z", fromStatus: "DELISTED" },
      { fromStatus: "DRAFT" },
      { toStatus: "UNLISTED" },
      { externalSkuId: "SKU/甲" },
      { updatedAt: periodStart },
    ],
  },
  {
    domain: "PRICE",
    generation: 28,
    payload: priceFact("fixture", 1).payload,
    accepted: [
      { priorPriceMinor: null, priceMinor: 0, effectiveAt: periodEnd },
      { priorPriceMinor: Number.MAX_SAFE_INTEGER, priceVersion: "🚀".repeat(128) },
    ],
    rejected: [
      { effectiveAt: "2026-10-11T16:00:00.001Z" },
      { priorPriceMinor: undefined },
      { priceMinor: null },
      { priceMinor: 1.5 },
      { priorPriceMinor: -1 },
      { priceVersion: "🚀".repeat(129) },
      { priceVersion: {} },
      { externalSkuId: " SKU/甲" },
      { currency: "USD" },
    ],
  },
];

const future = "2026-10-12T16:00:00.000Z";
const location = { externalSkuId: subject.externalSkuId, externalLocationId: "仓/1" };
const inventoryPayloadCases = [
  {
    domain: "INVENTORY_LOT",
    generation: 29,
    payload: {
      ...location,
      externalLotId: "lot/1",
      externalReceiptId: "receipt/1",
      receivedAt: periodStart,
      movementAt: periodEnd,
      reason: "SALE",
      deltaQuantity: -1,
      beforeQuantity: Number.MAX_SAFE_INTEGER,
      afterQuantity: Number.MAX_SAFE_INTEGER - 1,
    },
    accepted: [
      { reason: "RECEIPT", deltaQuantity: 1, beforeQuantity: 0, afterQuantity: 1 },
      { reason: "RETURN", deltaQuantity: 1, beforeQuantity: 0, afterQuantity: 1 },
      { reason: "TRANSFER_IN", deltaQuantity: 1, beforeQuantity: 0, afterQuantity: 1 },
      { reason: "TRANSFER_OUT" },
      { reason: "WRITE_OFF" },
    ],
    rejected: [
      { afterQuantity: Number.MAX_SAFE_INTEGER },
      { reason: "TRANSFER_IN" },
      { reason: "RECEIPT", deltaQuantity: 1, afterQuantity: Number.MAX_SAFE_INTEGER },
      { reason: "REVISION" },
      { reason: "TRANSFER_OUT", deltaQuantity: 0, afterQuantity: Number.MAX_SAFE_INTEGER },
      { deltaQuantity: "-1" },
      { beforeQuantity: Number.MAX_SAFE_INTEGER + 1 },
      { receivedAt: future },
      { movementAt: future },
      { externalLocationId: [] },
      { oracle: null },
    ],
  },
  {
    domain: "SUPPLIER_NOTICE",
    generation: 30,
    payload: {
      ...location,
      noticeId: "notice/1",
      purchaseOrderId: "po/1",
      announcedAt: periodEnd,
      priorEta: null,
      newEta: future,
      inboundQuantity: 0,
      promisedLeadHours: 1.25,
      reason: null,
    },
    accepted: [
      { priorEta: future, promisedLeadHours: 0 },
      { inboundQuantity: null, reason: "INVENTORY_UNKNOWN" },
      { newEta: null, reason: "LEAD_TIME_MISSING" },
      { inboundQuantity: null, newEta: null, reason: "LEAD_TIME_MISSING" },
    ],
    rejected: [
      { announcedAt: future },
      { reason: "INVENTORY_UNKNOWN" },
      { inboundQuantity: null },
      { promisedLeadHours: null },
      { promisedLeadHours: -0.25 },
      { promisedLeadHours: Number.MAX_SAFE_INTEGER + 1 },
      { promisedLeadHours: "1.25" },
      { priorEta: "infinity" },
      { priorEta: undefined },
      { purchaseOrderId: "" },
      { oracle: null },
    ],
  },
  {
    domain: "INVENTORY_POSITION",
    generation: 31,
    payload: {
      ...location,
      asOf: periodEnd,
      quarantine: 0,
      inbound: 1,
      safetyBufferHours: 0.5,
      reason: null,
    },
    accepted: [
      { quarantine: null, reason: "INVENTORY_UNKNOWN" },
      { inbound: null, safetyBufferHours: null, reason: "INVENTORY_UNKNOWN" },
      { inbound: null, safetyBufferHours: null, reason: "LEAD_TIME_MISSING" },
      { safetyBufferHours: null, reason: "LEAD_TIME_MISSING" },
    ],
    rejected: [
      { inbound: null, reason: "LEAD_TIME_MISSING" },
      { safetyBufferHours: null, reason: "INVENTORY_UNKNOWN" },
      { quarantine: null },
      { safetyBufferHours: false },
      { quarantine: 1.5 },
      { asOf: future },
      { externalSkuId: "sku/foreign" },
      { inbound: undefined },
      { oracle: null },
    ],
  },
];

const connectionSubject = { kind: "CONNECTION", connectionId: binding.connectionId };
const syncPayloadCase = {
  domain: "SYNC_TRANSITION",
  generation: 32,
  subject: connectionSubject,
  payload: {
    jobId: "job/1",
    fence: 0,
    stream: "PRODUCTS",
    status: "SUCCEEDED",
    errorCode: null,
    successfulThrough: periodEnd,
    watermark: null,
    businessObservedAt: periodEnd,
    transitionSequence: 1,
  },
  accepted: [
    { stream: "ORDERS", status: "FAILED", errorCode: "CONFLICT", successfulThrough: null },
    { stream: "INVENTORY", watermark: periodStart },
    { stream: "REFUNDS", watermark: periodEnd, successfulThrough: periodStart },
    { stream: "MARKETING", successfulThrough: null },
  ],
  rejected: [
    { status: "FAILED" },
    { errorCode: "TIMEOUT" },
    { status: "FAILED", errorCode: "UNKNOWN" },
    { status: "PENDING" },
    { errorCode: undefined },
    { stream: "CAMPAIGN" },
    { successfulThrough: future },
    { watermark: future },
    { businessObservedAt: periodStart },
    { transitionSequence: 0 },
    { fence: Number.MAX_SAFE_INTEGER + 1 },
    { jobId: true },
    { oracle: null },
  ],
};

async function syncConnectionIdentity({ client, factSchema }) {
  const spec = { ...syncPayloadCase, generation: 33 };
  const scopeId = await insertScope(client, {}, spec.generation);
  const fact = factSchema.parse(payloadFact(spec, 1, spec.payload));
  const { receipt } = await transaction(client, () =>
    insertOrigin(client, scopeId, "sync-bound", fact),
  );
  const other = { ...connectionSubject, connectionId: binding.connectionId.toUpperCase() };
  const mismatched = { ...fact, subject: other };
  assert.equal(factSchema.safeParse(mismatched).success, false);
  await assert.rejects(insertFact(client, scopeId, receipt, mismatched), {
    code: "23514",
    constraint: "observed_facts_connection_subject",
  });
  await assert.rejects(
    insertReceipt(client, scopeId, "sync-foreign", 0, {
      domain: fact.domain,
      subjectKind: other.kind,
      subjectId: other.connectionId,
    }),
    { code: "23514", constraint: "observed_receipts_connection_subject" },
  );
}

function payloadFact(spec, sequence, payload) {
  return priceFact(`typed-${spec.domain}-${sequence}`, sequence, null, {
    domain: spec.domain,
    generation: spec.generation,
    subject: spec.subject ?? subject,
    occurredAt: spec.observedAt ?? periodEnd,
    observedAt: spec.observedAt ?? periodEnd,
    payload,
  });
}

function registerPayloadCases(state, cases) {
  for (const spec of cases) {
    test(`${spec.label ?? spec.domain} admits contract payloads and rejects malformed typed payloads`, () =>
      validatePayloads(state, spec));
  }
}

async function validatePayloads({ client, factSchema }, spec) {
  const scopeId = await insertScope(client, {}, spec.generation);
  const accepted = [{}, ...(spec.accepted ?? [])];
  for (const [index, fields] of accepted.entries()) {
    const fact = factSchema.parse(payloadFact(spec, index + 1, { ...spec.payload, ...fields }));
    await transaction(client, () =>
      insertOrigin(client, scopeId, fact.factId, fact, null, spec.receiptWindow),
    );
  }
  const invalid = spec.rejected.map((fields) => ({ ...spec.payload, ...fields }));
  invalid.push(...(spec.shapes ?? []));
  for (const [index, payload] of invalid.entries()) {
    const fact = payloadFact(spec, accepted.length + index + 1, payload);
    // JSON has no undefined value. Round-trip so omitted keys match the exact bytes SQL receives.
    assert.equal(factSchema.safeParse(JSON.parse(JSON.stringify(fact))).success, false);
    await assert.rejects(
      transaction(client, () =>
        insertOrigin(client, scopeId, fact.factId, fact, null, spec.receiptWindow),
      ),
      { code: "23514", constraint: "observed_facts_payload_valid" },
      JSON.stringify(payload),
    );
  }
}

function registerMeasurementMemberships(state) {
  for (const spec of measurementPayloadCases) {
    for (const original of [true, false]) {
      const membership = original ? "original" : "later";
      test(`${spec.label ?? spec.domain} payload window fits its ${membership} receipt at commit`, () =>
        measurementMembership(state, spec, original));
    }
  }
}

function offsetMillisecond(time, delta) {
  return new Date(Date.parse(time) + delta).toISOString();
}

function receiptWindowCases(window) {
  const startEarlier = offsetMillisecond(window.periodStart, -1);
  const startLater = offsetMillisecond(window.periodStart, 1);
  const endEarlier = offsetMillisecond(window.periodEnd, -1);
  const endLater = offsetMillisecond(window.periodEnd, 1);
  return [
    ["exact", window, true],
    ["enclosing", { ...window, periodStart: startEarlier, periodEnd: endLater }, true],
    ["clipped-start", { ...window, periodStart: startLater }, false],
    ["clipped-end", { ...window, periodEnd: endEarlier }, false],
  ];
}

function appendWindowFixture(fact, receiptId, window, through) {
  return {
    binding: fact.binding,
    generation: fact.generation,
    domain: fact.domain,
    subject: fact.subject,
    window,
    publicationId: `publication-${receiptId}`,
    publicationHash: hash,
    pageId: `page-${receiptId}`,
    pageIndex: 0,
    pageHash: hash,
    priorPageHash: null,
    expectedCursor: null,
    nextCursor: null,
    terminalCoverage: { coverageBasisPoints: 10000 },
    grantId: "window-proof",
    fence: 0,
    through,
    records: [fact],
  };
}

async function measurementMembership({ client, factSchema, appendSchema }, measurement, original) {
  const spec = { ...measurement, generation: measurement.generation + (original ? 20 : 30) };
  const scopeId = await insertScope(client, {}, spec.generation);
  const fact = factSchema.parse(payloadFact(spec, 1, spec.payload));
  const inner = fact.payload.window;
  const factKey = original
    ? null
    : (
        await transaction(client, () =>
          insertOrigin(client, scopeId, "stored-measurement", fact, null, {
            ...inner,
            through: fact.observedAt,
          }),
        )
      ).factKey;
  for (const [index, [receiptId, window, allowed]] of receiptWindowCases(inner).entries()) {
    const candidate = original
      ? factSchema.parse(payloadFact(spec, index + 2, spec.payload))
      : fact;
    const through =
      candidate.observedAt > window.periodEnd ? candidate.observedAt : window.periodEnd;
    const parsed = appendSchema.safeParse(
      appendWindowFixture(candidate, receiptId, window, through),
    );
    assert.equal(parsed.success, allowed, receiptId);
    if (!parsed.success) assert.equal(parsed.error.issues[0].message, "INVALID_PAGE_RECORDS");
    await checkMeasurementCommit(client, scopeId, candidate, {
      receiptId,
      window: { ...window, through },
      factKey,
      allowed,
    });
  }
}

async function checkMeasurementCommit(
  client,
  scopeId,
  fact,
  { receiptId, window, factKey, allowed },
) {
  let wroteMembership = false;
  const commit = transaction(client, async () => {
    if (factKey === null) {
      await insertOrigin(client, scopeId, receiptId, fact, null, window);
    } else {
      const receipt = await insertReceipt(client, scopeId, receiptId, 1, {
        ...factPartition(fact),
        ...window,
      });
      await member(client, scopeId, receipt, factKey, 0, fact);
    }
    wroteMembership = true;
  });
  if (allowed) await commit;
  else {
    await assert.rejects(
      commit,
      { code: "23514", constraint: "observed_receipt_members_valid" },
      receiptId,
    );
    assert.equal(
      wroteMembership,
      true,
      "window validation belongs to the deferred membership check",
    );
  }
}

if (process.argv.includes(mode)) registerStorageCases();

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import process from "node:process";
import { after, before, test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import pg from "pg";
import { requireIsolatedDatabaseUrl } from "./helpers/isolated-postgres.mjs";

const root = new URL("../", import.meta.url);
const migrations = new URL("prisma/migrations/", root);
const mode = "--restricted-observed-storage";
const tables = [
  "observed_scopes",
  "observed_page_receipts",
  "observed_facts",
  "observed_receipt_members",
];

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

test("observed fact storage has one additive SQL migration and four mapped history tables", async () => {
  const names = (await readdir(migrations)).filter((name) =>
    /^\d{14}_observed_fact_storage$/u.test(name),
  );
  assert.equal(names.length, 1);
  const sql = await readFile(new URL(`${names[0]}/migration.sql`, migrations), "utf8");
  const prisma = await readFile(new URL("prisma/schema.prisma", root), "utf8");
  for (const table of tables) {
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

async function seedBinding(client) {
  await client.query(
    'INSERT INTO public."Merchant" (id, name, slug, "updatedAt") VALUES ($1, $1, $1, now())',
    ["observed-a"],
  );
  await client.query(
    `INSERT INTO public."Store" (id, "merchantId", name, city, platform, "organizationId", "workspaceId")
     VALUES ($1, $2, $1, $3, $4, $5, $6)`,
    [
      binding.storeId,
      "observed-a",
      "Shanghai",
      "MOCK",
      binding.organizationId,
      binding.workspaceId,
    ],
  );
  await client.query(
    `INSERT INTO public."PlatformConnection"
     (id, "organizationId", "workspaceId", "storeId", "externalStoreId", generation)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      binding.connectionId,
      binding.organizationId,
      binding.workspaceId,
      binding.storeId,
      binding.externalStoreId,
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
    domain: fact.domain,
    subjectKind: fact.subject.kind,
    subjectId: subjectId(fact.subject),
    ...window,
  });
  const factKey = await insertFact(client, scopeId, receipt, fact, priorSequence);
  await member(client, scopeId, receipt, factKey, 0, fact);
  return { receipt, factKey };
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
  const { ObservedFactV1Schema } = await import("@shopmate/contracts");
  state.factSchema = ObservedFactV1Schema;
  state.server = new pg.Client({ connectionString: validated });
  await state.server.connect();
  // This identifier is locally generated as SQL DDL cannot bind identifiers.
  const name = `shopmate_tenant_test_${randomBytes(8).toString("hex")}`;
  await state.server.query(`CREATE DATABASE "${name}"`);
  state.name = name;
  const testUrl = new URL(validated);
  testUrl.pathname = `/${name}`;
  state.url = requireIsolatedDatabaseUrl(testUrl.toString());
  prisma(state.url, ["migrate", "deploy"]);
  state.client = new pg.Client({ connectionString: state.url });
  await state.client.connect();
  await state.client.query("SELECT pg_catalog.set_config('TimeZone',$1,false)", [
    "Pacific/Auckland",
  ]);
  await seedBinding(state.client);
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

async function closeDatabase({ client, server, name }) {
  try {
    if (client) await client.end();
    if (name) await server.query(`DROP DATABASE "${name}"`);
  } finally {
    if (server) await server.end();
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
    "TRUNCATE public.observed_scopes, public.observed_page_receipts, public.observed_facts, public.observed_receipt_members",
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

if (process.argv.includes(mode)) registerStorageCases();

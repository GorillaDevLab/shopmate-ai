import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createSourceGroupGenerator,
  MockConfigSchema,
  openingTime,
} from "@shopmate/api/mock-generator";
import { eventTuple } from "@shopmate/database/mock-platform";
import {
  createSourceSession,
  grantSource,
  scopeFor,
  configFor,
  hashConfig,
} from "../../../packages/database/test/helpers/mock-platform-fixture.mjs";
import { advance } from "../../../packages/database/test/helpers/mock-source-publish-fixture.mjs";
import { buildSource } from "../../source-worker/dist/build.js";
import { generationTools } from "../../source-worker/dist/generation-tools.js";

export async function profileState(context, profile, full) {
  const suffix = randomUUID().slice(0, 8);
  const scope = {
    ...scopeFor(),
    storeId: `profile-store-${suffix}`,
    sessionId: `profile-session-${suffix}`,
    connectionId: `profile-connection-${suffix}`,
    externalStoreId: `mock/profile.${suffix}`,
  };
  await createSourceSession(context.admin, scope, profile, 180);
  const {
    dailyOrders: _orders,
    growthBps: _growth,
    refundBps: _refunds,
    adSpendMinor: _ads,
    ...base
  } = configFor(scope, profile, 180);
  const config = MockConfigSchema.parse(full ? base : { ...base, dailyOrders: 2, productCount: 6 });
  await context.admin.query(
    'UPDATE demo."DemoCommerceSession" SET config=$1,"configHash"=$2 WHERE id=$3',
    [config, hashConfig(config), scope.sessionId],
  );
  const actor = { grantId: `profile-source-${suffix}` };
  await grantSource(context.admin, scope, actor.grantId);
  assert.equal((await context.worker.initializeGeneration(actor, scope)).status, "CREATED");
  const until = new Date(Date.parse(config.historyStart) + 185 * 86_400_000).toISOString();
  await advance(context.admin, { scope }, until);
  return {
    scope,
    actor,
    config,
    until,
    opening: new Date(openingTime(config)).toISOString(),
  };
}

export async function publishProfile(context, state) {
  const generator = createSourceGroupGenerator(state.config),
    latest = new Map();
  let after = new Date(Date.parse(state.opening) - 1).toISOString(),
    eventCount = 0,
    publication;
  while (after < state.until) {
    const result = await buildSource(
      context.worker,
      { actor: state.actor, scope: state.scope },
      generationTools,
    );
    assert.equal(result.status, "PUBLISHED");
    publication = result.publication;
    for (const group of generator.window(after, publication.targetTime))
      for (const event of group.events) {
        latest.set(JSON.stringify(eventTuple(event).entityKey), event.after);
        eventCount++;
      }
    assert.equal(publication.highEventSeq, String(eventCount));
    after = publication.targetTime;
  }
  assert.equal(publication.targetTime, state.until);
  return { latest, eventCount, publication };
}

export async function createProfileGrant(admin, state) {
  const id = `profile-sync-${state.scope.sessionId}`;
  // The grant deliberately schedules a final backfill window; full snapshot reads retain all 180 days.
  const initialSince = new Date(Date.parse(state.until) - 86_400_000).toISOString();
  const scope = state.scope;
  await admin.query(
    'INSERT INTO sync_host."WorkerGrant" (id,"databaseRole","principalUserId","organizationId","workspaceId","storeId","connectionId","externalStoreId",provider,generation,"initialSince") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [
      id,
      "sync_worker_login",
      "source-worker",
      scope.organizationId,
      scope.workspaceId,
      scope.storeId,
      scope.connectionId,
      scope.externalStoreId,
      "MOCK",
      scope.generation,
      initialSince,
    ],
  );
  return id;
}

export async function sourceFacts(admin, state, oracle) {
  const rows = await admin.query(
    'SELECT DISTINCT ON (kind,"entityKey" COLLATE "C") kind,"entityKey",payload FROM mock_platform."EntityVersion" WHERE "sessionId"=$1 AND generation=$2 ORDER BY kind,"entityKey" COLLATE "C","eventSeq" DESC',
    [state.scope.sessionId, state.scope.generation],
  );
  assert.equal(rows.rowCount, oracle.latest.size);
  for (const row of rows.rows)
    assert.deepEqual(
      { ...row.payload, source: { ...row.payload.source, version: null } },
      oracle.latest.get(JSON.stringify(JSON.parse(row.entityKey))),
    );
  return rows.rows;
}

const listingQueries = [
  [
    "PRODUCT",
    'SELECT "externalProductId" AS id,"sourceVersion" AS version FROM commerce."ProductListing" WHERE "storeId"=$1',
  ],
  [
    "ORDER",
    'SELECT "externalOrderId" AS id,"sourceVersion" AS version FROM commerce."OrderListing" WHERE "storeId"=$1',
  ],
  [
    "REFUND",
    'SELECT "externalRefundId" AS id,"sourceVersion" AS version FROM commerce."RefundListing" WHERE "storeId"=$1',
  ],
  [
    "INVENTORY",
    'SELECT "externalSkuId" AS id,"externalLocationId" AS location,"sourceVersion" AS version FROM commerce."InventoryListing" WHERE "storeId"=$1',
  ],
  [
    "MARKETING",
    'SELECT "externalCampaignId" AS id,to_char(date,\'YYYY-MM-DD\') AS date,"sourceVersion" AS version FROM commerce."CampaignMetricListing" WHERE "storeId"=$1',
  ],
];
function expectedListing(row) {
  const payload = row.payload;
  const idFields = {
    PRODUCT: "externalProductId",
    ORDER: "externalOrderId",
    REFUND: "externalRefundId",
    INVENTORY: "externalSkuId",
    MARKETING: "externalCampaignId",
  };
  const id = payload[idFields[row.kind]];
  return {
    id,
    ...(row.kind === "INVENTORY" ? { location: payload.externalLocationId } : {}),
    ...(row.kind === "MARKETING" ? { date: payload.date } : {}),
    version: payload.source.version,
  };
}
export async function canonicalFacts(admin, state, facts) {
  const counts = {};
  for (const [kind, sql] of listingQueries) {
    const actual = (await admin.query(sql, [state.scope.storeId])).rows;
    const expected = facts.filter((row) => row.kind === kind).map(expectedListing);
    const sorted = (values) => values.map((value) => JSON.stringify(value)).sort();
    assert.deepEqual(
      sorted(actual),
      sorted(expected),
      `${kind} exact identity/version conservation`,
    );
    counts[kind] = actual.length;
  }
  Object.assign(counts, await canonicalChildren(admin, state, facts));
  return counts;
}

function sortedChildren(records) {
  const key = (record) =>
    JSON.stringify([
      record.externalProductId,
      record.externalSkuId,
      record.externalOrderId,
      record.externalLineId,
    ]);
  return [...records].sort((left, right) => key(left).localeCompare(key(right)));
}

async function canonicalChildren(admin, state, facts) {
  const skus = await admin.query(
    "SELECT to_jsonb(s)-ARRAY['scopeId','organizationId','workspaceId','storeId'] AS record FROM commerce.\"SkuListing\" s WHERE \"storeId\"=$1",
    [state.scope.storeId],
  );
  const lines = await admin.query(
    "SELECT to_jsonb(l)-ARRAY['scopeId','organizationId','workspaceId','storeId'] AS record FROM commerce.\"OrderLineListing\" l WHERE \"storeId\"=$1",
    [state.scope.storeId],
  );
  const expectedSkus = facts
    .filter((row) => row.kind === "PRODUCT")
    .flatMap((row) => row.payload.skus);
  const expectedLines = facts
    .filter((row) => row.kind === "ORDER")
    .flatMap((row) =>
      row.payload.items.map((item) => ({ ...item, externalOrderId: row.payload.externalOrderId })),
    );
  assert.deepEqual(
    sortedChildren(skus.rows.map((row) => row.record)),
    sortedChildren(expectedSkus),
    "complete SKU identities, attributes, prices and nullable costs",
  );
  assert.deepEqual(
    sortedChildren(lines.rows.map((row) => row.record)),
    sortedChildren(expectedLines),
    "complete order-line identities, quantities and minor-unit amounts",
  );
  return { SKU: skus.rowCount, ORDER_LINE: lines.rowCount };
}

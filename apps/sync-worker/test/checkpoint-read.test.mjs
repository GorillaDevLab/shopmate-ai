import assert from "node:assert/strict";
import test from "node:test";
import * as source from "@shopmate/database/mock-platform";
import { createMockSourceReadPorts } from "@shopmate/database/mock-platform-read";
import { CheckpointReadPort } from "../dist/checkpoint-read.js";
import { createLatestCursor } from "../../../packages/database/dist/src/mock-platform/latest-cursor.js";
import {
  leasePortDatabase,
  closeLeasePortDatabase,
} from "../../../packages/database/test/helpers/mock-source-lease-port-fixture.mjs";
import { preparedAppend } from "../../../packages/database/test/helpers/mock-source-append-port-fixture.mjs";
import { readerActor } from "../../../packages/database/test/helpers/mock-platform-fixture.mjs";
import {
  publishReadProducts,
  advanceReadPublication,
} from "../../../packages/database/test/helpers/mock-source-read-port-fixture.mjs";

let context, readers;
const control = () => ({ deadlineAt: new Date(Date.now() + 5000).toISOString() });
const options = () => ({ requestId: "resume-page", ...control() });
test.before(async () => {
  context = await leasePortDatabase(source, "synccheckpoint");
  context.env.MOCK_SOURCE_CURSOR_KEY = "k".repeat(32);
  readers = createMockSourceReadPorts(context.env);
});
test.after(async () => {
  await readers?.close();
  if (context) await closeLeasePortDatabase(context);
});

async function expiredRead() {
  const state = await preparedAppend(context);
  const publication = await publishReadProducts(context, state);
  const request = {
    kind: "PRODUCT",
    requestedUntil: publication.targetTime,
    businessNow: publication.targetTime,
    limit: 1,
    contextHash: "a".repeat(64),
  };
  const port = readers.bind(readerActor, state.scope);
  const first = await port.read(request, control());
  const oldNow = Date.now() - 20 * 60_000;
  const cursor = createLatestCursor(
    context.env.MOCK_SOURCE_CURSOR_KEY,
    state.scope,
    publication,
    {
      kind: request.kind,
      limit: request.limit,
      until: request.requestedUntil,
      contextHash: request.contextHash,
    },
    first.items[0],
    oldNow + 60_000,
    oldNow,
  );
  return { state, publication, request: { ...request, cursor } };
}

test("restarted adapter automatically recovers an expired persisted cursor without repinning later releases", async () => {
  const { state, publication, request } = await expiredRead();
  const future = new Date(Date.parse(publication.targetTime) + 60_000).toISOString();
  await advanceReadPublication(context, state, future);
  await publishReadProducts(context, state, ["c-new"]);
  await readers.close();
  readers = createMockSourceReadPorts(context.env);
  const bound = readers.bind(readerActor, state.scope);
  const resumed = { ...request, businessNow: future, requestedUntil: future };
  await assert.rejects(bound.read(resumed, control()), { code: "SOURCE_INPUT" });
  const page = await new CheckpointReadPort(bound).read(resumed, options());
  assert.equal(page.publication.certificateHash, publication.certificateHash);
  assert.equal(page.effectiveUntil, publication.targetTime);
  assert.deepEqual(
    page.items.map((item) => item.payload.externalProductId),
    ["b"],
  );
  assert.equal(page.nextCursor, null);
  assert.equal(resumed.cursor, request.cursor);
});

test("automatic recovery refuses altered query and current membership revocation", async () => {
  const { state, request } = await expiredRead();
  const port = new CheckpointReadPort(readers.bind(readerActor, state.scope));
  await assert.rejects(port.read({ ...request, contextHash: "b".repeat(64) }, options()), {
    code: "SOURCE_INPUT",
  });
  await context.admin.query(
    'UPDATE "OrganizationMember" SET status=$1 WHERE "organizationId"=$2 AND "userId"=$3',
    ["INACTIVE", state.scope.organizationId, readerActor.userId],
  );
  try {
    assert.equal(await port.read(request, options()), null);
  } finally {
    await context.admin.query(
      'UPDATE "OrganizationMember" SET status=$1 WHERE "organizationId"=$2 AND "userId"=$3',
      ["ACTIVE", state.scope.organizationId, readerActor.userId],
    );
  }
});

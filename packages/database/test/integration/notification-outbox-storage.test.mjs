import assert from "node:assert/strict";
import nodeTest from "node:test";

function test(name, run) {
  return nodeTest(name, { timeout: 90_000 }, run);
}
import {
  database,
  fixture,
  prisma,
  drift,
  migrate,
  notificationMigration,
  historyHashes,
  seedBinding,
  members,
} from "../helpers/notification-outbox-fixture.mjs";
import {
  catalog,
  dedup,
  wideIdentifiers,
  foreignKeys,
  memberships,
  scopes,
  allowlist,
  states,
  workerAuthority,
  recipientBoundary,
  projection,
  rollback,
  markRead,
} from "../helpers/notification-outbox-cases.mjs";
import { reconstruction } from "../helpers/notification-outbox-mapping.mjs";

test("notification 01: fresh ordered Prisma deployment is drift free", () =>
  database(async (state) => {
    prisma(state.url, ["migrate", "deploy"]);
    drift(state.url);
    assert.equal(
      (await state.admin.query("SELECT count(*) FROM notification_worker_grants")).rows[0].count,
      "0",
    );
  }));
test("notification 02: prior history upgrades without changing tenant rows or migration checksums", () =>
  database(async (state) => {
    const hashes = await historyHashes();
    await migrate(state.admin, true);
    await seedBinding(state.admin);
    await members(state.admin);
    const before = (await state.admin.query('SELECT * FROM "PlatformConnection"')).rows;
    await notificationMigration(state.admin);
    assert.deepEqual((await state.admin.query('SELECT * FROM "PlatformConnection"')).rows, before);
    assert.deepEqual(await historyHashes(), hashes);
    drift(state.url);
  }));
test("notification 03: safe capability catalog, exact privileges and pending round trip", () =>
  fixture(catalog));
test("notification 04: two real sessions contend on natural identity and retain durable first receipt", () =>
  fixture(dedup));
test("notification 05: both exact indexes support maximal UTF16 opaque identifiers", () =>
  fixture(wideIdentifiers));
test("notification 06: compound parent and recipient FKs plus live inactive scope denial", () =>
  fixture(foreignKeys));
test("notification 07: inherited owner admin and assigned operator require current writer membership", () =>
  fixture(memberships));
test("notification 08: every binding setting, actor and isolation level fails closed", () =>
  fixture(scopes));
test("notification 09: normalized allowlist validates entity matrix and forbids raw payload", () =>
  fixture(allowlist));
test("notification 10: total receipt state matrix enforces scheduling and immutable terminal state", () =>
  fixture(states));
test("notification 11: real worker identity needs current grant principal binding and generation", () =>
  fixture(workerAuthority));
test("notification 12: direct recipient SQL sees only own public delivered rows", () =>
  fixture(recipientBoundary));
test("notification 13: first confirmed delivery atomically projects exactly one immutable inbox", () =>
  fixture(projection));
test("notification 14: delivery and parent mutation roll back with outbox and inbox together", () =>
  fixture(rollback));
test("notification 15: first self read persists and current revocation immediately hides history", () =>
  fixture(markRead));
test("notification 16: internal receipt and strict public DTO reconstruct current confirmed read", () =>
  fixture(reconstruction));

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const root = new URL("../", import.meta.url);
const name = "20261103100000_notification_outbox";
const migration = new URL(`prisma/migrations/${name}/migration.sql`, root);
const sql = async () => readFile(migration, "utf8");

test("notification migration follows the audit foundation chronologically", async () => {
  const names = (await readdir(new URL("prisma/migrations/", root))).sort();
  assert.ok(names.includes(name), "notification migration must exist");
  assert.ok(names.indexOf(name) > names.indexOf("20261103090000_audit_append_foundation"));
});
test("normalized outbox, delivered inbox and private worker grants have no payload", async () => {
  const source = await sql();
  for (const table of ["notification_outbox", "recipient_inbox", "notification_worker_grants"])
    assert.match(source, new RegExp(`CREATE TABLE public.${table} \\(`));
  assert.doesNotMatch(source, /\b(?:JSONB?|payload|audit_\w+|metric_\w+)\b/iu);
  assert.match(source, /notification_outbox_natural_key/u);
  assert.match(source, /notification_outbox_intent_key/u);
  assert.match(source, /REFERENCES public\."PlatformConnection"/u);
  assert.match(source, /REFERENCES public\."OrganizationMember"/u);
});
test("states use total predicates, safe integer and finite millisecond timestamps", async () => {
  const source = await sql();
  for (const word of [
    "IS TRUE",
    "IS NOT NULL",
    "IS NULL",
    "9007199254740991",
    "isfinite",
    'COLLATE "C"',
    "notification_literal",
  ])
    assert.ok(source.includes(word), word);
  assert.match(source, /notification_outbox_state_check/u);
  assert.match(source, /notification_outbox_immutable/u);
  assert.match(source, /recipient_inbox_immutable/u);
});
test("Prisma maps physical outbox inbox and worker binding tables", async () => {
  const schema = await readFile(new URL("prisma/schema.prisma", root), "utf8");
  for (const model of ["NotificationOutboxRow", "RecipientInboxRow", "NotificationWorkerGrantRow"])
    assert.match(schema, new RegExp(`model ${model} \\{`));
  for (const table of ["notification_outbox", "recipient_inbox", "notification_worker_grants"])
    assert.ok(schema.includes(`@@map("${table}")`));
});

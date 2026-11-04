import assert from "node:assert/strict";
import {
  createNotificationIntentKey,
  NotificationIntentSchema,
  DeliveryReceiptSchema,
  NotificationInboxItemSchema,
  NotificationReadConfirmationSchema,
} from "@shopmate/contracts";
import {
  count,
  deliver,
  later,
  pending,
  insert,
  update,
  lease,
} from "./notification-outbox-fixture.mjs";

function integer(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error("Unsafe stored notification integer");
  return result;
}
function iso(value) {
  return value === null ? null : value.toISOString();
}
function entityFor(row) {
  const entity =
    row.entityKind === "STORE"
      ? { kind: "STORE" }
      : row.entityKind === "SKU"
        ? { kind: "SKU", externalSkuId: row.entityId }
        : row.entityKind === "CAMPAIGN"
          ? { kind: "CAMPAIGN", externalCampaignId: row.entityId }
          : { kind: "CONNECTION", connectionId: row.entityId };
  return entity;
}
function toIntent(row) {
  const binding = Object.fromEntries(
    ["organizationId", "workspaceId", "storeId", "connectionId", "externalStoreId"].map((key) => [
      key,
      row[key],
    ]),
  );
  const identity = {
    recipient: { binding, userId: row.recipientUserId },
    eventId: row.eventId,
    eventState: row.eventState,
    eventRevision: integer(row.eventRevision),
    channel: row.channel,
  };
  return NotificationIntentSchema.parse({
    schemaVersion: 1,
    id: row.intentId,
    ...identity,
    evidence: {
      schemaVersion: 1,
      id: row.evidenceId,
      version: row.evidenceVersion,
      hash: row.evidenceHash,
      binding,
      eventType: row.eventType,
      entity: entityFor(row),
      definitionVersion: row.definitionVersion,
      baselineVersion: row.baselineVersion,
    },
    decisionRunId: row.decisionRunId,
    route: row.route,
    createdAt: iso(row.createdAt),
    notBefore: iso(row.notBefore),
    dedupKey: createNotificationIntentKey(identity),
    summary: { eventType: row.eventType, severity: row.severity },
  });
}
function toReceipt(row, inbox) {
  if (row.status === "DELIVERED" && inbox === null)
    throw new Error("Delivered notification projection missing");
  return DeliveryReceiptSchema.parse({
    schemaVersion: 1,
    intent: toIntent(row),
    status: row.status,
    attempt: integer(row.attempt),
    nextAttemptAt: iso(row.nextAttemptAt),
    leaseToken: row.leaseToken,
    leaseUntil: iso(row.leaseUntil),
    deliveredAt: iso(row.deliveredAt),
    readAt: iso(inbox?.readAt ?? null),
    readState: row.status === "UNKNOWN" ? "UNKNOWN" : inbox?.readAt ? "READ" : "UNREAD",
  });
}
function toInbox(row) {
  return NotificationInboxItemSchema.parse({
    schemaVersion: 1,
    status: "DELIVERED",
    intent: toIntent(row),
    deliveredAt: iso(row.deliveredAt),
    readAt: iso(row.readAt),
    readState: row.readAt ? "READ" : "UNREAD",
  });
}
export async function reconstruction(state) {
  const row = await deliver(state);
  const unread = toInbox((await state.recipient.query("SELECT * FROM recipient_inbox")).rows[0]);
  assert.deepEqual(
    Object.keys(unread).sort(),
    ["schemaVersion", "status", "intent", "deliveredAt", "readAt", "readState"].sort(),
  );
  assert.equal(NotificationReadConfirmationSchema.safeParse(unread).success, false);
  await state.recipient.query('UPDATE recipient_inbox SET "readAt"=$1 WHERE "outboxId"=$2', [
    later,
    row.rowId,
  ]);
  const inbox = (await state.recipient.query("SELECT * FROM recipient_inbox")).rows[0];
  const item = toInbox(inbox);
  assert.equal(NotificationReadConfirmationSchema.safeParse(item).success, true);
  for (const client of [state.enqueuer, state.worker]) {
    const stored = (
      await client.query('SELECT * FROM notification_outbox WHERE "rowId"=$1', [row.rowId])
    ).rows[0];
    const projected = (
      await client.query('SELECT "readAt" FROM recipient_inbox WHERE "outboxId"=$1', [row.rowId])
    ).rows[0];
    assert.equal(toReceipt(stored, projected).readAt, later);
    assert.deepEqual(toReceipt(stored, projected).intent, item.intent);
    assert.throws(() => toReceipt(stored, null), /projection missing/u);
    assert.throws(() => toIntent({ ...stored, eventRevision: "9007199254740992" }), /Unsafe/u);
  }
  assert.equal(await count(state.recipient, "recipient_inbox"), 1);
  await receiptStates(state);
}
async function receiptStates(state) {
  let row = (await insert(state.enqueuer, pending())).rows[0];
  assert.equal(toReceipt(row, null).status, "PENDING");
  row = (await lease(state.worker, row.rowId)).rows[0];
  assert.equal(toReceipt(row, null).status, "LEASED");
  for (const status of ["FAILED", "UNKNOWN"])
    for (const nextAttemptAt of [null, later]) {
      row = (
        await update(state.worker, row.rowId, {
          status,
          nextAttemptAt,
          leaseToken: null,
          leaseUntil: null,
        })
      ).rows[0];
      assert.equal(toReceipt(row, null).readState, status === "UNKNOWN" ? "UNKNOWN" : "UNREAD");
    }
}

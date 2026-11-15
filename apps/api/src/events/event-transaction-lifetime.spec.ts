import { expect, it } from "vitest";
import { EventTransactionLifetime } from "./event-transaction-lifetime.js";

it("closes initiation and drains outstanding work before reuse", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const lifetime = new EventTransactionLifetime(
    {
      query: async () => {
        await pending;
        return { rows: [], rowCount: 0 };
      },
    },
    () => true,
  );
  const query = lifetime.client.query("SELECT 1");
  lifetime.close();
  await expect(lifetime.client.query("SELECT 2")).rejects.toThrow("Event runtime unavailable");
  let drained = false;
  const drain = lifetime.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  finish();
  await query;
  await drain;
  expect(drained).toBe(true);
  expect(lifetime.isActive()).toBe(false);
});
it("retains a caught transport failure and rejects expired initiation", async () => {
  const lifetime = new EventTransactionLifetime(
    {
      query: async () => {
        throw new Error("private");
      },
    },
    () => true,
  );
  await expect(lifetime.client.query("SELECT 1")).rejects.toThrow("private");
  lifetime.close();
  await expect(lifetime.drain()).rejects.toThrow("Event runtime unavailable");
  const expired = new EventTransactionLifetime(
    { query: async () => ({ rows: [], rowCount: 0 }) },
    () => false,
  );
  await expect(expired.client.query("SELECT 1")).rejects.toThrow("Event runtime unavailable");
});

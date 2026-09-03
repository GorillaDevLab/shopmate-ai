import { URL } from "node:url";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const migrationsDirectory = new URL("../prisma/migrations/", import.meta.url);

test("initial migration contains core tables and database constraints", async () => {
  const entries = await readdir(migrationsDirectory);

  const initialMigration = entries.find((entry) => entry.endsWith("_initial_schema"));

  assert.ok(initialMigration, "initial_schema migration must exist");

  const sql = await readFile(
    new URL(`../prisma/migrations/${initialMigration}/migration.sql`, import.meta.url),
    "utf8",
  );

  assert.match(sql, /CREATE TABLE "Merchant"/);
  assert.match(sql, /CREATE TABLE "Product"/);
  assert.match(sql, /CREATE TABLE "Sku"/);
  assert.match(sql, /CREATE TABLE "Order"/);
  assert.match(sql, /CREATE TABLE "OrderItem"/);

  assert.match(sql, /Sku_inventory_nonnegative_check/);
  assert.match(sql, /Sku_alertThreshold_nonnegative_check/);
  assert.match(sql, /OrderItem_quantity_positive_check/);
});

test("monitoring migration scopes rules and deduplicates notifications", async () => {
  const entries = await readdir(migrationsDirectory);
  const monitoringMigration = entries.find((entry) => entry.endsWith("_monitoring_rules"));

  assert.ok(monitoringMigration, "monitoring_rules migration must exist");

  const sql = await readFile(
    new URL(`../prisma/migrations/${monitoringMigration}/migration.sql`, import.meta.url),
    "utf8",
  );

  assert.match(sql, /CREATE TABLE "UserMonitoringRule"/);
  assert.match(sql, /CREATE TABLE "MonitoringNotification"/);
  assert.match(sql, /MonitoringNotification_userId_merchantId_fingerprint_key/);
  assert.match(sql, /ON DELETE CASCADE/);
});

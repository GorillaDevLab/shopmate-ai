import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const migrationsDirectory = new URL("../prisma/migrations/", import.meta.url);

test("dashboard layout migration isolates users and enforces optimistic revisions", async () => {
  const entries = await readdir(migrationsDirectory);
  const migration = entries.find((entry) => entry.endsWith("_user_dashboard_layout"));
  assert.ok(migration, "user_dashboard_layout migration must exist");

  const sql = await readFile(
    new URL(`../prisma/migrations/${migration}/migration.sql`, import.meta.url),
    "utf8",
  );

  assert.match(sql, /CREATE TABLE "UserDashboardLayout"/);
  assert.match(sql, /"userId" TEXT NOT NULL/);
  assert.match(sql, /"merchantId" TEXT NOT NULL/);
  assert.match(sql, /"layout" JSONB NOT NULL/);
  assert.match(sql, /"revision" INTEGER NOT NULL DEFAULT 1/);
  assert.match(sql, /UserDashboardLayout_userId_merchantId_key/);
  assert.match(sql, /UserDashboardLayout_revision_positive_check/);
  assert.match(sql, /REFERENCES "Merchant"\("id"\) ON DELETE CASCADE/);
});

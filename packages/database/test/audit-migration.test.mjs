import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const migration = new URL(
  "../prisma/migrations/20261103090000_audit_append_foundation/migration.sql",
  import.meta.url,
);
test("audit foundation installs scoped immutable tenant and separate anonymous storage offline", async () => {
  const sql = await readFile(migration, "utf8");
  for (const table of ["audit_logs", "audit_checkpoints", "auth_security_events"])
    assert.match(sql, new RegExp(`CREATE TABLE public.${table}`));
  assert.match(sql, /FOREIGN KEY \("organizationId","workspaceId","storeId"\)/u);
  assert.match(sql, /pg_advisory_xact_lock/u);
  assert.match(sql, /CREATE FUNCTION public.audit_chain_head/u);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/u);
  assert.match(sql, /REVOKE ALL ON FUNCTION/u);
  assert.doesNotMatch(sql, /CREATE ROLE[^;]* LOGIN\b/u);
});

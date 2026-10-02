import assert from "node:assert/strict";
import test from "node:test";
import { readTenantBootstrapRequest, assertBootstrapEnvironment } from "../src/tenant-bootstrap.js";

const environment = {
  APP_ENV: "test",
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://operator@127.0.0.1:5432/shopmate_tenant_test",
  TENANT_BOOTSTRAP_USER_ID: "user-a",
  TENANT_BOOTSTRAP_MERCHANT_ID: "merchant-a",
};
test("tenant bootstrap defaults to dry run and viewer", () => {
  const request = readTenantBootstrapRequest(environment);
  assert.equal(request.apply, false);
  assert.equal(request.role, "VIEWER");
  assert.doesNotThrow(() => assertBootstrapEnvironment(request, "TEST"));
});
test("tenant bootstrap requires exact environment opt-in and valid identifiers", () => {
  for (const overrides of [
    { APP_ENV: "production" },
    { APP_ENV: "" },
    { APP_ENV: "unknown" },
    { NODE_ENV: "production" },
    { TENANT_BOOTSTRAP_USER_ID: "bad id" },
    { TENANT_BOOTSTRAP_MERCHANT_ID: "x".repeat(129) },
    { TENANT_BOOTSTRAP_ROLE: "SUPERADMIN" },
    { TENANT_BOOTSTRAP_APPLY: "yes" },
    { DATABASE_URL: "postgresql://operator@remote.test/shopmate_tenant_test" },
    { DATABASE_URL: "postgresql://operator@localhost/production" },
    { DATABASE_URL: "postgresql://operator@localhost/shopmate_tenant_test?host=remote.test" },
  ])
    assert.throws(() => readTenantBootstrapRequest({ ...environment, ...overrides }));
});
test("tenant bootstrap refuses missing, mismatched and production database markers", () => {
  const request = readTenantBootstrapRequest(environment);
  for (const marker of [undefined, "UNCONFIGURED", "DEMO", "PRODUCTION"]) {
    assert.throws(() => assertBootstrapEnvironment(request, marker));
  }
});

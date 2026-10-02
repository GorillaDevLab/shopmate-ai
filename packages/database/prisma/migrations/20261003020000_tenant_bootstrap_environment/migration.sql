BEGIN;
CREATE TABLE "TenantBootstrapEnvironment" (
  id TEXT PRIMARY KEY CHECK (id = 'singleton'),
  environment TEXT NOT NULL DEFAULT 'UNCONFIGURED'
    CHECK (environment IN ('UNCONFIGURED','LOCAL','TEST','DEMO','PRODUCTION'))
);
INSERT INTO "TenantBootstrapEnvironment" (id) VALUES ('singleton');
REVOKE ALL ON "TenantBootstrapEnvironment" FROM PUBLIC;
COMMIT;

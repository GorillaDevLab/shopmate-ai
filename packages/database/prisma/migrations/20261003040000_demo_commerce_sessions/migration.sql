BEGIN;
CREATE SCHEMA IF NOT EXISTS demo;
-- CreateTable
CREATE TABLE "DemoTenant" (
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "DemoTenant_pkey" PRIMARY KEY ("organizationId")
);
-- CreateTable
CREATE TABLE "PlatformConnection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "externalStoreId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'MOCK',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "generation" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PlatformConnection_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "demo"."DemoCommerceSession" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalStoreId" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "configHash" TEXT NOT NULL,
    "generatorVersion" TEXT NOT NULL,
    "clockNow" TIMESTAMP(3) NOT NULL,
    "clockRevision" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DemoCommerceSession_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "demo"."DemoControlAudit" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "beforeRevision" INTEGER,
    "afterRevision" INTEGER NOT NULL,
    "generation" INTEGER NOT NULL,
    "configHash" TEXT NOT NULL,
    "clockNow" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemoControlAudit_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "PlatformConnection_storeId_provider_key" ON "PlatformConnection"("storeId", "provider");
-- CreateIndex
CREATE UNIQUE INDEX "PlatformConnection_id_organizationId_workspaceId_storeId_ex_key" ON "PlatformConnection"("id", "organizationId", "workspaceId", "storeId", "externalStoreId");
-- CreateIndex
CREATE UNIQUE INDEX "DemoCommerceSession_storeId_key" ON "demo"."DemoCommerceSession"("storeId");
-- CreateIndex
CREATE UNIQUE INDEX "DemoCommerceSession_connectionId_key" ON "demo"."DemoCommerceSession"("connectionId");
-- CreateIndex
CREATE UNIQUE INDEX "DemoCommerceSession_id_organizationId_workspaceId_storeId_c_key" ON "demo"."DemoCommerceSession"("id", "organizationId", "workspaceId", "storeId", "connectionId");
-- CreateIndex
CREATE INDEX "DemoControlAudit_organizationId_workspaceId_sessionId_idx" ON "demo"."DemoControlAudit"("organizationId", "workspaceId", "sessionId");
-- CreateIndex
CREATE UNIQUE INDEX "Store_organizationId_workspaceId_id_key" ON "Store"("organizationId", "workspaceId", "id");
-- AddForeignKey
ALTER TABLE "DemoTenant" ADD CONSTRAINT "DemoTenant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "PlatformConnection" ADD CONSTRAINT "PlatformConnection_organizationId_workspaceId_storeId_fkey" FOREIGN KEY ("organizationId", "workspaceId", "storeId") REFERENCES "Store"("organizationId", "workspaceId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "demo"."DemoCommerceSession" ADD CONSTRAINT "DemoCommerceSession_connectionId_organizationId_workspaceI_fkey" FOREIGN KEY ("connectionId", "organizationId", "workspaceId", "storeId", "externalStoreId") REFERENCES "PlatformConnection"("id", "organizationId", "workspaceId", "storeId", "externalStoreId") ON DELETE RESTRICT ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "demo"."DemoControlAudit" ADD CONSTRAINT "DemoControlAudit_sessionId_organizationId_workspaceId_stor_fkey" FOREIGN KEY ("sessionId", "organizationId", "workspaceId", "storeId", "connectionId") REFERENCES "demo"."DemoCommerceSession"("id", "organizationId", "workspaceId", "storeId", "connectionId") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "PlatformConnection"
  ADD CONSTRAINT "PlatformConnection_provider_check" CHECK (provider = 'MOCK'),
  ADD CONSTRAINT "PlatformConnection_status_check" CHECK (status IN ('ACTIVE','DISCONNECTED')),
  ADD CONSTRAINT "PlatformConnection_generation_check" CHECK (generation >= 0),
  ADD CONSTRAINT "PlatformConnection_externalStoreId_check" CHECK (length("externalStoreId") BETWEEN 1 AND 200);
ALTER TABLE demo."DemoCommerceSession"
  ADD CONSTRAINT "DemoCommerceSession_counters_check" CHECK (revision >= 0 AND "clockRevision" >= 0),
  ADD CONSTRAINT "DemoCommerceSession_hash_check" CHECK ("configHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "DemoCommerceSession_version_check" CHECK ("generatorVersion" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'),
  ADD CONSTRAINT "DemoCommerceSession_clock_check" CHECK ("clockNow" >= timestamp '0001-01-01' AND "clockNow" <= timestamp '9999-12-31 23:59:59.999'),
  ADD CONSTRAINT "DemoCommerceSession_binding_check" CHECK ((
    jsonb_typeof(config) = 'object' AND jsonb_typeof(config->'binding') = 'object'
    AND config->'binding'->'organizationId' = to_jsonb("organizationId")
    AND config->'binding'->'workspaceId' = to_jsonb("workspaceId")
    AND config->'binding'->'storeId' = to_jsonb("storeId")
    AND config->'binding'->'connectionId' = to_jsonb("connectionId")
    AND config->'binding'->'externalStoreId' = to_jsonb("externalStoreId")) IS TRUE);
ALTER TABLE demo."DemoControlAudit"
  ADD CONSTRAINT "DemoControlAudit_kind_check" CHECK (kind IN ('CREATE','ADVANCE','RESET','DISCONNECT')),
  ADD CONSTRAINT "DemoControlAudit_counters_check" CHECK ("beforeRevision" >= 0 AND "afterRevision" >= 0 AND generation >= 0),
  ADD CONSTRAINT "DemoControlAudit_hash_check" CHECK ("configHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "DemoControlAudit_clock_check" CHECK ("clockNow" >= timestamp '0001-01-01' AND "clockNow" <= timestamp '9999-12-31 23:59:59.999');

-- Invoker rights preserve the existing membership/workspace RLS; no bypass identity is used.
CREATE FUNCTION demo.has_store_access(org_id TEXT, workspace_id TEXT, store_id TEXT, writable BOOLEAN)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY INVOKER SET search_path = pg_catalog,public,demo AS $$
  SELECT EXISTS (
    SELECT 1 FROM public."Store" s
    JOIN public."Organization" o ON o.id=s."organizationId" AND o."legacyMerchantId"=s."merchantId"
    JOIN public."Workspace" w ON w.id=s."workspaceId" AND w."organizationId"=o.id
    JOIN public."OrganizationMember" m ON m."organizationId"=o.id
    JOIN public."DemoTenant" d ON d."organizationId"=o.id
    JOIN public."TenantBootstrapEnvironment" e ON e.id='singleton' AND e.environment='DEMO'
    WHERE s.id=store_id AND o.id=org_id AND w.id=workspace_id
      AND m."userId"=current_setting('app.user_id',true)
      AND m.status='ACTIVE' AND o.status='ACTIVE' AND w.status='ACTIVE'
      AND (NOT writable OR m.role IN ('OWNER','ADMIN'))
      AND (m.role IN ('OWNER','ADMIN') OR EXISTS (
        SELECT 1 FROM public."WorkspaceMember" wm WHERE wm."organizationId"=o.id
          AND wm."workspaceId"=w.id AND wm."userId"=m."userId" AND wm.status='ACTIVE'))
  )
$$;

-- Stable ownership prevents an administrator from repurposing a connection or session.
CREATE FUNCTION demo.preserve_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['config','configHash','generatorVersion','clockNow','clockRevision','revision','generation','status'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['config','configHash','generatorVersion','clockNow','clockRevision','revision','generation','status']) THEN
    RAISE EXCEPTION 'Demo ownership is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER demo_connection_binding BEFORE UPDATE ON "PlatformConnection"
FOR EACH ROW EXECUTE FUNCTION demo.preserve_binding();
CREATE TRIGGER demo_session_binding BEFORE UPDATE ON demo."DemoCommerceSession"
FOR EACH ROW EXECUTE FUNCTION demo.preserve_binding();

ALTER TABLE "DemoTenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DemoTenant" FORCE ROW LEVEL SECURITY;
CREATE POLICY demo_tenant_read ON "DemoTenant" FOR SELECT USING (
  EXISTS (SELECT 1 FROM "Organization" o WHERE o.id="DemoTenant"."organizationId" AND o.status='ACTIVE')
  AND EXISTS (SELECT 1 FROM "TenantBootstrapEnvironment" e WHERE e.id='singleton' AND e.environment='DEMO'));
ALTER TABLE "PlatformConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlatformConnection" FORCE ROW LEVEL SECURITY;
CREATE POLICY demo_connection_read ON "PlatformConnection" FOR SELECT
  USING (demo.has_store_access("organizationId","workspaceId","storeId",false));
CREATE POLICY demo_connection_insert ON "PlatformConnection" FOR INSERT
  WITH CHECK (demo.has_store_access("organizationId","workspaceId","storeId",true));
CREATE POLICY demo_connection_update ON "PlatformConnection" FOR UPDATE
  USING (demo.has_store_access("organizationId","workspaceId","storeId",true))
  WITH CHECK (demo.has_store_access("organizationId","workspaceId","storeId",true));
ALTER TABLE demo."DemoCommerceSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo."DemoCommerceSession" FORCE ROW LEVEL SECURITY;
CREATE POLICY demo_session_read ON demo."DemoCommerceSession" FOR SELECT
  USING (demo.has_store_access("organizationId","workspaceId","storeId",false));
CREATE POLICY demo_session_insert ON demo."DemoCommerceSession" FOR INSERT
  WITH CHECK (demo.has_store_access("organizationId","workspaceId","storeId",true));
CREATE POLICY demo_session_update ON demo."DemoCommerceSession" FOR UPDATE
  USING (demo.has_store_access("organizationId","workspaceId","storeId",true))
  WITH CHECK (demo.has_store_access("organizationId","workspaceId","storeId",true));
ALTER TABLE demo."DemoControlAudit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo."DemoControlAudit" FORCE ROW LEVEL SECURITY;
CREATE POLICY demo_audit_read ON demo."DemoControlAudit" FOR SELECT
  USING (demo.has_store_access("organizationId","workspaceId","storeId",false));
CREATE POLICY demo_audit_insert ON demo."DemoControlAudit" FOR INSERT WITH CHECK (
  "actorUserId"=current_setting('app.user_id',true)
  AND demo.has_store_access("organizationId","workspaceId","storeId",true));

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA demo FROM PUBLIC;
REVOKE ALL ON "DemoTenant","PlatformConnection",demo."DemoCommerceSession",demo."DemoControlAudit" FROM PUBLIC;
REVOKE ALL ON FUNCTION demo.has_store_access(TEXT,TEXT,TEXT,BOOLEAN),demo.preserve_binding() FROM PUBLIC;
COMMIT;

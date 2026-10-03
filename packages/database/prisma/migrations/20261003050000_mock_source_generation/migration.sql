BEGIN;
CREATE SCHEMA mock_platform;
-- These groups carry capabilities, never credentials. Operators provision separate logins.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shopmate_mock_source_reader') THEN
    CREATE ROLE shopmate_mock_source_reader NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shopmate_mock_source_worker') THEN
    CREATE ROLE shopmate_mock_source_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

CREATE UNIQUE INDEX "DemoCommerceSession_source_binding_key" ON demo."DemoCommerceSession"
  (id,"organizationId","workspaceId","storeId","connectionId","externalStoreId");
CREATE TABLE demo."MockWorkerGrant" (
  id TEXT NOT NULL PRIMARY KEY,
  "databaseRole" TEXT NOT NULL,
  "principalUserId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "externalStoreId" TEXT NOT NULL,
  operation TEXT NOT NULL DEFAULT 'SOURCE_BUILD',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  CONSTRAINT "MockWorkerGrant_membership_fkey" FOREIGN KEY ("organizationId","principalUserId") REFERENCES public."OrganizationMember"("organizationId","userId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "MockWorkerGrant_workspace_fkey" FOREIGN KEY ("organizationId","workspaceId","principalUserId") REFERENCES public."WorkspaceMember"("organizationId","workspaceId","userId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "MockWorkerGrant_session_fkey" FOREIGN KEY ("sessionId","organizationId","workspaceId","storeId","connectionId","externalStoreId") REFERENCES demo."DemoCommerceSession"(id,"organizationId","workspaceId","storeId","connectionId","externalStoreId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "MockWorkerGrant_values_check" CHECK (operation='SOURCE_BUILD' AND status IN ('ACTIVE','REVOKED') AND "databaseRole" ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'),
  CONSTRAINT "MockWorkerGrant_ids_check" CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$' AND "principalUserId" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
    AND "organizationId" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$' AND "workspaceId" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$' AND "storeId" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
    AND "sessionId" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$' AND "connectionId" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
    AND length("externalStoreId") BETWEEN 1 AND 200 AND "externalStoreId"=btrim("externalStoreId")
    AND "externalStoreId" !~ U&'[\0001-\001F\007F-\009F\200B-\200F\202A-\202E\2066-\2069]')
);
CREATE TABLE mock_platform."Runtime" (
  "sessionId" TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation>=0),
  "organizationId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "externalStoreId" TEXT NOT NULL,
  "sourceConfig" JSONB NOT NULL,
  "configHash" TEXT NOT NULL CHECK ("configHash" ~ '^[a-f0-9]{64}$'),
  "generatorVersion" TEXT NOT NULL CHECK ("generatorVersion"='mock-source-v1'),
  "runtimeVersion" TEXT NOT NULL CHECK ("runtimeVersion"='mock-runtime-v2'),
  "openingAt" TIMESTAMP(3) NOT NULL,
  "baselineEnd" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC',CURRENT_TIMESTAMP),
  CONSTRAINT "Runtime_pkey" PRIMARY KEY ("sessionId",generation),
  CONSTRAINT "Runtime_session_fkey" FOREIGN KEY ("sessionId","organizationId","workspaceId","storeId","connectionId","externalStoreId") REFERENCES demo."DemoCommerceSession"(id,"organizationId","workspaceId","storeId","connectionId","externalStoreId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "Runtime_ids_check" CHECK ("organizationId" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$' AND "workspaceId" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$' AND "storeId" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
    AND "sessionId" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$' AND "connectionId" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
    AND length("externalStoreId") BETWEEN 1 AND 200 AND "externalStoreId"=btrim("externalStoreId")
    AND "externalStoreId" !~ U&'[\0001-\001F\007F-\009F\200B-\200F\202A-\202E\2066-\2069]'),
  CONSTRAINT "Runtime_calendar_check" CHECK ("openingAt">=timestamp '0001-01-01' AND "baselineEnd"<=timestamp '9999-12-31 23:59:59.999' AND "openingAt"<="baselineEnd"),
  CONSTRAINT "Runtime_config_binding_check" CHECK ((jsonb_typeof("sourceConfig")='object' AND
    "sourceConfig"->'binding'->'organizationId'=to_jsonb("organizationId") AND "sourceConfig"->'binding'->'workspaceId'=to_jsonb("workspaceId") AND
    "sourceConfig"->'binding'->'storeId'=to_jsonb("storeId") AND "sourceConfig"->'binding'->'connectionId'=to_jsonb("connectionId") AND
    "sourceConfig"->'binding'->'externalStoreId'=to_jsonb("externalStoreId")) IS TRUE)
);

-- Initial lookup depends only on the actual login, before a principal can be derived.
ALTER TABLE demo."MockWorkerGrant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo."MockWorkerGrant" FORCE ROW LEVEL SECURITY;
CREATE POLICY mock_worker_own_grant ON demo."MockWorkerGrant" FOR SELECT TO shopmate_mock_source_worker
  USING ("databaseRole"=session_user AND "databaseRole"=current_user AND status='ACTIVE');

CREATE FUNCTION mock_platform.has_current_access(org_id TEXT, workspace_id TEXT, store_id TEXT, session_id TEXT, connection_id TEXT, external_id TEXT, current_generation INTEGER)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT demo.has_store_access(org_id,workspace_id,store_id,false) AND EXISTS (
    SELECT 1 FROM public."Store" s JOIN demo."DemoCommerceSession" d ON d."storeId"=s.id
    JOIN public."PlatformConnection" c ON c.id=d."connectionId"
    WHERE s.id=store_id AND s."merchantId"=current_setting('app.merchant_id',true)
      AND d.id=session_id AND d."organizationId"=org_id AND d."workspaceId"=workspace_id
      AND d."connectionId"=connection_id AND d."externalStoreId"=external_id
      AND c."organizationId"=org_id AND c."workspaceId"=workspace_id AND c."storeId"=store_id
      AND c."externalStoreId"=external_id AND c.provider='MOCK' AND c.status='ACTIVE' AND c.generation=current_generation
  )
$$;
CREATE FUNCTION mock_platform.has_worker_access(org_id TEXT, workspace_id TEXT, store_id TEXT, session_id TEXT, connection_id TEXT, external_id TEXT, current_generation INTEGER)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT mock_platform.has_current_access(org_id,workspace_id,store_id,session_id,connection_id,external_id,current_generation)
    AND EXISTS (
      SELECT 1 FROM demo."MockWorkerGrant" g
      JOIN public."OrganizationMember" m ON m."organizationId"=g."organizationId" AND m."userId"=g."principalUserId"
      JOIN public."WorkspaceMember" w ON w."organizationId"=g."organizationId" AND w."workspaceId"=g."workspaceId" AND w."userId"=g."principalUserId"
      WHERE g.id=current_setting('mock.grant_id',true) AND g."databaseRole"=session_user AND g."databaseRole"=current_user
        AND g.status='ACTIVE' AND g.operation='SOURCE_BUILD' AND g."principalUserId"=current_setting('app.user_id',true)
        AND g."organizationId"=org_id AND g."workspaceId"=workspace_id AND g."storeId"=store_id AND g."sessionId"=session_id
        AND g."connectionId"=connection_id AND g."externalStoreId"=external_id
        AND m.status='ACTIVE' AND m.role='VIEWER' AND w.status='ACTIVE'
    )
$$;
CREATE FUNCTION mock_platform.preserve_runtime() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Source generation is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
-- Enforce copied source and derived dates even for a caller using raw worker INSERT.
CREATE FUNCTION mock_platform.validate_runtime_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE config JSONB; start_at TIMESTAMP; days INTEGER; offset_days INTEGER;
BEGIN
  SELECT d.config INTO config FROM demo."DemoCommerceSession" d
    WHERE d.id=NEW."sessionId" AND d.config=NEW."sourceConfig" AND d."configHash"=NEW."configHash" AND d."generatorVersion"=NEW."generatorVersion";
  IF config IS NULL OR octet_length(config::text)>1000000 OR
    (config->>'profile' IN ('mature','growing','problematic','new') AND jsonb_typeof(config->'days')='number'
      AND config->>'days' ~ '^[0-9]{1,3}$' AND config->>'historyStart' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T16:00:00.000Z$') IS NOT TRUE THEN
    RAISE EXCEPTION 'Invalid source snapshot' USING ERRCODE='23514';
  END IF;
  days:=(config->>'days')::integer; start_at:=(config->>'historyStart')::timestamp;
  offset_days:=CASE WHEN config->>'profile'='new' THEN greatest(0,days-14) ELSE 0 END;
  IF days NOT BETWEEN 1 AND 365 OR start_at<timestamp '0001-01-01' OR start_at+(days+5)*interval '1 day'>timestamp '9999-12-31 23:59:59.999'
    OR NEW."openingAt" IS DISTINCT FROM start_at+offset_days*interval '1 day'
    OR NEW."baselineEnd" IS DISTINCT FROM start_at+days*interval '1 day' THEN
    RAISE EXCEPTION 'Invalid source calendar' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_source_generation BEFORE UPDATE ON mock_platform."Runtime"
  FOR EACH ROW EXECUTE FUNCTION mock_platform.preserve_runtime();
CREATE TRIGGER validated_source_generation BEFORE INSERT ON mock_platform."Runtime"
  FOR EACH ROW EXECUTE FUNCTION mock_platform.validate_runtime_insert();

ALTER TABLE mock_platform."Runtime" ENABLE ROW LEVEL SECURITY;
ALTER TABLE mock_platform."Runtime" FORCE ROW LEVEL SECURITY;
CREATE POLICY source_reader_generation ON mock_platform."Runtime" FOR SELECT TO shopmate_mock_source_reader USING (
  mock_platform.has_current_access("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation));
CREATE POLICY source_worker_generation ON mock_platform."Runtime" FOR SELECT TO shopmate_mock_source_worker USING (
  mock_platform.has_worker_access("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation));
CREATE POLICY source_worker_insert ON mock_platform."Runtime" FOR INSERT TO shopmate_mock_source_worker WITH CHECK (
  mock_platform.has_worker_access("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation)
  AND EXISTS (SELECT 1 FROM demo."DemoCommerceSession" d WHERE d.id="Runtime"."sessionId" AND d.config="Runtime"."sourceConfig"
    AND d."configHash"="Runtime"."configHash" AND d."generatorVersion"="Runtime"."generatorVersion"));

REVOKE ALL ON SCHEMA mock_platform FROM PUBLIC;
REVOKE ALL ON demo."MockWorkerGrant",mock_platform."Runtime" FROM PUBLIC;
REVOKE ALL ON FUNCTION mock_platform.has_current_access(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER),mock_platform.has_worker_access(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER),mock_platform.preserve_runtime(),mock_platform.validate_runtime_insert() FROM PUBLIC;
GRANT USAGE ON SCHEMA public,demo,mock_platform TO shopmate_mock_source_reader,shopmate_mock_source_worker;
GRANT SELECT ON public."Organization",public."OrganizationMember",public."Workspace",public."WorkspaceMember",public."Store",public."DemoTenant",public."TenantBootstrapEnvironment",public."PlatformConnection",demo."DemoCommerceSession" TO shopmate_mock_source_reader,shopmate_mock_source_worker;
GRANT EXECUTE ON FUNCTION demo.has_store_access(TEXT,TEXT,TEXT,BOOLEAN),mock_platform.has_current_access(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER) TO shopmate_mock_source_reader,shopmate_mock_source_worker;
GRANT EXECUTE ON FUNCTION mock_platform.has_worker_access(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER) TO shopmate_mock_source_worker;
GRANT SELECT ON mock_platform."Runtime" TO shopmate_mock_source_reader;
GRANT SELECT,INSERT ON mock_platform."Runtime" TO shopmate_mock_source_worker;
GRANT SELECT ON demo."MockWorkerGrant" TO shopmate_mock_source_worker;
COMMIT;

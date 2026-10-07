BEGIN;
CREATE SCHEMA sync_host;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shopmate_sync_worker') THEN
    CREATE ROLE shopmate_sync_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
CREATE TABLE sync_host."WorkerGrant" (
  id TEXT PRIMARY KEY, "databaseRole" TEXT NOT NULL, "principalUserId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "storeId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL, "externalStoreId" TEXT NOT NULL, provider TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation>=0), "initialSince" TIMESTAMP(3) NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  CONSTRAINT "WorkerGrant_membership_fkey" FOREIGN KEY ("organizationId","principalUserId") REFERENCES public."OrganizationMember"("organizationId","userId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "WorkerGrant_workspace_fkey" FOREIGN KEY ("organizationId","workspaceId","principalUserId") REFERENCES public."WorkspaceMember"("organizationId","workspaceId","userId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "WorkerGrant_connection_fkey" FOREIGN KEY ("connectionId","organizationId","workspaceId","storeId","externalStoreId") REFERENCES public."PlatformConnection"(id,"organizationId","workspaceId","storeId","externalStoreId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "WorkerGrant_ids_check" CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
    AND "databaseRole" ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'
    AND length("externalStoreId") BETWEEN 1 AND 200 AND "externalStoreId"=btrim("externalStoreId")
    AND "externalStoreId" !~ '[[:cntrl:]]' AND provider ~ '^[A-Z][A-Z0-9_]{0,31}$'),
  CONSTRAINT "WorkerGrant_calendar_check" CHECK ("initialSince">=timestamp '0001-01-01' AND "initialSince"<=timestamp '9999-12-31 23:59:59.999')
);
CREATE TABLE sync_host."Job" (
  id TEXT PRIMARY KEY, "grantId" TEXT NOT NULL REFERENCES sync_host."WorkerGrant"(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  "organizationId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "storeId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL, "externalStoreId" TEXT NOT NULL, provider TEXT NOT NULL,
  generation INTEGER NOT NULL, stream TEXT NOT NULL CHECK (stream IN ('PRODUCTS','ORDERS','REFUNDS','INVENTORY','MARKETING')),
  since TIMESTAMP(3) NOT NULL, until TIMESTAMP(3) NOT NULL,
  cursor JSONB, "successfulThrough" TIMESTAMP(3), status TEXT NOT NULL DEFAULT 'READY',
  fence INTEGER NOT NULL DEFAULT 0 CHECK (fence>=0), "leaseOwner" TEXT, "leaseUntil" TIMESTAMPTZ(3),
  "failureCode" TEXT, "leaseBackendPid" INTEGER, "leaseBackendStart" TIMESTAMPTZ(6),
  CONSTRAINT "Job_values_check" CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
    AND status IN ('READY','RUNNING','FAILED','SUCCEEDED') AND since<until
    AND since>=timestamp '0001-01-01' AND until<=timestamp '9999-12-31 23:59:59.999'
    AND until-since<=interval '31 days'
    AND ("leaseOwner" IS NULL OR "leaseOwner" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$')
    AND ("failureCode" IS NULL OR "failureCode" ~ '^[A-Z][A-Z0-9_]{0,63}$'))
);
CREATE UNIQUE INDEX "Job_scope_stream_window_key" ON sync_host."Job"
  ("organizationId","workspaceId","storeId","connectionId","externalStoreId",provider,generation,stream,since);
CREATE UNIQUE INDEX "Job_one_open_scope_stream" ON sync_host."Job"
  ("organizationId","workspaceId","storeId","connectionId","externalStoreId",provider,generation,stream) WHERE status<>'SUCCEEDED';

-- The operator-owned predicate reads current authority without trusting application GUCs.
CREATE FUNCTION sync_host.authorized(principal TEXT, org TEXT, workspace TEXT, store TEXT, connection TEXT, external_id TEXT, platform TEXT, gen INTEGER)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS (
  SELECT 1 FROM public."OrganizationMember" m
  JOIN public."Organization" o ON o.id=m."organizationId"
  JOIN public."WorkspaceMember" a ON a."organizationId"=m."organizationId" AND a."userId"=m."userId"
  JOIN public."Workspace" w ON w.id=a."workspaceId" AND w."organizationId"=a."organizationId"
  JOIN public."Store" s ON s."organizationId"=w."organizationId" AND s."workspaceId"=w.id
  JOIN public."Merchant" merchant ON merchant.id=s."merchantId"
  JOIN public."PlatformConnection" c ON c."storeId"=s.id
  WHERE m."userId"=principal AND m."organizationId"=org AND m.role='VIEWER' AND m.status='ACTIVE'
   AND o.status='ACTIVE' AND a.status='ACTIVE' AND w.status='ACTIVE' AND merchant.status='ACTIVE'
   AND w.id=workspace AND s.id=store AND c.id=connection AND c."organizationId"=org AND c."workspaceId"=workspace
   AND c."externalStoreId"=external_id AND c.provider=platform AND c.generation=gen AND c.status='ACTIVE'
 )
$$;
REVOKE ALL ON FUNCTION sync_host.authorized(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sync_host.authorized(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER) TO shopmate_sync_worker;
CREATE FUNCTION sync_host.validate_grant() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') THEN
  RAISE EXCEPTION 'Grant binding is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.status='ACTIVE' AND (NOT sync_host.authorized(NEW."principalUserId",NEW."organizationId",NEW."workspaceId",NEW."storeId",NEW."connectionId",NEW."externalStoreId",NEW.provider,NEW.generation)
  OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=NEW."databaseRole" AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls
   AND pg_has_role(rolname,'shopmate_sync_worker','MEMBER'))) THEN
  RAISE EXCEPTION 'Invalid sync worker authority' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_grant BEFORE INSERT OR UPDATE ON sync_host."WorkerGrant" FOR EACH ROW EXECUTE FUNCTION sync_host.validate_grant();
ALTER TABLE sync_host."WorkerGrant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_host."WorkerGrant" FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_grant ON sync_host."WorkerGrant" FOR SELECT TO shopmate_sync_worker USING (
 "databaseRole"=session_user AND session_user=current_user AND id=current_setting('sync.grant_id',true)
 AND "principalUserId"=current_setting('app.user_id',true) AND status='ACTIVE'
 AND sync_host.authorized("principalUserId","organizationId","workspaceId","storeId","connectionId","externalStoreId",provider,generation));
ALTER TABLE sync_host."Job" ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_host."Job" FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_job ON sync_host."Job" TO shopmate_sync_worker USING (
 session_user=current_user AND EXISTS (SELECT 1 FROM sync_host."WorkerGrant" g WHERE g.id="Job"."grantId"
 AND (g."organizationId",g."workspaceId",g."storeId",g."connectionId",g."externalStoreId",g.provider,g.generation)
 =("Job"."organizationId","Job"."workspaceId","Job"."storeId","Job"."connectionId","Job"."externalStoreId","Job".provider,"Job".generation)))
 WITH CHECK (session_user=current_user AND EXISTS (SELECT 1 FROM sync_host."WorkerGrant" g WHERE g.id="Job"."grantId"
 AND (g."organizationId",g."workspaceId",g."storeId",g."connectionId",g."externalStoreId",g.provider,g.generation)
 =("Job"."organizationId","Job"."workspaceId","Job"."storeId","Job"."connectionId","Job"."externalStoreId","Job".provider,"Job".generation)));
GRANT USAGE ON SCHEMA sync_host TO shopmate_sync_worker;
GRANT SELECT ON sync_host."WorkerGrant",sync_host."Job" TO shopmate_sync_worker;
GRANT INSERT (id,"grantId","organizationId","workspaceId","storeId","connectionId","externalStoreId",provider,generation,stream,since,until) ON sync_host."Job" TO shopmate_sync_worker;
GRANT UPDATE (status,fence,"leaseOwner","leaseUntil","failureCode") ON sync_host."Job" TO shopmate_sync_worker;
CREATE FUNCTION sync_host.validate_window() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE expected TIMESTAMP; binding sync_host."WorkerGrant";
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'Sync windows require read committed isolation' USING ERRCODE='23514';
 END IF;
 SELECT * INTO binding FROM sync_host."WorkerGrant" WHERE id=NEW."grantId";
 IF (NEW."organizationId",NEW."workspaceId",NEW."storeId",NEW."connectionId",NEW."externalStoreId",NEW.provider,NEW.generation)
  IS DISTINCT FROM (binding."organizationId",binding."workspaceId",binding."storeId",binding."connectionId",binding."externalStoreId",binding.provider,binding.generation)
  OR NEW.status<>'READY' OR NEW.fence<>0 OR NEW.cursor IS NOT NULL OR NEW."successfulThrough" IS NOT NULL
  OR NEW."leaseOwner" IS NOT NULL OR NEW."leaseUntil" IS NOT NULL OR NEW."failureCode" IS NOT NULL
  OR NEW."leaseBackendPid" IS NOT NULL OR NEW."leaseBackendStart" IS NOT NULL THEN
  RAISE EXCEPTION 'Invalid initial job binding' USING ERRCODE='23514';
 END IF;
 -- Serialize every grant for the same scope/stream before inspecting its completed prefix.
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(NEW."organizationId",NEW."workspaceId",NEW."storeId",NEW."connectionId",NEW."externalStoreId",NEW.provider,NEW.generation,NEW.stream)::text,0));
 SELECT j.until INTO expected FROM sync_host."Job" j
 WHERE (j."organizationId",j."workspaceId",j."storeId",j."connectionId",j."externalStoreId",j.provider,j.generation,j.stream)
 =(NEW."organizationId",NEW."workspaceId",NEW."storeId",NEW."connectionId",NEW."externalStoreId",NEW.provider,NEW.generation,NEW.stream)
 AND j.status='SUCCEEDED' AND j."successfulThrough"=j.until ORDER BY j.until DESC LIMIT 1;
 IF NEW.since IS DISTINCT FROM coalesce(expected,binding."initialSince") THEN
  RAISE EXCEPTION 'Sync windows must continue the successful prefix' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_window BEFORE INSERT ON sync_host."Job" FOR EACH ROW EXECUTE FUNCTION sync_host.validate_window();
CREATE FUNCTION sync_host.validate_lease() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE wall TIMESTAMPTZ:=clock_timestamp(); backend_started TIMESTAMPTZ;
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=session_user AND (rolsuper OR rolbypassrls)) THEN RETURN NEW; END IF;
 SELECT backend_start INTO backend_started FROM pg_stat_activity WHERE pid=pg_backend_pid();
 IF (to_jsonb(NEW)-ARRAY['status','fence','leaseOwner','leaseUntil','failureCode'])
  IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','fence','leaseOwner','leaseUntil','failureCode']) THEN
  RAISE EXCEPTION 'Job progress is immutable outside atomic ingestion' USING ERRCODE='23514';
 END IF;
 IF NEW.status='RUNNING' AND (OLD.status IN ('READY','FAILED') OR OLD.status='RUNNING' AND OLD."leaseUntil"<=wall) THEN
  IF NEW.fence<>OLD.fence+1 OR NEW."leaseOwner" IS NULL OR NEW."failureCode" IS NOT NULL THEN
   RAISE EXCEPTION 'Invalid lease claim' USING ERRCODE='23514';
  END IF;
  NEW."leaseBackendPid":=pg_backend_pid(); NEW."leaseBackendStart":=backend_started;
 ELSIF OLD.status='RUNNING' AND OLD."leaseUntil">wall AND NEW.fence=OLD.fence AND NEW."leaseOwner"=OLD."leaseOwner"
  AND OLD."leaseBackendPid"=pg_backend_pid() AND OLD."leaseBackendStart"=backend_started THEN
  IF NEW.status NOT IN ('RUNNING','FAILED') OR NEW.status='FAILED' AND NEW."failureCode" IS NULL THEN
   RAISE EXCEPTION 'Invalid lease transition' USING ERRCODE='23514';
  END IF;
 ELSE RAISE EXCEPTION 'Stale lease or forbidden completion' USING ERRCODE='23514';
 END IF;
 IF NEW.status='RUNNING' THEN NEW."leaseUntil":=wall+interval '2 minutes';
 ELSE NEW."leaseUntil":=NULL; NEW."leaseOwner":=NULL;
  NEW."leaseBackendPid":=NULL; NEW."leaseBackendStart":=NULL; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_lease BEFORE UPDATE ON sync_host."Job" FOR EACH ROW EXECUTE FUNCTION sync_host.validate_lease();
REVOKE ALL ON FUNCTION sync_host.validate_grant(),sync_host.validate_window(),sync_host.validate_lease() FROM PUBLIC;
COMMIT;

BEGIN;
-- Receipt staging is separate from normalized ingestion and cannot certify business success.
ALTER TABLE sync_host."Job" ADD COLUMN "receiptCursor" JSONB, ADD COLUMN "receivedThrough" TIMESTAMP(3);
CREATE TABLE sync_host."PageReceipt" (
  "jobId" TEXT NOT NULL REFERENCES sync_host."Job"(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  "pageId" TEXT NOT NULL CHECK ("pageId" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'),
  "expectedCursor" TEXT,
  "nextCursor" TEXT,
  "receivedThrough" TIMESTAMP(3) NOT NULL,
  "pageHash" TEXT NOT NULL CHECK ("pageHash" ~ '^[0-9a-f]{64}$'),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("jobId","pageId")
);
ALTER TABLE sync_host."PageReceipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_host."PageReceipt" FORCE ROW LEVEL SECURITY;

-- Check twice around the row lock: a caller must not lock a foreign job, and a
-- waiting authorized caller must observe revocation and lease changes afterward.
CREATE FUNCTION sync_host.require_page_lease(job sync_host."Job", expected_fence INTEGER)
RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE binding sync_host."WorkerGrant"; started TIMESTAMPTZ;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'Page receipts require read committed isolation' USING ERRCODE='23514'; END IF;
 SELECT * INTO binding FROM sync_host."WorkerGrant" WHERE id=job."grantId";
 SELECT backend_start INTO started FROM pg_stat_activity WHERE pid=pg_backend_pid();
 IF NOT FOUND OR job.id IS NULL OR binding.id IS NULL OR binding.status<>'ACTIVE'
  OR binding."databaseRole"<>session_user OR binding.id IS DISTINCT FROM current_setting('sync.grant_id',true)
  OR binding."principalUserId" IS DISTINCT FROM current_setting('app.user_id',true)
  OR NOT sync_host.safe_login(session_user)
  OR NOT sync_host.authorized(binding."principalUserId",binding."organizationId",binding."workspaceId",binding."storeId",binding."connectionId",binding."externalStoreId",binding.provider,binding.generation)
  OR (job."organizationId",job."workspaceId",job."storeId",job."connectionId",job."externalStoreId",job.provider,job.generation)
    IS DISTINCT FROM (binding."organizationId",binding."workspaceId",binding."storeId",binding."connectionId",binding."externalStoreId",binding.provider,binding.generation)
  OR job.status<>'RUNNING' OR job.fence IS DISTINCT FROM expected_fence
  OR job."leaseUntil" IS NULL OR job."leaseUntil"<=clock_timestamp()
  OR job."leaseBackendPid" IS DISTINCT FROM pg_backend_pid()
  OR job."leaseBackendStart" IS DISTINCT FROM started THEN
  RAISE EXCEPTION 'Stale or unauthorized sync lease' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION sync_host.require_page_lease(sync_host."Job",INTEGER) FROM PUBLIC;

CREATE FUNCTION sync_host.stage_page(job_id TEXT, expected_fence INTEGER, page_id TEXT,
  expected_cursor TEXT, next_cursor TEXT, received_through TIMESTAMP(3), page_hash TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job sync_host."Job"; receipt sync_host."PageReceipt";
BEGIN
 IF NOT sync_host.safe_login(session_user) THEN
  RAISE EXCEPTION 'Invalid sync login' USING ERRCODE='42501'; END IF;
 IF page_id IS NULL OR page_id !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
  OR page_hash IS NULL OR page_hash !~ '^[0-9a-f]{64}$'
  -- Function argument typmods are ignored; reject rounding before receipt comparison.
  OR received_through IS DISTINCT FROM date_trunc('milliseconds',received_through)
  OR (expected_cursor IS NOT NULL AND (length(expected_cursor)>1024 OR expected_cursor='' OR expected_cursor ~ '[[:cntrl:]]'))
  OR (next_cursor IS NOT NULL AND (length(next_cursor)>1024 OR next_cursor='' OR next_cursor ~ '[[:cntrl:]]')) THEN
  RAISE EXCEPTION 'Invalid page receipt' USING ERRCODE='23514'; END IF;
 SELECT * INTO job FROM sync_host."Job" WHERE id=job_id;
 PERFORM sync_host.require_page_lease(job,expected_fence);
 -- Authorize before locking so foreign callers cannot block another scope.
 SELECT * INTO job FROM sync_host."Job" WHERE id=job_id FOR UPDATE;
 PERFORM sync_host.require_page_lease(job,expected_fence);
 SELECT * INTO receipt FROM sync_host."PageReceipt" WHERE "jobId"=job_id AND "pageId"=page_id;
 IF FOUND THEN
  IF (receipt."expectedCursor",receipt."nextCursor",receipt."receivedThrough",receipt."pageHash")
   IS DISTINCT FROM (expected_cursor,next_cursor,received_through,page_hash) THEN
   RAISE EXCEPTION 'Conflicting page receipt' USING ERRCODE='23505'; END IF;
  RETURN 'REPLAYED'; END IF;
 IF job."receiptCursor" #>> '{}' IS DISTINCT FROM expected_cursor OR received_through IS NULL
  OR received_through<job.since OR received_through>job.until
  OR received_through<coalesce(job."receivedThrough",job.since)
  OR (next_cursor IS NULL AND received_through<>job.until)
  OR (next_cursor IS NOT NULL AND next_cursor IS NOT DISTINCT FROM expected_cursor)
  OR EXISTS (SELECT 1 FROM sync_host."PageReceipt" WHERE "jobId"=job_id AND "nextCursor" IS NULL) THEN
  RAISE EXCEPTION 'Non-contiguous page progress' USING ERRCODE='23514'; END IF;
 INSERT INTO sync_host."PageReceipt" ("jobId","pageId","expectedCursor","nextCursor","receivedThrough","pageHash")
  VALUES (job_id,page_id,expected_cursor,next_cursor,received_through,page_hash);
 UPDATE sync_host."Job" SET "receiptCursor"=to_jsonb(next_cursor),"receivedThrough"=received_through WHERE id=job_id;
 RETURN 'APPLIED';
END $$;
REVOKE ALL ON FUNCTION sync_host.stage_page(TEXT,INTEGER,TEXT,TEXT,TEXT,TIMESTAMP,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sync_host.stage_page(TEXT,INTEGER,TEXT,TEXT,TEXT,TIMESTAMP,TEXT) TO shopmate_sync_worker;

CREATE OR REPLACE FUNCTION sync_host.validate_lease() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE wall TIMESTAMPTZ:=clock_timestamp(); backend_started TIMESTAMPTZ;
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=session_user AND (rolsuper OR rolbypassrls)) THEN RETURN NEW; END IF;
 SELECT backend_start INTO backend_started FROM pg_stat_activity WHERE pid=pg_backend_pid();
 IF current_user<>session_user AND current_user=pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid='sync_host.stage_page(text,integer,text,text,text,timestamp without time zone,text)'::regprocedure)) THEN
  IF (to_jsonb(NEW)-ARRAY['receiptCursor','receivedThrough']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['receiptCursor','receivedThrough'])
   OR OLD.status<>'RUNNING' OR OLD."leaseUntil"<=wall OR OLD."leaseBackendPid"<>pg_backend_pid()
   OR OLD."leaseBackendStart"<>backend_started THEN
   RAISE EXCEPTION 'Invalid atomic page progress' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['status','fence','leaseOwner','leaseUntil','failureCode'])
  IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','fence','leaseOwner','leaseUntil','failureCode']) THEN
  RAISE EXCEPTION 'Job progress is immutable outside atomic ingestion' USING ERRCODE='23514'; END IF;
 IF NEW.status='RUNNING' AND (OLD.status IN ('READY','FAILED') OR OLD.status='RUNNING' AND OLD."leaseUntil"<=wall) THEN
  IF NEW.fence<>OLD.fence+1 OR NEW."leaseOwner" IS NULL OR NEW."failureCode" IS NOT NULL THEN
   RAISE EXCEPTION 'Invalid lease claim' USING ERRCODE='23514'; END IF;
  NEW."leaseBackendPid":=pg_backend_pid(); NEW."leaseBackendStart":=backend_started;
 ELSIF OLD.status='RUNNING' AND OLD."leaseUntil">wall AND NEW.fence=OLD.fence AND NEW."leaseOwner"=OLD."leaseOwner"
  AND OLD."leaseBackendPid"=pg_backend_pid() AND OLD."leaseBackendStart"=backend_started THEN
  IF NEW.status NOT IN ('RUNNING','FAILED') OR NEW.status='FAILED' AND NEW."failureCode" IS NULL THEN
   RAISE EXCEPTION 'Invalid lease transition' USING ERRCODE='23514'; END IF;
 ELSE RAISE EXCEPTION 'Stale lease or forbidden completion' USING ERRCODE='23514'; END IF;
 IF NEW.status='RUNNING' THEN NEW."leaseUntil":=wall+interval '2 minutes';
 ELSE NEW."leaseUntil":=NULL; NEW."leaseOwner":=NULL;
  NEW."leaseBackendPid":=NULL; NEW."leaseBackendStart":=NULL; END IF;
 RETURN NEW;
END $$;
COMMIT;

BEGIN;
ALTER TABLE sync_host."Job" ADD COLUMN "observedAt" TIMESTAMPTZ(3), ADD COLUMN "sourceWatermark" TIMESTAMPTZ(3), ADD COLUMN "pageCount" INTEGER NOT NULL DEFAULT 0 CHECK ("pageCount">=0);

CREATE FUNCTION sync_host.worker_grant() RETURNS sync_host."WorkerGrant"
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE g sync_host."WorkerGrant";
BEGIN
 SELECT * INTO g FROM sync_host."WorkerGrant" WHERE id=current_setting('sync.grant_id',true);
 IF g.id IS NULL OR g."databaseRole"<>session_user OR g.status<>'ACTIVE'
  OR g."principalUserId" IS DISTINCT FROM current_setting('app.user_id',true)
  OR NOT sync_host.safe_login(session_user)
  OR NOT sync_host.authorized(g."principalUserId",g."organizationId",g."workspaceId",g."storeId",g."connectionId",g."externalStoreId",g.provider,g.generation) THEN
  RAISE EXCEPTION 'SYNC_AUTHORITY_DENIED' USING ERRCODE='42501'; END IF;
 SELECT * INTO g FROM sync_host."WorkerGrant" WHERE id=g.id FOR SHARE;
 IF g.status<>'ACTIVE' OR NOT sync_host.authorized(g."principalUserId",g."organizationId",g."workspaceId",g."storeId",g."connectionId",g."externalStoreId",g.provider,g.generation) THEN
 RAISE EXCEPTION 'SYNC_AUTHORITY_DENIED' USING ERRCODE='42501'; END IF;
 RETURN g;
END $$;
CREATE FUNCTION sync_host.worker_job(job_id TEXT) RETURNS sync_host."Job"
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE g sync_host."WorkerGrant"; j sync_host."Job";
BEGIN
 g:=sync_host.worker_grant();
 SELECT * INTO j FROM sync_host."Job" WHERE id=job_id;
 IF j.id IS NULL OR j."grantId"<>g.id OR
 (j."organizationId",j."workspaceId",j."storeId",j."connectionId",j."externalStoreId",j.provider,j.generation)
 IS DISTINCT FROM (g."organizationId",g."workspaceId",g."storeId",g."connectionId",g."externalStoreId",g.provider,g.generation) THEN
 RAISE EXCEPTION 'SYNC_AUTHORITY_DENIED' USING ERRCODE='42501'; END IF;
 RETURN j;
END $$;
CREATE FUNCTION sync_host.list_work() RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE g sync_host."WorkerGrant"; jobs JSONB;
BEGIN
 SELECT * INTO g FROM sync_host."WorkerGrant" WHERE id=current_setting('sync.grant_id',true);
 IF g.id IS NULL THEN RAISE EXCEPTION 'SYNC_AUTHORITY_DENIED' USING ERRCODE='42501'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY j.stream,j.since),'[]'::jsonb) INTO jobs FROM (SELECT * FROM sync_host."Job" WHERE "grantId"=g.id ORDER BY since DESC,stream LIMIT 10) j;
 RETURN jsonb_build_object('grant',to_jsonb(g),'jobs',jobs);
END $$;

-- Walk the entire immutable receipt graph and require one exact correct-stream manifest per edge.
CREATE FUNCTION sync_host.worker_proof(j sync_host."Job") RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE proof JSONB; total INTEGER;
BEGIN
 SELECT count(*) INTO total FROM sync_host."PageReceipt" WHERE "jobId"=j.id;
 WITH RECURSIVE manifests AS (
 SELECT "jobId","pageId","scopeId","organizationId","workspaceId","storeId","pageHash",terminal,"observedAt","sourceWatermark" FROM sync_host."ProductPageCommit" WHERE j.stream='PRODUCTS'
 UNION ALL
 SELECT "jobId","pageId","scopeId","organizationId","workspaceId","storeId","pageHash",terminal,"observedAt","sourceWatermark" FROM sync_host."CanonicalPageCommit" WHERE j.stream IN ('ORDERS','REFUNDS','INVENTORY','MARKETING')
 ), edges AS (
 SELECT r.*,m."observedAt",m."sourceWatermark" FROM sync_host."PageReceipt" r JOIN manifests m
 ON (m."jobId",m."pageId",m."pageHash",m."organizationId",m."workspaceId",m."storeId",m.terminal)
 IS NOT DISTINCT FROM (r."jobId",r."pageId",r."pageHash",j."organizationId",j."workspaceId",j."storeId",r."nextCursor" IS NULL)
 JOIN commerce."SourceScope" s ON s.id=m."scopeId" AND
 (s."organizationId",s."workspaceId",s."storeId",s."connectionId",s."externalStoreId",s.provider,s.generation)
 =(j."organizationId",j."workspaceId",j."storeId",j."connectionId",j."externalStoreId",j.provider,j.generation)
 WHERE r."jobId"=j.id
 ), chain AS (
 SELECT e.*,ARRAY[e."pageId"] AS path FROM edges e WHERE e."expectedCursor" IS NULL
 UNION ALL SELECT e.*,c.path||e."pageId" FROM chain c JOIN edges e ON e."expectedCursor"=c."nextCursor"
 WHERE c."nextCursor" IS NOT NULL AND NOT e."pageId"=ANY(c.path)
 ) SELECT jsonb_build_object('pageCount',count(*),'terminalCount',count(*) FILTER (WHERE "nextCursor" IS NULL),
 'knownCount',count("sourceWatermark"),'sourceWatermark',min("sourceWatermark"),'observedAt',max("observedAt")) INTO proof FROM chain;
 IF total=0 OR (proof->>'pageCount')::integer<>total OR (proof->>'terminalCount')::integer>1
 OR EXISTS (SELECT 1 FROM sync_host."PageReceipt" WHERE "jobId"=j.id GROUP BY "expectedCursor" HAVING count(*)>1)
 OR EXISTS (SELECT 1 FROM sync_host."PageReceipt" WHERE "jobId"=j.id AND "nextCursor" IS NOT NULL GROUP BY "nextCursor" HAVING count(*)>1) THEN
 RAISE EXCEPTION 'SYNC_RECEIPT_PROOF_INVALID' USING ERRCODE='23514'; END IF;
 RETURN proof;
END $$;

CREATE FUNCTION sync_host.create_window(requested_stream TEXT, requested_until TIMESTAMP) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE g sync_host."WorkerGrant"; j sync_host."Job"; start_at TIMESTAMP;
BEGIN
 g:=sync_host.worker_grant();
 IF requested_stream IS NULL OR requested_stream NOT IN ('PRODUCTS','ORDERS','REFUNDS','INVENTORY','MARKETING')
 OR requested_until IS NULL OR requested_until<>date_trunc('milliseconds',requested_until) THEN
 RAISE EXCEPTION 'SYNC_WINDOW_INVALID' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(g."organizationId",g."workspaceId",g."storeId",g."connectionId",g."externalStoreId",g.provider,g.generation,requested_stream)::text,0));
 g:=sync_host.worker_grant();
 SELECT * INTO j FROM sync_host."Job" WHERE
 ("organizationId","workspaceId","storeId","connectionId","externalStoreId",provider,generation,stream)
 =(g."organizationId",g."workspaceId",g."storeId",g."connectionId",g."externalStoreId",g.provider,g.generation,requested_stream)
 ORDER BY since DESC LIMIT 1;
 IF j.id IS NOT NULL AND j.status<>'SUCCEEDED' THEN
 IF j."grantId"<>g.id OR j.until<>requested_until THEN RAISE EXCEPTION 'SYNC_WINDOW_CONFLICT' USING ERRCODE='23514'; END IF;
 RETURN to_jsonb(j); END IF;
 IF j.id IS NOT NULL THEN PERFORM sync_host.worker_proof(j); END IF;
 start_at:=coalesce(j.until,g."initialSince");
 INSERT INTO sync_host."Job"(id,"grantId","organizationId","workspaceId","storeId","connectionId","externalStoreId",provider,generation,stream,since,until)
 VALUES ('sync-'||gen_random_uuid()::text,g.id,g."organizationId",g."workspaceId",g."storeId",g."connectionId",g."externalStoreId",g.provider,g.generation,requested_stream,start_at,requested_until) RETURNING * INTO j;
 RETURN to_jsonb(j);
END $$;

CREATE FUNCTION sync_host.commit_worker_page(job_id TEXT, expected_fence INTEGER, page_id TEXT, expected_cursor TEXT, page JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j sync_host."Job"; result JSONB; proof JSONB; watermark TIMESTAMPTZ; stored_hash TEXT; actual_hash TEXT;
BEGIN
 j:=sync_host.worker_job(job_id);
 IF j.status='SUCCEEDED' THEN
 -- A reconnect may replay a completed immutable page, but can never adopt different bytes.
 SELECT * INTO j FROM sync_host."Job" WHERE id=job_id FOR SHARE;
 PERFORM sync_host.worker_job(job_id);
 IF j.stream='PRODUCTS' THEN
 PERFORM sync_host.product_page_input(page,j."externalStoreId",j.until AT TIME ZONE 'UTC');
 actual_hash:=sync_host.product_page_hash(to_jsonb(j),expected_cursor,page);
 SELECT c."pageHash",sync_host.product_commit_result(c,'REPLAYED') INTO stored_hash,result FROM sync_host."ProductPageCommit" c WHERE c."jobId"=job_id AND c."pageId"=page_id;
 ELSE
 PERFORM sync_host.canonical_page_input(page,j);
 actual_hash:=sync_host.canonical_page_hash(to_jsonb(j),expected_cursor,page);
 SELECT c."pageHash",sync_host.canonical_commit_result(c,'REPLAYED') INTO stored_hash,result FROM sync_host."CanonicalPageCommit" c WHERE c."jobId"=job_id AND c."pageId"=page_id;
 END IF;
 IF j.fence IS DISTINCT FROM expected_fence OR stored_hash IS NULL OR stored_hash<>actual_hash THEN RAISE EXCEPTION 'SYNC_PAGE_CONFLICT' USING ERRCODE='23505'; END IF;
 PERFORM sync_host.worker_proof(j);
 RETURN result||jsonb_build_object('job',to_jsonb(j)); END IF;
 IF j.stream='PRODUCTS' THEN result:=sync_host.commit_product_page(job_id,expected_fence,page_id,expected_cursor,page);
 ELSE result:=sync_host.commit_canonical_page(job_id,expected_fence,page_id,expected_cursor,page); END IF;
 SELECT * INTO j FROM sync_host."Job" WHERE id=job_id;
 PERFORM sync_host.require_page_lease(j,expected_fence);
 proof:=sync_host.worker_proof(j);
 watermark:=CASE WHEN (proof->>'knownCount')::integer=(proof->>'pageCount')::integer THEN (proof->>'sourceWatermark')::timestamptz END;
 UPDATE sync_host."Job" SET cursor="receiptCursor","pageCount"=(proof->>'pageCount')::integer,
 "observedAt"=(proof->>'observedAt')::timestamptz,"sourceWatermark"=watermark,
 "successfulThrough"=CASE WHEN (proof->>'terminalCount')::integer=1 THEN watermark AT TIME ZONE 'UTC' END,
 status=CASE WHEN (proof->>'terminalCount')::integer=1 THEN 'SUCCEEDED' ELSE 'RUNNING' END WHERE id=job_id RETURNING * INTO j;
 RETURN result||jsonb_build_object('job',to_jsonb(j));
END $$;
REVOKE ALL ON FUNCTION sync_host.worker_grant(),sync_host.worker_job(TEXT),sync_host.worker_proof(sync_host."Job"),sync_host.list_work(),sync_host.create_window(TEXT,TIMESTAMP),sync_host.commit_worker_page(TEXT,INTEGER,TEXT,TEXT,JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sync_host.list_work(),sync_host.create_window(TEXT,TIMESTAMP),sync_host.commit_worker_page(TEXT,INTEGER,TEXT,TEXT,JSONB) TO shopmate_sync_worker;

CREATE OR REPLACE FUNCTION sync_host.validate_window() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
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
 AND j.status='SUCCEEDED' AND (j."successfulThrough"=j.until OR j."pageCount">0 AND j."receivedThrough"=j.until) ORDER BY j.until DESC LIMIT 1;
 IF NEW.since IS DISTINCT FROM coalesce(expected,binding."initialSince") THEN
  RAISE EXCEPTION 'Sync windows must continue the successful prefix' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION sync_host.validate_lease() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE wall TIMESTAMPTZ:=clock_timestamp(); backend_started TIMESTAMPTZ;
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=session_user AND (rolsuper OR rolbypassrls)) THEN RETURN NEW; END IF;
 SELECT backend_start INTO backend_started FROM pg_stat_activity WHERE pid=pg_backend_pid();
 IF NEW.fence=OLD.fence AND NEW.status IN ('RUNNING','SUCCEEDED') AND NEW."leaseUntil" IS NOT DISTINCT FROM OLD."leaseUntil" AND NEW."leaseOwner" IS NOT DISTINCT FROM OLD."leaseOwner" AND current_user<>session_user AND current_user=pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid='sync_host.stage_page(text,integer,text,text,text,timestamp without time zone,text)'::regprocedure)) THEN
  IF (to_jsonb(NEW)-ARRAY['receiptCursor','receivedThrough','cursor','observedAt','sourceWatermark','pageCount','successfulThrough','status']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['receiptCursor','receivedThrough','cursor','observedAt','sourceWatermark','pageCount','successfulThrough','status'])
   OR OLD.status<>'RUNNING' OR NEW.status NOT IN ('RUNNING','SUCCEEDED') OR OLD."leaseUntil"<=wall OR OLD."leaseBackendPid"<>pg_backend_pid()
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
CREATE OR REPLACE FUNCTION sync_host.guard_product_commit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job sync_host."Job"; counts JSONB;
BEGIN
 SELECT * INTO job FROM sync_host."Job" WHERE id=NEW."jobId";
 IF job.status='SUCCEEDED' AND job."pageCount">0 THEN
  PERFORM sync_host.worker_proof(job); job.status:='RUNNING';
 END IF;
 PERFORM sync_host.require_page_lease(job,NEW."acceptedFence");
 SELECT sync_host.product_counts(coalesce(jsonb_agg(jsonb_build_object('decision',decision)),'[]'::jsonb)) INTO counts
 FROM sync_host."ProductPageDecision" WHERE "jobId"=NEW."jobId" AND "pageId"=NEW."pageId";
 IF ((counts->>'inputCount')::integer,(counts->>'appliedCount')::integer,(counts->>'duplicateCount')::integer,(counts->>'staleCount')::integer,(counts->>'quarantinedCount')::integer)
  IS DISTINCT FROM (NEW."inputCount",NEW."appliedCount",NEW."duplicateCount",NEW."staleCount",NEW."quarantinedCount")
  OR (SELECT count(*) FROM sync_host."ProductQuarantine" WHERE "jobId"=NEW."jobId" AND "pageId"=NEW."pageId")<>NEW."quarantinedCount" THEN
  RAISE EXCEPTION 'PRODUCT_RECEIPT_COUNT_MISMATCH' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION sync_host.guard_canonical_commit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job sync_host."Job"; counts JSONB;
BEGIN
 SELECT * INTO job FROM sync_host."Job" WHERE id=NEW."jobId";
 IF job.status='SUCCEEDED' AND job."pageCount">0 THEN
  PERFORM sync_host.worker_proof(job); job.status:='RUNNING';
 END IF;
 PERFORM sync_host.require_page_lease(job,NEW."acceptedFence");
 SELECT sync_host.canonical_counts(coalesce(jsonb_agg(jsonb_build_object('decision',decision)),'[]'::jsonb)) INTO counts
 FROM sync_host."CanonicalPageDecision" WHERE "jobId"=NEW."jobId" AND "pageId"=NEW."pageId";
 IF ((counts->>'inputCount')::integer,(counts->>'appliedCount')::integer,(counts->>'duplicateCount')::integer,(counts->>'staleCount')::integer,(counts->>'quarantinedCount')::integer)
  IS DISTINCT FROM (NEW."inputCount",NEW."appliedCount",NEW."duplicateCount",NEW."staleCount",NEW."quarantinedCount")
  OR (SELECT count(*) FROM sync_host."CanonicalQuarantine" WHERE "jobId"=NEW."jobId" AND "pageId"=NEW."pageId")<>NEW."quarantinedCount" THEN
  RAISE EXCEPTION 'CANONICAL_RECEIPT_COUNT_MISMATCH' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

-- Retain accepted backend lease fields through deferred checks; workers cannot update completed Jobs.
CREATE FUNCTION sync_host.guard_worker_progress() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j sync_host."Job"; proof JSONB; watermark TIMESTAMPTZ;
BEGIN
 SELECT * INTO j FROM sync_host."Job" WHERE id=NEW.id;
 proof:=sync_host.worker_proof(j);
 watermark:=CASE WHEN (proof->>'knownCount')::integer=(proof->>'pageCount')::integer THEN (proof->>'sourceWatermark')::timestamptz END;
 IF j."sourceWatermark" IS DISTINCT FROM watermark OR j."observedAt" IS DISTINCT FROM (proof->>'observedAt')::timestamptz
 OR j."successfulThrough" IS DISTINCT FROM (CASE WHEN j.status='SUCCEEDED' THEN watermark AT TIME ZONE 'UTC' END) THEN
 RAISE EXCEPTION 'SYNC_FRESHNESS_INVALID' USING ERRCODE='23514'; END IF;
 IF j."pageCount"<>(proof->>'pageCount')::integer OR j.cursor IS DISTINCT FROM j."receiptCursor"
 OR j.status='SUCCEEDED' AND ((proof->>'terminalCount')::integer<>1 OR j."receivedThrough"<>j.until) THEN
 RAISE EXCEPTION 'SYNC_RECEIPT_PROOF_INVALID' USING ERRCODE='23514'; END IF;
 IF j.status='SUCCEEDED' THEN j.status:='RUNNING'; END IF;
 PERFORM sync_host.require_page_lease(j,NEW.fence); RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER guard_worker_progress AFTER UPDATE ON sync_host."Job"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW."pageCount">OLD."pageCount") EXECUTE FUNCTION sync_host.guard_worker_progress();
REVOKE ALL ON FUNCTION sync_host.guard_worker_progress() FROM PUBLIC;

CREATE FUNCTION sync_host.control_lease(job_id TEXT, action TEXT, expected_fence INTEGER, owner_id TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j sync_host."Job";
BEGIN
 IF action IS NULL OR action NOT IN ('CLAIM','RENEW','FAIL') OR owner_id IS NULL OR owner_id !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$' THEN
 RAISE EXCEPTION 'SYNC_LEASE_INVALID' USING ERRCODE='23514'; END IF;
 j:=sync_host.worker_job(job_id);
 SELECT * INTO j FROM sync_host."Job" WHERE id=job_id FOR UPDATE;
 PERFORM sync_host.worker_job(job_id);
 IF action='CLAIM' THEN
 UPDATE sync_host."Job" SET status='RUNNING',fence=fence+1,"leaseOwner"=owner_id,"failureCode"=NULL WHERE id=job_id RETURNING * INTO j;
 ELSE
 PERFORM sync_host.require_page_lease(j,expected_fence);
 IF j."leaseOwner"<>owner_id THEN RAISE EXCEPTION 'SYNC_LEASE_INVALID' USING ERRCODE='42501'; END IF;
 UPDATE sync_host."Job" SET status=CASE WHEN action='FAIL' THEN 'FAILED' ELSE 'RUNNING' END,
 "failureCode"=CASE WHEN action='FAIL' THEN 'CONNECTOR_FAILED' END,"leaseUntil"=clock_timestamp() WHERE id=job_id RETURNING * INTO j;
 END IF;
 IF action<>'FAIL' THEN PERFORM sync_host.require_page_lease(j,j.fence); END IF;
 RETURN to_jsonb(j);
END $$;
REVOKE ALL ON FUNCTION sync_host.control_lease(TEXT,TEXT,INTEGER,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sync_host.control_lease(TEXT,TEXT,INTEGER,TEXT) TO shopmate_sync_worker;
COMMIT;

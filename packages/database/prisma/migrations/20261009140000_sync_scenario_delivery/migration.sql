BEGIN;
-- Private full-scope lookup shared by the demo delivery paths. Every call refreshes authority.
CREATE FUNCTION sync_host.active_scenario_run() RETURNS demo."DemoScenarioRun"
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE descriptor JSONB; run demo."DemoScenarioRun";
BEGIN
 descriptor:=sync_host.runtime_bootstrap(current_setting('sync.grant_id',true));
 IF descriptor IS NULL OR descriptor->>'state'<>'READY' THEN
  RAISE EXCEPTION 'SYNC_AUTHORITY_DENIED' USING ERRCODE='42501'; END IF;
 IF descriptor->>'generatorVersion'<>'mock-source-v2' THEN RETURN NULL; END IF;
 SELECT * INTO run FROM demo."DemoScenarioRun" r WHERE
  (r."organizationId",r."workspaceId",r."storeId",r."sessionId",r."connectionId",r."externalStoreId",r.generation)
  =(descriptor->'scope'->>'organizationId',descriptor->'scope'->>'workspaceId',descriptor->'scope'->>'storeId',
    descriptor->'scope'->>'sessionId',descriptor->'scope'->>'connectionId',descriptor->'scope'->>'externalStoreId',
    (descriptor->'scope'->>'generation')::integer)
  AND r."configHash"=descriptor->>'configHash' AND r.config=descriptor->'config';
 RETURN run;
END $$;
CREATE TABLE sync_host."ScenarioDelivery" (
 id TEXT PRIMARY KEY DEFAULT ('delivery-'||gen_random_uuid()::text),
 "runId" TEXT NOT NULL REFERENCES demo."DemoScenarioRun"(id) ON DELETE RESTRICT,
 "jobId" TEXT NOT NULL REFERENCES sync_host."Job"(id) ON DELETE RESTRICT,
 stream TEXT NOT NULL CHECK (stream IN ('PRODUCTS','ORDERS','REFUNDS','INVENTORY','MARKETING')),
 "pageId" TEXT NOT NULL, "expectedCursor" TEXT, "pageBytes" TEXT NOT NULL CHECK (octet_length("pageBytes")<=16777216),
 envelope JSONB NOT NULL, "envelopeHash" TEXT NOT NULL CHECK ("envelopeHash" ~ '^[a-f0-9]{64}$'),
 "selectedPageCount" INTEGER NOT NULL CHECK ("selectedPageCount">0),
 repetitions INTEGER NOT NULL CHECK (repetitions BETWEEN 1 AND 3),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND repetitions),
 UNIQUE ("runId",stream),
 FOREIGN KEY ("jobId","pageId") REFERENCES sync_host."PageReceipt"("jobId","pageId") ON DELETE RESTRICT
);
ALTER TABLE sync_host."ScenarioDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_host."ScenarioDelivery" FORCE ROW LEVEL SECURITY;
-- No table policy/grant: even an accidental worker table grant cannot expose saved payloads.
REVOKE ALL ON sync_host."ScenarioDelivery" FROM PUBLIC,shopmate_sync_worker,shopmate_mock_source_reader,shopmate_mock_source_worker;
CREATE FUNCTION sync_host.delivery_hash(envelope JSONB, bytes TEXT) RETURNS TEXT
LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array(envelope,bytes)::text,'UTF8')),'hex')
$$;
CREATE FUNCTION sync_host.guard_delivery() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' OR TG_OP='UPDATE' AND
  ((to_jsonb(NEW)-'attempts') IS DISTINCT FROM (to_jsonb(OLD)-'attempts') OR NEW.attempts<>OLD.attempts+1)
  OR current_user=session_user THEN RAISE EXCEPTION 'SYNC_DELIVERY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF NEW."envelopeHash"<>sync_host.delivery_hash(NEW.envelope,NEW."pageBytes") THEN
  RAISE EXCEPTION 'SYNC_DELIVERY_HASH_INVALID' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_delivery BEFORE INSERT OR UPDATE OR DELETE ON sync_host."ScenarioDelivery"
 FOR EACH ROW EXECUTE FUNCTION sync_host.guard_delivery();
CREATE FUNCTION sync_host.commit_delivery_page(job_id TEXT, expected_fence INTEGER, page_id TEXT, expected_cursor TEXT, page_bytes TEXT) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE run demo."DemoScenarioRun"; j sync_host."Job"; result JSONB; envelope JSONB; repetitions INTEGER;
BEGIN
 run:=sync_host.active_scenario_run(); j:=sync_host.worker_job(job_id);
 IF page_bytes IS NULL OR octet_length(page_bytes)>16777216 THEN
  RAISE EXCEPTION 'SYNC_PAGE_INVALID' USING ERRCODE='23514'; END IF;
 result:=sync_host.commit_worker_page(job_id,expected_fence,page_id,expected_cursor,page_bytes::jsonb);
 IF run.id IS NULL OR run.config->'scenarioPlan'->'delivery'->>'kind'<>'REPLAY_SAVED_PAGE' THEN RETURN result; END IF;
 repetitions:=(run.config->'scenarioPlan'->'delivery'->>'repetitions')::integer;
 IF repetitions IS NULL OR repetitions NOT BETWEEN 1 AND 3 THEN
  RAISE EXCEPTION 'SYNC_DELIVERY_POLICY_INVALID' USING ERRCODE='23514'; END IF;
 envelope:=jsonb_build_object('runId',run.id,'configHash',run."configHash",'sessionId',run."sessionId",
  'organizationId',j."organizationId",'workspaceId',j."workspaceId",'storeId',j."storeId",'connectionId',j."connectionId",
  'externalStoreId',j."externalStoreId",'provider',j.provider,'generation',j.generation,'jobId',j.id,'stream',j.stream,
  'since',j.since,'until',j.until,'pageId',page_id,'expectedCursor',expected_cursor);
 INSERT INTO sync_host."ScenarioDelivery"("runId","jobId",stream,"pageId","expectedCursor","pageBytes",envelope,"envelopeHash","selectedPageCount",repetitions)
 VALUES (run.id,j.id,j.stream,page_id,expected_cursor,page_bytes,envelope,sync_host.delivery_hash(envelope,page_bytes),
  (result->'job'->>'pageCount')::integer,repetitions) ON CONFLICT ("runId",stream) DO NOTHING;
 PERFORM sync_host.active_scenario_run();
 RETURN result;
END $$;
CREATE FUNCTION sync_host.pending_delivery_replays() RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE run demo."DemoScenarioRun"; result JSONB;
BEGIN
 run:=sync_host.active_scenario_run(); PERFORM sync_host.worker_grant();
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'attempt',d.attempts+1,'job',to_jsonb(j)) ORDER BY d.stream),'[]'::jsonb)
 INTO result FROM sync_host."ScenarioDelivery" d JOIN sync_host."Job" j ON j.id=d."jobId"
 WHERE d."runId"=run.id AND j."grantId"=current_setting('sync.grant_id',true) AND d.attempts<d.repetitions
  AND (j.status='SUCCEEDED' OR j."pageCount">d."selectedPageCount");
 PERFORM sync_host.active_scenario_run();
 RETURN result;
END $$;
CREATE FUNCTION sync_host.replay_delivery(delivery_id TEXT, expected_fence INTEGER, attempt_ordinal INTEGER, owner_id TEXT) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE run demo."DemoScenarioRun"; d sync_host."ScenarioDelivery"; j sync_host."Job"; result JSONB;
BEGIN
 run:=sync_host.active_scenario_run();
 SELECT * INTO d FROM sync_host."ScenarioDelivery" WHERE id=delivery_id FOR UPDATE;
 IF d.id IS NULL OR d."runId" IS DISTINCT FROM run.id THEN
  RAISE EXCEPTION 'SYNC_AUTHORITY_DENIED' USING ERRCODE='42501'; END IF;
 j:=sync_host.worker_job(d."jobId");
 IF j.fence IS DISTINCT FROM expected_fence OR attempt_ordinal IS NULL OR attempt_ordinal<1
  OR attempt_ordinal>d.attempts+1 OR attempt_ordinal>d.repetitions
  OR d."envelopeHash"<>sync_host.delivery_hash(d.envelope,d."pageBytes") THEN
  RAISE EXCEPTION 'SYNC_DELIVERY_CONFLICT' USING ERRCODE='23505'; END IF;
 IF attempt_ordinal<=d.attempts THEN RETURN jsonb_build_object('status','ACKNOWLEDGED'); END IF;
 IF j.status<>'SUCCEEDED' AND j."pageCount"<=d."selectedPageCount" THEN
  RAISE EXCEPTION 'SYNC_DELIVERY_NOT_READY' USING ERRCODE='23514'; END IF;
 IF j.status<>'SUCCEEDED' THEN
  -- The generic runner explicitly claims leases; recovery must not claim behind its ownership tracking.
  IF j.status<>'RUNNING' OR j."leaseUntil"<=clock_timestamp() OR
   j."leaseOwner" IS DISTINCT FROM owner_id OR j."leaseBackendPid"<>pg_backend_pid() THEN
   RETURN jsonb_build_object('status','BUSY'); END IF;
  result:=sync_host.control_lease(j.id,'RENEW',j.fence,owner_id);
  j:=sync_host.worker_job(j.id);
 END IF;
 result:=sync_host.commit_worker_page(j.id,j.fence,d."pageId",d."expectedCursor",d."pageBytes"::jsonb);
 PERFORM sync_host.active_scenario_run(); PERFORM sync_host.worker_job(j.id);
 UPDATE sync_host."ScenarioDelivery" SET attempts=attempt_ordinal WHERE id=d.id;
 RETURN jsonb_build_object('status','REPLAYED');
END $$;
REVOKE ALL ON FUNCTION sync_host.active_scenario_run(),sync_host.delivery_hash(JSONB,TEXT),sync_host.guard_delivery(),
 sync_host.commit_delivery_page(TEXT,INTEGER,TEXT,TEXT,TEXT),sync_host.pending_delivery_replays(),sync_host.replay_delivery(TEXT,INTEGER,INTEGER,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sync_host.commit_delivery_page(TEXT,INTEGER,TEXT,TEXT,TEXT),sync_host.pending_delivery_replays(),
 sync_host.replay_delivery(TEXT,INTEGER,INTEGER,TEXT) TO shopmate_sync_worker;
COMMIT;

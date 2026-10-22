BEGIN;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shopmate_metric_source') THEN
  CREATE ROLE shopmate_metric_source NOLOGIN NOSUPERUSER NOBYPASSRLS;
 END IF;
END $$;
CREATE FUNCTION public.metric_source_safe_login() RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT current_setting('role') IN ('none',session_user)
 AND current_setting('transaction_isolation')='read committed'
 AND pg_has_role(session_user,'shopmate_metric_source','MEMBER')
 AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolcanlogin)
 AND NOT EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(session_user,r.oid,'MEMBER') AND
 (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
 OR r.rolname IN ('pg_read_all_data','pg_write_all_data','pg_read_server_files','pg_write_server_files','pg_execute_server_program','shopmate_sync_worker')
 OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relowner=r.oid AND n.nspname IN ('public','demo','commerce','sync_host','mock_platform'))
 OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proowner=r.oid AND n.nspname IN ('public','demo','commerce','sync_host','mock_platform'))
 OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspowner=r.oid AND n.nspname IN ('public','demo','commerce','sync_host','mock_platform'))
 OR EXISTS (SELECT 1 FROM pg_database d WHERE d.datdba=r.oid AND d.datname=current_database())))
$$;
CREATE FUNCTION public.metric_source_time(at TIMESTAMPTZ) RETURNS TEXT
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
 SELECT to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
CREATE FUNCTION public.metric_source_binding(s commerce."SourceScope") RETURNS JSONB
LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('organizationId',s."organizationId",'workspaceId',s."workspaceId",'storeId',s."storeId",'connectionId',s."connectionId",'externalStoreId',s."externalStoreId")
$$;
CREATE FUNCTION public.metric_source_authorized(s commerce."SourceScope") RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT public.metric_source_safe_login() AND commerce.can_read(s.id)
 AND s."organizationId"=current_setting('app.organization_id',true)
 AND s."workspaceId"=current_setting('app.workspace_id',true)
 AND (SELECT count(*) FROM public."PlatformConnection" c WHERE c."storeId"=s."storeId" AND c.status='ACTIVE')=1
$$;
CREATE FUNCTION public.metric_source_resolve(store_id TEXT) RETURNS JSONB
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT public.metric_source_binding(s) FROM commerce."SourceScope" s
 WHERE s."storeId"=store_id AND public.metric_source_authorized(s)
$$;
CREATE TABLE public.metric_source_bundles (
 "scopeId" UUID NOT NULL, "organizationId" TEXT NOT NULL,"workspaceId" TEXT NOT NULL,"storeId" TEXT NOT NULL,
 "inputRevision" TEXT NOT NULL CHECK ("inputRevision" ~ '^p2-normalized-v1:[a-f0-9]{64}$'),
 payload JSONB NOT NULL CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=8388608),
 "capturedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY ("scopeId","inputRevision"),
 FOREIGN KEY ("scopeId","organizationId","workspaceId","storeId") REFERENCES commerce."SourceScope"(id,"organizationId","workspaceId","storeId") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CHECK (payload->>'mappingVersion'='p2-normalized-v1' AND payload->>'scopeId'="scopeId"::text),
 CHECK ("inputRevision"='p2-normalized-v1:'||encode(sha256(convert_to(payload::text,'UTF8')),'hex'))
);
ALTER TABLE public.metric_source_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.metric_source_bundles FORCE ROW LEVEL SECURITY;
CREATE POLICY metric_source_bundle_read ON public.metric_source_bundles FOR SELECT TO shopmate_metric_source
 USING (session_user=current_user AND EXISTS (SELECT 1 FROM commerce."SourceScope" s WHERE s.id="scopeId" AND public.metric_source_authorized(s)));
CREATE FUNCTION public.metric_source_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 RAISE EXCEPTION 'Immutable metric source archive' USING ERRCODE='23514';
END $$;
CREATE TRIGGER metric_source_immutable BEFORE UPDATE OR DELETE ON public.metric_source_bundles FOR EACH ROW EXECUTE FUNCTION public.metric_source_immutable();
CREATE TRIGGER metric_source_no_truncate BEFORE TRUNCATE ON public.metric_source_bundles FOR EACH STATEMENT EXECUTE FUNCTION public.metric_source_immutable();

-- Only private owner-invoked helpers can see jobs. No metric worker capability is granted.
CREATE FUNCTION public.metric_source_jobs(s commerce."SourceScope") RETURNS SETOF sync_host."Job"
LANGUAGE SQL STABLE SET search_path=pg_catalog AS $$
 SELECT j.* FROM sync_host."Job" j WHERE
 (j."organizationId",j."workspaceId",j."storeId",j."connectionId",j."externalStoreId",j.provider,j.generation)
 =(s."organizationId",s."workspaceId",s."storeId",s."connectionId",s."externalStoreId",s.provider,s.generation)
 AND j.stream IN ('ORDERS','REFUNDS','INVENTORY','MARKETING')
$$;
CREATE FUNCTION public.metric_source_job_proof(j sync_host."Job") RETURNS JSONB
LANGUAGE SQL STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('jobId',j.id,'stream',j.stream,'since',public.metric_source_time(j.since AT TIME ZONE 'UTC'),
 'until',public.metric_source_time(j.until AT TIME ZONE 'UTC'),'successfulThrough',public.metric_source_time(j."successfulThrough" AT TIME ZONE 'UTC'),
 'proof',(SELECT p||jsonb_build_object('observedAt',public.metric_source_time((p->>'observedAt')::timestamptz),'sourceWatermark',public.metric_source_time((p->>'sourceWatermark')::timestamptz)) FROM (SELECT sync_host.worker_proof(j) p) checked),'receipts',(
 SELECT coalesce(jsonb_agg(jsonb_build_object('pageId',r."pageId",'pageHash',r."pageHash",'expectedCursor',r."expectedCursor",'nextCursor',r."nextCursor",
 'observedAt',public.metric_source_time(c."observedAt"),'sourceWatermark',public.metric_source_time(c."sourceWatermark"),'ingestedAt',public.metric_source_time(r."createdAt")) ORDER BY r."pageId" COLLATE "C"),'[]'::jsonb)
 FROM sync_host."PageReceipt" r JOIN sync_host."CanonicalPageCommit" c ON (c."jobId",c."pageId")=(r."jobId",r."pageId") WHERE r."jobId"=j.id))
$$;
CREATE FUNCTION public.metric_source_prefix(s commerce."SourceScope", cutoff TIMESTAMPTZ, period_end TIMESTAMPTZ, opening TIMESTAMPTZ) RETURNS JSONB
LANGUAGE SQL STABLE SET search_path=pg_catalog AS $$
 WITH jobs AS MATERIALIZED (SELECT * FROM public.metric_source_jobs(s)),
 complete AS MATERIALIZED (SELECT j.*,public.metric_source_job_proof(j) proof,
 lag(j."successfulThrough") OVER (PARTITION BY stream ORDER BY since) previous,
 row_number() OVER (PARTITION BY stream ORDER BY since) position FROM jobs j WHERE status='SUCCEEDED'),
 streams AS (SELECT stream,min(since) first,max("sourceWatermark") watermark,max("observedAt") observed FROM complete GROUP BY stream)
 SELECT jsonb_agg(proof ORDER BY stream,since) FROM complete WHERE
 (SELECT count(*) FROM streams)=4 AND NOT EXISTS (SELECT 1 FROM jobs WHERE status<>'SUCCEEDED' AND "pageCount">0)
 AND NOT EXISTS (SELECT 1 FROM complete WHERE "sourceWatermark" IS NULL OR "successfulThrough" IS NULL OR "observedAt">cutoff
 OR (proof->'proof'->>'terminalCount')::integer<>1 OR (proof->'proof'->>'pageCount')::integer<>"pageCount"
 OR (proof->'proof'->>'knownCount')::integer<>"pageCount" OR (proof->'proof'->>'sourceWatermark')::timestamptz IS DISTINCT FROM "sourceWatermark"
 OR (position>1 AND previous<since) OR (position=1 AND since AT TIME ZONE 'UTC'>opening))
 AND NOT EXISTS (SELECT 1 FROM streams WHERE watermark<period_end OR observed>cutoff)
 AND NOT EXISTS (SELECT 1 FROM sync_host."CanonicalPageCommit" c JOIN jobs j ON j.id=c."jobId" WHERE c."quarantinedCount">0 OR c."observedAt">cutoff)
 AND (SELECT coalesce(sum("pageCount"),0) FROM jobs)<=10000
$$;
CREATE FUNCTION public.metric_source_data(row_data JSONB, external_id TEXT) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE result JSONB; key TEXT;
BEGIN
 result:=row_data-ARRAY['scopeId','organizationId','workspaceId','storeId','sourceVersion','sourceUpdatedAt','sourcePayloadHash','qualityState','qualityIssues','ingestedAt'];
 result:=result||jsonb_build_object('externalStoreId',external_id,'source',jsonb_build_object('version',row_data->'sourceVersion',
 'updatedAt',public.metric_source_time((row_data->>'sourceUpdatedAt')::timestamptz),
 'quality',jsonb_build_object('state',row_data->'qualityState','issues',row_data->'qualityIssues')));
 FOREACH key IN ARRAY ARRAY['orderedAt','paidAt','requestedAt','succeededAt'] LOOP
  IF result ? key THEN result:=jsonb_set(result,ARRAY[key],coalesce(to_jsonb(public.metric_source_time((result->>key)::timestamptz)),'null'::jsonb)); END IF;
 END LOOP;
 RETURN result;
END $$;
CREATE FUNCTION public.metric_source_facts(s commerce."SourceScope", stream_name TEXT, observed TIMESTAMPTZ) RETURNS JSONB
LANGUAGE SQL STABLE SET search_path=pg_catalog AS $$
 WITH rows AS (
 SELECT to_jsonb(o)||jsonb_build_object('items',(SELECT jsonb_agg(to_jsonb(l)-ARRAY['scopeId','organizationId','workspaceId','storeId','externalOrderId'] ORDER BY l."externalLineId" COLLATE "C") FROM commerce."OrderLineListing" l WHERE (l."scopeId",l."externalOrderId")=(o."scopeId",o."externalOrderId"))) value FROM commerce."OrderListing" o WHERE o."scopeId"=s.id AND stream_name='ORDERS'
 UNION ALL SELECT to_jsonb(r) FROM commerce."RefundListing" r WHERE r."scopeId"=s.id AND stream_name='REFUNDS'
 UNION ALL SELECT to_jsonb(i) FROM commerce."InventoryListing" i WHERE i."scopeId"=s.id AND stream_name='INVENTORY'
 UNION ALL SELECT to_jsonb(c) FROM commerce."CampaignMetricListing" c WHERE c."scopeId"=s.id AND stream_name='MARKETING')
 SELECT coalesce(jsonb_agg(jsonb_build_object('data',public.metric_source_data(value,s."externalStoreId"),
 'sourcePayloadHash',value->'sourcePayloadHash','ingestedAt',public.metric_source_time((value->>'ingestedAt')::timestamptz),
 'observedAt',public.metric_source_time(observed)) ORDER BY value->>'externalOrderId' COLLATE "C",value->>'externalRefundId' COLLATE "C",value->>'externalSkuId' COLLATE "C",value->>'externalLocationId' COLLATE "C",value->>'externalCampaignId' COLLATE "C",value->>'date'),'[]'::jsonb) FROM rows
$$;
CREATE FUNCTION public.metric_source_visible(facts JSONB, cutoff TIMESTAMPTZ, opening TIMESTAMPTZ) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_array_length(facts)<=10000 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(facts) f WHERE
 f->'data'->'source'->>'updatedAt' IS NULL OR (f->'data'->'source'->>'updatedAt')::timestamptz>cutoff
 OR (f->'data'->>'orderedAt')::timestamptz>cutoff OR (f->'data'->>'paidAt')::timestamptz>cutoff
 OR (f->'data'->>'requestedAt')::timestamptz>cutoff OR (f->'data'->>'succeededAt')::timestamptz>cutoff
 OR (f->'data'->>'orderedAt')::timestamptz<opening OR (f->'data'->>'requestedAt')::timestamptz<opening
 OR (f->'data'->>'date')::date>(cutoff AT TIME ZONE 'Asia/Shanghai')::date
 OR (f->'data'->'source'->'quality'->'issues') ? 'SOURCE_INCONSISTENT')
$$;
CREATE FUNCTION public.metric_source_projection(binding JSONB, requested_window JSONB, cutoff TIMESTAMPTZ) RETURNS JSONB
LANGUAGE SQL STABLE SET search_path=pg_catalog AS $$
 WITH scope AS MATERIALIZED (SELECT s AS source_scope,s.*,d."clockNow" AT TIME ZONE 'UTC' business_now,d."clockRevision",(d.config->>'historyStart')::timestamptz opening
 FROM commerce."SourceScope" s JOIN demo."DemoCommerceSession" d ON (d."connectionId",d."organizationId",d."workspaceId",d."storeId",d."externalStoreId")=(s."connectionId",s."organizationId",s."workspaceId",s."storeId",s."externalStoreId")
 WHERE requested_window-ARRAY['periodStart','periodEnd','timezone','currency']='{}'::jsonb AND requested_window->>'timezone'='Asia/Shanghai' AND requested_window->>'currency'='CNY' AND (requested_window->>'periodStart')::timestamptz<(requested_window->>'periodEnd')::timestamptz AND (requested_window->>'periodEnd')::timestamptz<=cutoff AND cutoff=date_trunc('milliseconds',cutoff) AND public.metric_source_binding(s)=binding AND public.metric_source_authorized(s) AND cutoff<=d."clockNow" AT TIME ZONE 'UTC'),
 evidence AS MATERIALIZED (SELECT s.*,public.metric_source_prefix(s.source_scope,cutoff,(requested_window->>'periodEnd')::timestamptz,s.opening) prefix FROM scope s),
 facts AS MATERIALIZED (SELECT e.*,v.stream,public.metric_source_facts(s,v.stream,(SELECT max(j."observedAt") FROM public.metric_source_jobs(s) j WHERE j.stream=v.stream)) items
 FROM evidence e JOIN commerce."SourceScope" s ON s.id=e.id CROSS JOIN (VALUES ('ORDERS'),('REFUNDS'),('INVENTORY'),('MARKETING')) v(stream) WHERE e.prefix IS NOT NULL)
 SELECT jsonb_build_object('mappingVersion','p2-normalized-v1','binding',binding,'scopeId',id,'provider',provider,'generation',generation,
 'window',requested_window,'visibleAt',public.metric_source_time(cutoff),'businessNow',public.metric_source_time(business_now),'clockRevision',"clockRevision",
 'sourceOpening',public.metric_source_time(opening),'sourceWatermark',public.metric_source_time((SELECT min(watermark) FROM (SELECT max((p->'proof'->>'sourceWatermark')::timestamptz) watermark FROM jsonb_array_elements(prefix) p GROUP BY p->>'stream') latest)),
 'prefixes',prefix,'orders',max(items::text) FILTER (WHERE stream='ORDERS')::jsonb,'refunds',max(items::text) FILTER (WHERE stream='REFUNDS')::jsonb,
 'inventory',max(items::text) FILTER (WHERE stream='INVENTORY')::jsonb,'campaigns',max(items::text) FILTER (WHERE stream='MARKETING')::jsonb)
 FROM facts GROUP BY id,provider,generation,business_now,"clockRevision",opening,prefix HAVING bool_and(public.metric_source_visible(items,cutoff,opening))
$$;
CREATE FUNCTION public.metric_source_capture(binding JSONB, requested_window JSONB, cutoff TIMESTAMPTZ) RETURNS JSONB
LANGUAGE SQL VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH projection AS MATERIALIZED (SELECT public.metric_source_projection(binding,requested_window,cutoff) payload),
 inserted AS (INSERT INTO public.metric_source_bundles ("scopeId","organizationId","workspaceId","storeId","inputRevision",payload)
 SELECT (payload->>'scopeId')::uuid,binding->>'organizationId',binding->>'workspaceId',binding->>'storeId',
 'p2-normalized-v1:'||encode(sha256(convert_to(payload::text,'UTF8')),'hex'),payload FROM projection WHERE payload IS NOT NULL
 ON CONFLICT DO NOTHING RETURNING *)
 SELECT jsonb_build_object('inputRevision',"inputRevision",'payload',payload,'capturedAt',public.metric_source_time("capturedAt")) FROM inserted
 UNION ALL SELECT jsonb_build_object('inputRevision',b."inputRevision",'payload',b.payload,'capturedAt',public.metric_source_time(b."capturedAt"))
 FROM public.metric_source_bundles b JOIN projection p ON p.payload=b.payload WHERE NOT EXISTS (SELECT 1 FROM inserted)
$$;
CREATE FUNCTION public.metric_source_read(binding JSONB, requested_window JSONB, cutoff TIMESTAMPTZ, requested_revision TEXT) RETURNS JSONB
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('inputRevision',b."inputRevision",'payload',b.payload,'capturedAt',public.metric_source_time(b."capturedAt"))
 FROM public.metric_source_bundles b JOIN commerce."SourceScope" s ON s.id=b."scopeId"
 JOIN demo."DemoCommerceSession" d ON d."connectionId"=s."connectionId"
 WHERE public.metric_source_authorized(s) AND public.metric_source_binding(s)=binding AND b."inputRevision"=requested_revision
 AND b.payload->'window'=requested_window AND (b.payload->>'visibleAt')::timestamptz=cutoff AND cutoff<=d."clockNow" AT TIME ZONE 'UTC'
$$;
REVOKE ALL ON public.metric_source_bundles FROM PUBLIC,shopmate_metric_source;
REVOKE ALL ON FUNCTION public.metric_source_safe_login(),public.metric_source_time(TIMESTAMPTZ),public.metric_source_binding(commerce."SourceScope"),public.metric_source_authorized(commerce."SourceScope"),public.metric_source_resolve(TEXT),public.metric_source_immutable(),public.metric_source_jobs(commerce."SourceScope"),public.metric_source_job_proof(sync_host."Job"),public.metric_source_prefix(commerce."SourceScope",TIMESTAMPTZ,TIMESTAMPTZ,TIMESTAMPTZ),public.metric_source_data(JSONB,TEXT),public.metric_source_facts(commerce."SourceScope",TEXT,TIMESTAMPTZ),public.metric_source_visible(JSONB,TIMESTAMPTZ,TIMESTAMPTZ),public.metric_source_projection(JSONB,JSONB,TIMESTAMPTZ),public.metric_source_capture(JSONB,JSONB,TIMESTAMPTZ),public.metric_source_read(JSONB,JSONB,TIMESTAMPTZ,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.metric_source_safe_login(),public.metric_source_resolve(TEXT),public.metric_source_capture(JSONB,JSONB,TIMESTAMPTZ),public.metric_source_read(JSONB,JSONB,TIMESTAMPTZ,TEXT) TO shopmate_metric_source;
COMMIT;

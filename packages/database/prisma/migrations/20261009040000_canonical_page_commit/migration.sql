BEGIN;
-- Fixed trusted relation dispatch. No caller-controlled SQL identifiers are admitted.
CREATE FUNCTION sync_host.canonical_table(stream TEXT) RETURNS REGCLASS
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 CASE stream WHEN 'ORDERS' THEN RETURN 'commerce."OrderListing"'::regclass;
 WHEN 'REFUNDS' THEN RETURN 'commerce."RefundListing"'::regclass;
 WHEN 'INVENTORY' THEN RETURN 'commerce."InventoryListing"'::regclass;
 WHEN 'MARKETING' THEN RETURN 'commerce."CampaignMetricListing"'::regclass;
 ELSE RAISE EXCEPTION 'INVALID_CANONICAL_STREAM' USING ERRCODE='23514'; END CASE;
END $$;

CREATE FUNCTION sync_host.canonical_keys(stream TEXT) RETURNS TEXT[]
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 CASE stream WHEN 'ORDERS' THEN RETURN ARRAY['externalOrderId'];
 WHEN 'REFUNDS' THEN RETURN ARRAY['externalRefundId'];
 WHEN 'INVENTORY' THEN RETURN ARRAY['externalSkuId','externalLocationId'];
 WHEN 'MARKETING' THEN RETURN ARRAY['externalCampaignId','date'];
 ELSE RAISE EXCEPTION 'INVALID_CANONICAL_STREAM' USING ERRCODE='23514'; END CASE;
END $$;

CREATE FUNCTION sync_host.canonical_fields(stream TEXT) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 CASE stream WHEN 'ORDERS' THEN RETURN '{"ids":["externalOrderId"],"nullableIds":[],"amounts":["grossMinor","discountMinor","shippingMinor","payableMinor"],"nullableAmounts":["paidMinor","refundedMinor"],"times":["orderedAt"],"nullableTimes":["paidAt"],"other":["status","currency","items"]}'::jsonb;
 WHEN 'REFUNDS' THEN RETURN '{"ids":["externalRefundId","externalOrderId"],"nullableIds":["externalSkuId"],"amounts":["requestedMinor"],"nullableAmounts":["succeededMinor"],"times":["requestedAt"],"nullableTimes":["succeededAt"],"other":["status","currency"]}'::jsonb;
 WHEN 'INVENTORY' THEN RETURN '{"ids":["externalSkuId","externalLocationId"],"nullableIds":[],"amounts":[],"nullableAmounts":["available","reserved","onHand","safetyStock","leadTimeDays"],"times":[],"nullableTimes":[],"other":[]}'::jsonb;
 WHEN 'MARKETING' THEN RETURN '{"ids":["externalCampaignId"],"nullableIds":[],"amounts":[],"nullableAmounts":["impressions","clicks","attributedOrders","spendMinor","attributedRevenueMinor"],"times":[],"nullableTimes":[],"other":["date","currency"]}'::jsonb;
 ELSE RAISE EXCEPTION 'INVALID_CANONICAL_STREAM' USING ERRCODE='23514'; END CASE;
END $$;

CREATE FUNCTION sync_host.canonical_time(value JSONB, nullable BOOLEAN DEFAULT false) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE at TIMESTAMPTZ;
BEGIN
 IF nullable AND value='null'::jsonb THEN RETURN value; END IF;
 IF jsonb_typeof(value) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'INVALID_RECORD' USING ERRCODE='23514'; END IF;
 at:=sync_host.product_time(value #>> '{}');
 IF at<timestamptz '0001-01-01 00:00:00Z' OR at>timestamptz '9999-12-31 23:59:59.999Z' THEN
  RAISE EXCEPTION 'SOURCE_TIME_STORAGE_RANGE' USING ERRCODE='23514'; END IF;
 RETURN to_jsonb(to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END $$;

CREATE FUNCTION sync_host.canonical_row(value JSONB, scope commerce."SourceScope", payload_hash TEXT) RETURNS JSONB
LANGUAGE SQL SET search_path=pg_catalog AS $$
 SELECT value-ARRAY['externalStoreId','source','items']||jsonb_build_object(
  'scopeId',scope.id,'organizationId',scope."organizationId",'workspaceId',scope."workspaceId",'storeId',scope."storeId",
  'sourceVersion',value->'source'->'version','sourceUpdatedAt',value->'source'->'updatedAt','sourcePayloadHash',payload_hash,
  'qualityState',value->'source'->'quality'->'state','qualityIssues',value->'source'->'quality'->'issues','ingestedAt',clock_timestamp())
$$;

-- Evaluate trusted storage CHECK and NOT NULL constraints before decisions, even for stale candidates.
-- Values stay bind parameters; this does not insert facts or invoke physical write triggers.
CREATE FUNCTION sync_host.canonical_check(relation REGCLASS, value JSONB) RETURNS VOID
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE predicate TEXT; required TEXT; valid BOOLEAN;
BEGIN
 IF relation NOT IN ('commerce."OrderListing"'::regclass,'commerce."OrderLineListing"'::regclass,
  'commerce."RefundListing"'::regclass,'commerce."InventoryListing"'::regclass,'commerce."CampaignMetricListing"'::regclass) THEN
  RAISE EXCEPTION 'INVALID_RECORD' USING ERRCODE='23514'; END IF;
 SELECT string_agg(format('coalesce((%s),true)',pg_get_expr(conbin,conrelid)),' AND ' ORDER BY oid)
 INTO predicate FROM pg_constraint WHERE conrelid=relation AND contype='c';
 SELECT string_agg(format('%I IS NOT NULL',attname),' AND ' ORDER BY attnum)
 INTO required FROM pg_attribute WHERE attrelid=relation AND attnum>0 AND NOT attisdropped AND attnotnull;
 EXECUTE format('SELECT (%s) AND (%s) FROM jsonb_populate_record(NULL::%s,$1)',coalesce(predicate,'true'),coalesce(required,'true'),relation)
 INTO valid USING value;
 IF valid IS DISTINCT FROM true THEN RAISE EXCEPTION 'INVALID_RECORD' USING ERRCODE='23514'; END IF;
END $$;

CREATE FUNCTION sync_host.canonical_lines(value JSONB, scope commerce."SourceScope") RETURNS JSONB
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE line JSONB; normalized JSONB; result JSONB:='[]'; key TEXT; ids TEXT[]:=ARRAY[]::text[];
 gross NUMERIC:=0; discount NUMERIC:=0;
BEGIN
 IF jsonb_typeof(value->'items') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'INVALID_RECORD' USING ERRCODE='23514'; END IF;
 IF jsonb_array_length(value->'items') NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'INVALID_RECORD' USING ERRCODE='23514'; END IF;
 FOR line IN SELECT * FROM jsonb_array_elements(value->'items') LOOP
  IF NOT sync_host.product_object(line,ARRAY['externalLineId','externalProductId','externalSkuId','quantity','unitPriceMinor','grossMinor','discountMinor','netMinor']) THEN
   RAISE EXCEPTION 'INVALID_RECORD' USING ERRCODE='23514'; END IF;
  normalized:=line;
  FOREACH key IN ARRAY ARRAY['externalLineId','externalProductId','externalSkuId'] LOOP
   normalized:=jsonb_set(normalized,ARRAY[key],sync_host.product_string(line->key,256,false)); END LOOP;
  FOREACH key IN ARRAY ARRAY['quantity','unitPriceMinor','grossMinor','discountMinor','netMinor'] LOOP
   normalized:=jsonb_set(normalized,ARRAY[key],sync_host.product_minor(line->key)); END LOOP;
  IF normalized->>'externalLineId' COLLATE "C"=ANY(ids) THEN RAISE EXCEPTION 'INVALID_RECORD' USING ERRCODE='23514'; END IF;
  ids:=array_append(ids,normalized->>'externalLineId');
  PERFORM sync_host.canonical_check('commerce."OrderLineListing"'::regclass,normalized||jsonb_build_object(
   'scopeId',scope.id,'organizationId',scope."organizationId",'workspaceId',scope."workspaceId",'storeId',scope."storeId",'externalOrderId',value->>'externalOrderId'));
  gross:=gross+(normalized->>'grossMinor')::numeric; discount:=discount+(normalized->>'discountMinor')::numeric;
  result:=result||jsonb_build_array(normalized);
 END LOOP;
 IF gross<>(value->>'grossMinor')::numeric OR discount<>(value->>'discountMinor')::numeric
  OR gross>9007199254740991 OR discount>9007199254740991 THEN RAISE EXCEPTION 'INVALID_RECORD' USING ERRCODE='23514'; END IF;
 RETURN result;
END $$;

CREATE FUNCTION sync_host.normalize_canonical(value JSONB, stream TEXT, scope commerce."SourceScope") RETURNS JSONB
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE fields JSONB:=sync_host.canonical_fields(stream); keys TEXT[]; category TEXT; key TEXT;
 result JSONB:=value; nullable BOOLEAN; date_value DATE;
BEGIN
 SELECT array_agg(name) INTO keys FROM (SELECT jsonb_array_elements_text(v) name FROM jsonb_each(fields) e(k,v)
  UNION ALL SELECT unnest(ARRAY['externalStoreId','source'])) names;
 IF NOT sync_host.product_object(value,keys) OR value->>'externalStoreId' IS DISTINCT FROM scope."externalStoreId" THEN
  RAISE EXCEPTION 'INVALID_RECORD' USING ERRCODE='23514'; END IF;
 result:=jsonb_set(result,'{externalStoreId}',sync_host.product_string(value->'externalStoreId',256,false));
 result:=jsonb_set(result,'{source}',sync_host.product_source(value->'source'));
 FOREACH category IN ARRAY ARRAY['ids','nullableIds','amounts','nullableAmounts','times','nullableTimes'] LOOP
  nullable:=left(category,8)='nullable';
  FOR key IN SELECT jsonb_array_elements_text(fields->category) LOOP
   IF category IN ('ids','nullableIds') THEN result:=jsonb_set(result,ARRAY[key],sync_host.product_string(value->key,256,false,nullable));
   ELSIF category IN ('amounts','nullableAmounts') THEN result:=jsonb_set(result,ARRAY[key],sync_host.product_minor(value->key,nullable));
   ELSE result:=jsonb_set(result,ARRAY[key],sync_host.canonical_time(value->key,nullable)); END IF;
  END LOOP;
 END LOOP;
 IF value ? 'status' AND jsonb_typeof(value->'status') IS DISTINCT FROM 'string'
  OR value ? 'currency' AND (jsonb_typeof(value->'currency') IS DISTINCT FROM 'string' OR value->>'currency'<>'CNY') THEN
  RAISE EXCEPTION 'INVALID_RECORD' USING ERRCODE='23514'; END IF;
 IF stream='MARKETING' THEN
  IF jsonb_typeof(value->'date') IS DISTINCT FROM 'string' OR value->>'date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
   RAISE EXCEPTION 'INVALID_RECORD' USING ERRCODE='23514'; END IF;
  date_value:=(value->>'date')::date;
 END IF;
 IF stream='ORDERS' THEN result:=jsonb_set(result,'{items}',sync_host.canonical_lines(result,scope)); END IF;
 PERFORM sync_host.canonical_check(sync_host.canonical_table(stream),sync_host.canonical_row(result,scope,repeat('0',64)));
 RETURN result;
END $$;

CREATE FUNCTION sync_host.canonical_payload_hash(value JSONB, stream TEXT) RETURNS TEXT
LANGUAGE SQL SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to((value-ARRAY['source','items']||jsonb_build_object('quality',
  jsonb_set(value->'source'->'quality','{issues}',(SELECT coalesce(jsonb_agg(issue ORDER BY issue #>> '{}' COLLATE "C"),'[]'::jsonb)
   FROM jsonb_array_elements(value->'source'->'quality'->'issues') issue)))||
  CASE WHEN stream='ORDERS' THEN jsonb_build_object('items',(SELECT jsonb_agg(line ORDER BY line->>'externalLineId' COLLATE "C")
   FROM jsonb_array_elements(value->'items') line)) ELSE '{}'::jsonb END)::text,'UTF8')),'hex')
$$;

CREATE FUNCTION sync_host.canonical_page_input(page JSONB, job sync_host."Job") RETURNS VOID
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE item JSONB; lines INTEGER:=0; observed TIMESTAMPTZ; watermark TIMESTAMPTZ;
BEGIN
 IF octet_length(page::text)>16777216 THEN RAISE EXCEPTION 'PAGE_TOO_LARGE' USING ERRCODE='23514'; END IF;
 IF NOT sync_host.product_object(page,ARRAY['items','nextCursor','observedAt','sourceWatermark'])
  OR jsonb_typeof(page->'items') IS DISTINCT FROM 'array' OR job.until IS NULL THEN
  RAISE EXCEPTION 'INVALID_PAGE' USING ERRCODE='23514'; END IF;
 IF jsonb_array_length(page->'items')>200 THEN RAISE EXCEPTION 'INVALID_PAGE' USING ERRCODE='23514'; END IF;
 PERFORM sync_host.product_string(page->'nextCursor',1024,false,true);
 PERFORM sync_host.canonical_time(page->'observedAt');
 observed:=sync_host.product_time(page->>'observedAt');
 IF page->'sourceWatermark'<>'null'::jsonb THEN
  PERFORM sync_host.canonical_time(page->'sourceWatermark');
  watermark:=sync_host.product_time(page->>'sourceWatermark');
  IF watermark>least(job.until AT TIME ZONE 'UTC',observed) THEN RAISE EXCEPTION 'INVALID_PAGE' USING ERRCODE='23514'; END IF;
 END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(page->'items') LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR jsonb_typeof(item->'externalStoreId') IS DISTINCT FROM 'string'
   OR item->>'externalStoreId' IS DISTINCT FROM job."externalStoreId" THEN
   RAISE EXCEPTION 'SOURCE_SCOPE_MISMATCH' USING ERRCODE='23514'; END IF;
  IF job.stream='ORDERS' AND jsonb_typeof(item->'items')='array' THEN lines:=lines+jsonb_array_length(item->'items'); END IF;
  IF lines>5000 THEN RAISE EXCEPTION 'PAGE_TOO_LARGE' USING ERRCODE='23514'; END IF;
 END LOOP;
END $$;

REVOKE ALL ON FUNCTION sync_host.canonical_page_input(JSONB,sync_host."Job"),sync_host.canonical_table(TEXT),sync_host.canonical_keys(TEXT),sync_host.canonical_fields(TEXT),
 sync_host.canonical_time(JSONB,BOOLEAN),sync_host.canonical_row(JSONB,commerce."SourceScope",TEXT),
 sync_host.canonical_check(REGCLASS,JSONB),sync_host.canonical_lines(JSONB,commerce."SourceScope"),
 sync_host.normalize_canonical(JSONB,TEXT,commerce."SourceScope"),sync_host.canonical_payload_hash(JSONB,TEXT) FROM PUBLIC;
CREATE TABLE sync_host."CanonicalPageCommit" (
 "jobId" TEXT NOT NULL, "pageId" TEXT NOT NULL, "scopeId" UUID NOT NULL,
 "organizationId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "storeId" TEXT NOT NULL,
 codec TEXT NOT NULL DEFAULT 'canonical-page-v1' CHECK (codec='canonical-page-v1'),
 "pageHash" TEXT NOT NULL CHECK ("pageHash" ~ '^[a-f0-9]{64}$'),
 "observedAt" TIMESTAMPTZ(3) NOT NULL, "sourceWatermark" TIMESTAMPTZ(3), terminal BOOLEAN NOT NULL,
 "acceptedFence" INTEGER NOT NULL CHECK ("acceptedFence">=1),
 "inputCount" INTEGER NOT NULL CHECK ("inputCount" BETWEEN 0 AND 200),
 "appliedCount" INTEGER NOT NULL CHECK ("appliedCount" BETWEEN 0 AND 200),
 "duplicateCount" INTEGER NOT NULL CHECK ("duplicateCount" BETWEEN 0 AND 200),
 "staleCount" INTEGER NOT NULL CHECK ("staleCount" BETWEEN 0 AND 200),
 "quarantinedCount" INTEGER NOT NULL CHECK ("quarantinedCount" BETWEEN 0 AND 200),
 "lineInsertedCount" INTEGER NOT NULL CHECK ("lineInsertedCount" BETWEEN 0 AND 5000),
 "lineDeletedCount" INTEGER NOT NULL CHECK ("lineDeletedCount" BETWEEN 0 AND 100000),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY ("jobId","pageId"),
 CONSTRAINT "CanonicalPageCommit_tenant_key" UNIQUE ("jobId","pageId","organizationId","workspaceId","storeId"),
 CONSTRAINT "CanonicalPageCommit_receipt_fkey" FOREIGN KEY ("jobId","pageId") REFERENCES sync_host."PageReceipt"("jobId","pageId") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "CanonicalPageCommit_job_fkey" FOREIGN KEY ("jobId","organizationId","workspaceId","storeId") REFERENCES sync_host."Job"(id,"organizationId","workspaceId","storeId") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "CanonicalPageCommit_scope_fkey" FOREIGN KEY ("scopeId","organizationId","workspaceId","storeId") REFERENCES commerce."SourceScope"(id,"organizationId","workspaceId","storeId") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CHECK ("inputCount"="appliedCount"+"duplicateCount"+"staleCount"+"quarantinedCount")
);
CREATE TABLE sync_host."CanonicalPageDecision" (
 "jobId" TEXT NOT NULL, "pageId" TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 199),
 "organizationId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "storeId" TEXT NOT NULL,
 "recordKey" JSONB, "candidateHash" TEXT NOT NULL CHECK ("candidateHash" ~ '^[a-f0-9]{64}$'),
 decision TEXT NOT NULL CHECK (decision IN ('APPLY','DUPLICATE','STALE','QUARANTINED')),
 "previousVersion" TEXT, "previousUpdatedAt" TIMESTAMPTZ(3), "previousPayloadHash" TEXT,
 PRIMARY KEY ("jobId","pageId",ordinal),
 CONSTRAINT "CanonicalPageDecision_tenant_key" UNIQUE ("jobId","pageId",ordinal,"organizationId","workspaceId","storeId"),
 CONSTRAINT "CanonicalPageDecision_commit_fkey" FOREIGN KEY ("jobId","pageId","organizationId","workspaceId","storeId") REFERENCES sync_host."CanonicalPageCommit"("jobId","pageId","organizationId","workspaceId","storeId") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE TABLE sync_host."CanonicalQuarantine" (
 "jobId" TEXT NOT NULL, "pageId" TEXT NOT NULL, ordinal INTEGER NOT NULL,
 "organizationId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "storeId" TEXT NOT NULL,
 reason TEXT NOT NULL CHECK (reason IN ('INVALID_RECORD','INVALID_SOURCE_TIME','SOURCE_TIME_STORAGE_RANGE','SOURCE_TIME_OUTSIDE_WINDOW','SOURCE_CONFLICT')),
 PRIMARY KEY ("jobId","pageId",ordinal),
 CONSTRAINT "CanonicalQuarantine_tenant_key" UNIQUE ("jobId","pageId",ordinal,"organizationId","workspaceId","storeId"),
 CONSTRAINT "CanonicalQuarantine_decision_fkey" FOREIGN KEY ("jobId","pageId",ordinal,"organizationId","workspaceId","storeId") REFERENCES sync_host."CanonicalPageDecision"("jobId","pageId",ordinal,"organizationId","workspaceId","storeId") ON DELETE RESTRICT ON UPDATE NO ACTION
);
ALTER TABLE sync_host."CanonicalPageCommit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_host."CanonicalPageCommit" FORCE ROW LEVEL SECURITY;
ALTER TABLE sync_host."CanonicalPageDecision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_host."CanonicalPageDecision" FORCE ROW LEVEL SECURITY;
ALTER TABLE sync_host."CanonicalQuarantine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_host."CanonicalQuarantine" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON sync_host."CanonicalPageCommit",sync_host."CanonicalPageDecision",sync_host."CanonicalQuarantine" FROM PUBLIC;

CREATE FUNCTION sync_host.canonical_open_job(job_id TEXT, expected_fence INTEGER) RETURNS sync_host."Job"
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE job sync_host."Job";
BEGIN
 IF NOT sync_host.safe_login(session_user) THEN RAISE EXCEPTION 'Invalid sync login' USING ERRCODE='42501'; END IF;
 SELECT * INTO job FROM sync_host."Job" WHERE id=job_id;
 PERFORM sync_host.require_page_lease(job,expected_fence);
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CANONICAL_REQUIRES_READ_COMMITTED' USING ERRCODE='23514'; END IF;
 PERFORM sync_host.canonical_table(job.stream);
 SELECT * INTO job FROM sync_host."Job" WHERE id=job_id FOR UPDATE;
 PERFORM sync_host.require_page_lease(job,expected_fence);
 PERFORM g.id FROM sync_host."WorkerGrant" g WHERE g.id=job."grantId" FOR SHARE;
 -- Keep authority stable through COMMIT; revocation linearizes after this transaction.
 PERFORM m.id FROM public."OrganizationMember" m
 JOIN public."Organization" o ON o.id=m."organizationId"
 JOIN public."WorkspaceMember" a ON a."organizationId"=m."organizationId" AND a."userId"=m."userId"
 JOIN public."Workspace" w ON w.id=a."workspaceId" AND w."organizationId"=a."organizationId"
 JOIN public."Store" s ON s."organizationId"=w."organizationId" AND s."workspaceId"=w.id
 JOIN public."Merchant" merchant ON merchant.id=s."merchantId"
 JOIN public."PlatformConnection" c ON c."storeId"=s.id
 WHERE m."userId"=current_setting('app.user_id',true) AND m."organizationId"=job."organizationId"
  AND w.id=job."workspaceId" AND s.id=job."storeId" AND c.id=job."connectionId"
 FOR SHARE OF m,o,a,w,s,merchant,c;
 PERFORM sync_host.require_page_lease(job,expected_fence);
 RETURN job;
END $$;

CREATE FUNCTION sync_host.canonical_page_hash(job JSONB, expected_cursor TEXT, page JSONB) RETURNS TEXT
LANGUAGE SQL SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object('codec','canonical-page-v1',
  'job',(SELECT jsonb_object_agg(key,job->key) FROM unnest(ARRAY['id','organizationId','workspaceId',
   'storeId','connectionId','externalStoreId','provider','generation','stream','since','until']) key),
  'expectedCursor',expected_cursor,'page',page)::text,'UTF8')),'hex')
$$;

CREATE FUNCTION sync_host.canonical_identity(value JSONB, stream TEXT) RETURNS JSONB
LANGUAGE SQL SET search_path=pg_catalog AS $$
 SELECT jsonb_object_agg(key,value->key) FROM unnest(sync_host.canonical_keys(stream)) key
$$;

CREATE FUNCTION sync_host.canonical_previous(value JSONB, stream TEXT, scope_id UUID) RETURNS JSONB
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE predicate TEXT; previous JSONB;
BEGIN
 SELECT string_agg(format('%I COLLATE "C"=($2->>%L) COLLATE "C"',key,key),' AND ') INTO predicate
 FROM unnest(sync_host.canonical_keys(stream)) key WHERE key<>'date';
 IF stream='MARKETING' THEN predicate:=predicate||' AND date=($2->>''date'')::date'; END IF;
 EXECUTE format('SELECT jsonb_build_object(''version'',"sourceVersion",''updatedAt'',CASE WHEN "sourceUpdatedAt" IS NOT NULL THEN to_char("sourceUpdatedAt" AT TIME ZONE ''UTC'',''YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'') END,''payloadHash'',"sourcePayloadHash") FROM %s WHERE "scopeId"=$1 AND %s FOR UPDATE',sync_host.canonical_table(stream),predicate)
 INTO previous USING scope_id,value;
 RETURN previous;
END $$;

CREATE FUNCTION sync_host.canonical_write(relation REGCLASS, value JSONB, keys TEXT[]) RETURNS VOID
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE columns TEXT; updates TEXT; conflict TEXT; changed INTEGER;
BEGIN
 IF relation NOT IN ('commerce."OrderListing"'::regclass,'commerce."OrderLineListing"'::regclass,
  'commerce."RefundListing"'::regclass,'commerce."InventoryListing"'::regclass,'commerce."CampaignMetricListing"'::regclass) THEN
  RAISE EXCEPTION 'INVALID_RECORD' USING ERRCODE='23514'; END IF;
 SELECT string_agg(format('%I',attname),',' ORDER BY attnum),
  string_agg(format('%I=excluded.%I',attname,attname),',' ORDER BY attnum) FILTER (WHERE NOT attname=ANY(keys))
 INTO columns,updates FROM pg_attribute WHERE attrelid=relation AND attnum>0 AND NOT attisdropped;
 SELECT string_agg(format('%I',key),',') INTO conflict FROM unnest(keys) key;
 EXECUTE format('INSERT INTO %s (%s) SELECT %s FROM jsonb_populate_record(NULL::%s,$1) ON CONFLICT (%s) DO UPDATE SET %s',
  relation,columns,columns,relation,conflict,updates) USING value;
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>1 THEN RAISE EXCEPTION 'CANONICAL_WRITE_COUNT_MISMATCH' USING ERRCODE='23514'; END IF;
END $$;

CREATE FUNCTION sync_host.canonical_apply(value JSONB, stream TEXT, scope commerce."SourceScope", payload_hash TEXT) RETURNS JSONB
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE line JSONB; deleted INTEGER:=0; expected_deleted INTEGER; inserted INTEGER:=0;
BEGIN
 PERFORM sync_host.canonical_write(sync_host.canonical_table(stream),sync_host.canonical_row(value,scope,payload_hash),
  ARRAY['scopeId']||sync_host.canonical_keys(stream));
 IF stream='ORDERS' THEN
  SELECT count(*) INTO expected_deleted FROM commerce."OrderLineListing" WHERE "scopeId"=scope.id AND "externalOrderId"=value->>'externalOrderId';
  DELETE FROM commerce."OrderLineListing" WHERE "scopeId"=scope.id AND "externalOrderId"=value->>'externalOrderId';
  GET DIAGNOSTICS deleted=ROW_COUNT;
  IF deleted<>expected_deleted THEN RAISE EXCEPTION 'CANONICAL_WRITE_COUNT_MISMATCH' USING ERRCODE='23514'; END IF;
  FOR line IN SELECT * FROM jsonb_array_elements(value->'items') LOOP
   PERFORM sync_host.canonical_write('commerce."OrderLineListing"'::regclass,line||jsonb_build_object(
    'scopeId',scope.id,'organizationId',scope."organizationId",'workspaceId',scope."workspaceId",'storeId',scope."storeId",'externalOrderId',value->>'externalOrderId'),
    ARRAY['scopeId','externalOrderId','externalLineId']);
   inserted:=inserted+1;
  END LOOP;
  PERFORM commerce.check_order(scope.id,value->>'externalOrderId');
 END IF;
 RETURN jsonb_build_object('lineInsertedCount',inserted,'lineDeletedCount',deleted);
END $$;

CREATE FUNCTION sync_host.canonical_candidate(item JSONB, job sync_host."Job", scope commerce."SourceScope", page JSONB) RETURNS JSONB
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE normalized JSONB; reason TEXT;
BEGIN
 BEGIN
  normalized:=sync_host.normalize_canonical(item,job.stream,scope);
  IF normalized->'source'->'updatedAt'<>'null'::jsonb
   AND sync_host.product_time(normalized->'source'->>'updatedAt')>least(job.until AT TIME ZONE 'UTC',sync_host.product_time(page->>'observedAt')) THEN
   reason:='SOURCE_TIME_OUTSIDE_WINDOW'; END IF;
 EXCEPTION WHEN check_violation THEN
  IF SQLERRM NOT IN ('INVALID_RECORD','INVALID_PRODUCT','INVALID_SOURCE_TIME','SOURCE_TIME_STORAGE_RANGE') THEN RAISE; END IF;
  reason:=CASE WHEN SQLERRM='INVALID_PRODUCT' THEN 'INVALID_RECORD' ELSE SQLERRM END;
 WHEN invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN reason:='INVALID_RECORD';
 END;
 RETURN jsonb_build_object('record',normalized,'reason',reason,'recordKey',
  CASE WHEN reason IS NULL THEN sync_host.canonical_identity(normalized,job.stream) END,
  'candidateHash',encode(sha256(convert_to(item::text,'UTF8')),'hex'));
END $$;

CREATE FUNCTION sync_host.canonical_decisions(page JSONB, job sync_host."Job", scope commerce."SourceScope") RETURNS JSONB
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE item JSONB; candidate JSONB; normalized JSONB; evidence JSONB; incoming JSONB; decision TEXT;
 reason TEXT; payload_hash TEXT; effects JSONB; result JSONB:='[]'; ordinal INTEGER:=0;
BEGIN
 FOR item IN SELECT * FROM jsonb_array_elements(page->'items') LOOP
  candidate:=sync_host.canonical_candidate(item,job,scope,page);
  normalized:=candidate->'record'; reason:=candidate->>'reason'; decision:='QUARANTINED'; effects:='{}'; evidence:=NULL;
  IF reason IS NULL THEN
   evidence:=sync_host.canonical_previous(normalized,job.stream,scope.id);
   payload_hash:=sync_host.canonical_payload_hash(normalized,job.stream);
   incoming:=(normalized->'source')-'quality'||jsonb_build_object('payloadHash',payload_hash);
   decision:=sync_host.product_source_order(evidence,incoming);
   IF decision='CONFLICT' THEN decision:='QUARANTINED'; reason:='SOURCE_CONFLICT'; END IF;
   IF decision='APPLY' THEN effects:=sync_host.canonical_apply(normalized,job.stream,scope,payload_hash); END IF;
  END IF;
  result:=result||jsonb_build_array(candidate-'record'||jsonb_build_object('ordinal',ordinal,'decision',decision,
   'reason',reason,'previous',evidence)||effects);
  ordinal:=ordinal+1;
 END LOOP;
 RETURN result;
END $$;


CREATE FUNCTION sync_host.canonical_counts(decisions JSONB) RETURNS JSONB LANGUAGE SQL SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('inputCount',count(*),'appliedCount',count(*) FILTER (WHERE item->>'decision'='APPLY'),
  'duplicateCount',count(*) FILTER (WHERE item->>'decision'='DUPLICATE'),'staleCount',count(*) FILTER (WHERE item->>'decision'='STALE'),
  'quarantinedCount',count(*) FILTER (WHERE item->>'decision'='QUARANTINED'),
  'lineInsertedCount',coalesce(sum((item->>'lineInsertedCount')::integer),0),'lineDeletedCount',coalesce(sum((item->>'lineDeletedCount')::integer),0))
 FROM jsonb_array_elements(decisions) item
$$;

CREATE FUNCTION sync_host.canonical_save_commit(job sync_host."Job", scope_id UUID, page_id TEXT, page JSONB,
 page_hash TEXT, decisions JSONB) RETURNS sync_host."CanonicalPageCommit"
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE totals JSONB:=sync_host.canonical_counts(decisions); receipt sync_host."CanonicalPageCommit"; changed INTEGER;
BEGIN
 INSERT INTO sync_host."CanonicalPageCommit" ("jobId","pageId","scopeId","organizationId","workspaceId","storeId","pageHash","observedAt","sourceWatermark",terminal,"acceptedFence",
  "inputCount","appliedCount","duplicateCount","staleCount","quarantinedCount","lineInsertedCount","lineDeletedCount")
 VALUES (job.id,page_id,scope_id,job."organizationId",job."workspaceId",job."storeId",page_hash,sync_host.product_time(page->>'observedAt'),
  CASE WHEN page->'sourceWatermark'<>'null'::jsonb THEN sync_host.product_time(page->>'sourceWatermark') END,page->'nextCursor'='null'::jsonb,job.fence,
  (totals->>'inputCount')::integer,(totals->>'appliedCount')::integer,(totals->>'duplicateCount')::integer,(totals->>'staleCount')::integer,
  (totals->>'quarantinedCount')::integer,(totals->>'lineInsertedCount')::integer,(totals->>'lineDeletedCount')::integer) RETURNING * INTO receipt;
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>1 THEN RAISE EXCEPTION 'CANONICAL_RECEIPT_WRITE_COUNT_MISMATCH' USING ERRCODE='23514'; END IF;
 INSERT INTO sync_host."CanonicalPageDecision" ("jobId","pageId",ordinal,"organizationId","workspaceId","storeId","recordKey","candidateHash",decision,"previousVersion","previousUpdatedAt","previousPayloadHash")
 SELECT job.id,page_id,(item->>'ordinal')::integer,job."organizationId",job."workspaceId",job."storeId",NULLIF(item->'recordKey','null'::jsonb),item->>'candidateHash',item->>'decision',
  item->'previous'->>'version',CASE WHEN item->'previous'->>'updatedAt' IS NOT NULL THEN sync_host.product_time(item->'previous'->>'updatedAt') END,item->'previous'->>'payloadHash'
 FROM jsonb_array_elements(decisions) item;
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>jsonb_array_length(decisions) THEN RAISE EXCEPTION 'CANONICAL_RECEIPT_WRITE_COUNT_MISMATCH' USING ERRCODE='23514'; END IF;
 INSERT INTO sync_host."CanonicalQuarantine" ("jobId","pageId",ordinal,"organizationId","workspaceId","storeId",reason)
 SELECT job.id,page_id,(item->>'ordinal')::integer,job."organizationId",job."workspaceId",job."storeId",item->>'reason'
 FROM jsonb_array_elements(decisions) item WHERE item->>'decision'='QUARANTINED';
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>(totals->>'quarantinedCount')::integer THEN RAISE EXCEPTION 'CANONICAL_RECEIPT_WRITE_COUNT_MISMATCH' USING ERRCODE='23514'; END IF;
 RETURN receipt;
END $$;

CREATE FUNCTION sync_host.canonical_commit_result(receipt sync_host."CanonicalPageCommit", status TEXT) RETURNS JSONB
LANGUAGE SQL SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('status',status,'inputCount',receipt."inputCount",'appliedCount',receipt."appliedCount",
  'duplicateCount',receipt."duplicateCount",'staleCount',receipt."staleCount",'quarantinedCount',receipt."quarantinedCount",
  'lineInsertedCount',receipt."lineInsertedCount",'lineDeletedCount',receipt."lineDeletedCount")
$$;

CREATE FUNCTION sync_host.commit_canonical_page(job_id TEXT, expected_fence INTEGER, page_id TEXT, expected_cursor TEXT, page JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job sync_host."Job"; scope commerce."SourceScope"; receipt sync_host."CanonicalPageCommit";
 page_hash TEXT; decisions JSONB; staged_through TIMESTAMP; staged_job sync_host."Job";
BEGIN
 job:=sync_host.canonical_open_job(job_id,expected_fence);
 IF page_id IS NULL OR page_id !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$' THEN RAISE EXCEPTION 'INVALID_PAGE' USING ERRCODE='23514'; END IF;
 PERFORM sync_host.product_string(coalesce(to_jsonb(expected_cursor),'null'::jsonb),1024,false,true);
 PERFORM sync_host.canonical_page_input(page,job);
 page_hash:=sync_host.canonical_page_hash(to_jsonb(job),expected_cursor,page);
 SELECT * INTO receipt FROM sync_host."CanonicalPageCommit" c WHERE c."jobId"=job_id AND c."pageId"=page_id;
 IF FOUND THEN
  IF receipt."pageHash"<>page_hash THEN RAISE EXCEPTION 'Conflicting canonical page' USING ERRCODE='23505'; END IF;
  PERFORM sync_host.require_page_lease(job,expected_fence);
  RETURN sync_host.canonical_commit_result(receipt,'REPLAYED');
 END IF;
 IF job."receiptCursor" #>> '{}' IS DISTINCT FROM expected_cursor THEN RAISE EXCEPTION 'Non-contiguous canonical page' USING ERRCODE='23514'; END IF;
 IF EXISTS (SELECT 1 FROM sync_host."PageReceipt" r WHERE r."jobId"=job_id AND NOT EXISTS
  (SELECT 1 FROM sync_host."CanonicalPageCommit" c WHERE c."jobId"=r."jobId" AND c."pageId"=r."pageId")) THEN
  RAISE EXCEPTION 'UNCOMMITTED_CANONICAL_RECEIPT' USING ERRCODE='23514'; END IF;
 scope:=sync_host.product_scope(job);
 decisions:=sync_host.canonical_decisions(page,job,scope);
 -- requested boundary staging is not SDK completion proof or actual source watermark.
 staged_through:=CASE WHEN page->'nextCursor'='null'::jsonb THEN job.until ELSE coalesce(job."receivedThrough",job.since) END;
 PERFORM sync_host.stage_page(job_id,expected_fence,page_id,expected_cursor,page->>'nextCursor',staged_through,page_hash);
 SELECT * INTO staged_job FROM sync_host."Job" WHERE id=job_id;
 IF (staged_job."receiptCursor" #>> '{}',staged_job."receivedThrough") IS DISTINCT FROM (page->>'nextCursor',staged_through)
  OR NOT EXISTS (SELECT 1 FROM sync_host."PageReceipt" r WHERE r."jobId"=job_id AND r."pageId"=page_id
   AND (r."expectedCursor",r."nextCursor",r."receivedThrough",r."pageHash") IS NOT DISTINCT FROM (expected_cursor,page->>'nextCursor',staged_through,page_hash)) THEN
  RAISE EXCEPTION 'CANONICAL_STAGE_MISMATCH' USING ERRCODE='23514'; END IF;
 receipt:=sync_host.canonical_save_commit(job,scope.id,page_id,page,page_hash,decisions);
 PERFORM sync_host.require_page_lease(job,expected_fence);
 RETURN sync_host.canonical_commit_result(receipt,'APPLIED');
END $$;


CREATE FUNCTION sync_host.guard_canonical_commit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job sync_host."Job"; counts JSONB;
BEGIN
 SELECT * INTO job FROM sync_host."Job" WHERE id=NEW."jobId";
 PERFORM sync_host.require_page_lease(job,NEW."acceptedFence");
 SELECT sync_host.canonical_counts(coalesce(jsonb_agg(jsonb_build_object('decision',decision)),'[]'::jsonb)) INTO counts
 FROM sync_host."CanonicalPageDecision" WHERE "jobId"=NEW."jobId" AND "pageId"=NEW."pageId";
 IF ((counts->>'inputCount')::integer,(counts->>'appliedCount')::integer,(counts->>'duplicateCount')::integer,(counts->>'staleCount')::integer,(counts->>'quarantinedCount')::integer)
  IS DISTINCT FROM (NEW."inputCount",NEW."appliedCount",NEW."duplicateCount",NEW."staleCount",NEW."quarantinedCount")
  OR (SELECT count(*) FROM sync_host."CanonicalQuarantine" WHERE "jobId"=NEW."jobId" AND "pageId"=NEW."pageId")<>NEW."quarantinedCount" THEN
  RAISE EXCEPTION 'CANONICAL_RECEIPT_COUNT_MISMATCH' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER guard_canonical_commit AFTER INSERT ON sync_host."CanonicalPageCommit"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sync_host.guard_canonical_commit();
CREATE FUNCTION sync_host.immutable_canonical_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Immutable canonical receipt' USING ERRCODE='23514'; END $$;
CREATE TRIGGER immutable_canonical_commit BEFORE UPDATE OR DELETE ON sync_host."CanonicalPageCommit" FOR EACH ROW EXECUTE FUNCTION sync_host.immutable_canonical_receipt();
CREATE TRIGGER immutable_canonical_decision BEFORE UPDATE OR DELETE ON sync_host."CanonicalPageDecision" FOR EACH ROW EXECUTE FUNCTION sync_host.immutable_canonical_receipt();
CREATE TRIGGER immutable_canonical_quarantine BEFORE UPDATE OR DELETE ON sync_host."CanonicalQuarantine" FOR EACH ROW EXECUTE FUNCTION sync_host.immutable_canonical_receipt();

REVOKE ALL ON FUNCTION sync_host.canonical_open_job(TEXT,INTEGER),sync_host.canonical_page_input(JSONB,sync_host."Job"),
 sync_host.canonical_page_hash(JSONB,TEXT,JSONB),sync_host.canonical_identity(JSONB,TEXT),
 sync_host.canonical_previous(JSONB,TEXT,UUID),sync_host.canonical_write(REGCLASS,JSONB,TEXT[]),
 sync_host.canonical_apply(JSONB,TEXT,commerce."SourceScope",TEXT),
 sync_host.canonical_candidate(JSONB,sync_host."Job",commerce."SourceScope",JSONB),
 sync_host.canonical_decisions(JSONB,sync_host."Job",commerce."SourceScope"),sync_host.canonical_counts(JSONB),
 sync_host.canonical_save_commit(sync_host."Job",UUID,TEXT,JSONB,TEXT,JSONB),
 sync_host.canonical_commit_result(sync_host."CanonicalPageCommit",TEXT),sync_host.commit_canonical_page(TEXT,INTEGER,TEXT,TEXT,JSONB),
 sync_host.guard_canonical_commit(),sync_host.immutable_canonical_receipt() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sync_host.commit_canonical_page(TEXT,INTEGER,TEXT,TEXT,JSONB) TO shopmate_sync_worker;
COMMIT;

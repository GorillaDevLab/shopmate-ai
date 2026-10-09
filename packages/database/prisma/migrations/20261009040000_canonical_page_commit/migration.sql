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
COMMIT;

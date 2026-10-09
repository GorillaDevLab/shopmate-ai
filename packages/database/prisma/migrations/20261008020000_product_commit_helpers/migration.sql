BEGIN;
-- Pure internal boundaries: this migration opens no ingestion or reader privilege.
CREATE FUNCTION sync_host.product_object(value JSONB, keys TEXT[]) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN jsonb_typeof(value) IS DISTINCT FROM 'object' THEN false
 ELSE value-keys='{}'::jsonb AND value ?& keys END
$$;

CREATE FUNCTION sync_host.product_string(value JSONB, maximum INTEGER, normalized BOOLEAN,
 nullable BOOLEAN DEFAULT false) RETURNS JSONB LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE result TEXT;
BEGIN
 IF nullable AND value='null'::jsonb THEN RETURN value; END IF;
 IF jsonb_typeof(value) IS DISTINCT FROM 'string' THEN
  RAISE EXCEPTION 'INVALID_PRODUCT' USING ERRCODE='23514'; END IF;
 result:=value #>> '{}';
 IF normalized THEN
  result:=normalize(btrim(regexp_replace(result,E'\r\n?',E'\n','g'),
   U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'),NFC);
 END IF;
 IF NOT commerce.valid_string(result,maximum,normalized) THEN
  RAISE EXCEPTION 'INVALID_PRODUCT' USING ERRCODE='23514'; END IF;
 RETURN to_jsonb(result);
END $$;

CREATE FUNCTION sync_host.product_time(value TEXT) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE local_part TEXT; offset_part TEXT; local_time TIMESTAMP; minutes INTEGER:=0;
 y INTEGER; m INTEGER; d INTEGER; days INTEGER;
BEGIN
 IF value IS NULL OR value !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' THEN
  RAISE EXCEPTION 'INVALID_SOURCE_TIME' USING ERRCODE='23514'; END IF;
 y:=substr(value,1,4)::integer; m:=substr(value,6,2)::integer; d:=substr(value,9,2)::integer;
 days:=CASE WHEN m=2 THEN CASE WHEN y%4=0 AND (y%100<>0 OR y%400=0) THEN 29 ELSE 28 END
  WHEN m IN (4,6,9,11) THEN 30 ELSE 31 END;
 IF d>days THEN RAISE EXCEPTION 'INVALID_SOURCE_TIME' USING ERRCODE='23514'; END IF;
 offset_part:=substring(value FROM '(Z|[+-][0-9]{2}:[0-9]{2})$');
 local_part:=left(value,length(value)-length(offset_part));
 -- PostgreSQL's microsecond parser can round .00099999 into .001; truncate text first.
 local_part:=regexp_replace(local_part,'(\.[0-9]{3})[0-9]+','\1');
 IF y=0 THEN local_part:='0001'||substr(local_part,5)||' BC'; END IF;
 local_time:=local_part::timestamp;
 IF offset_part<>'Z' THEN
  minutes:=(substr(offset_part,2,2)::integer*60+substr(offset_part,5,2)::integer)
   *CASE WHEN left(offset_part,1)='-' THEN -1 ELSE 1 END;
 END IF;
 RETURN (local_time AT TIME ZONE 'UTC')-make_interval(mins=>minutes);
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
 RAISE EXCEPTION 'INVALID_SOURCE_TIME' USING ERRCODE='23514';
END $$;

CREATE FUNCTION sync_host.product_minor(value JSONB, nullable BOOLEAN DEFAULT false) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE amount NUMERIC;
BEGIN
 IF nullable AND value='null'::jsonb THEN RETURN value; END IF;
 IF jsonb_typeof(value) IS DISTINCT FROM 'number' THEN
  RAISE EXCEPTION 'INVALID_PRODUCT' USING ERRCODE='23514'; END IF;
 amount:=(value #>> '{}')::numeric;
 IF amount<0 OR amount>9007199254740991 OR trunc(amount)<>amount THEN
  RAISE EXCEPTION 'INVALID_PRODUCT' USING ERRCODE='23514'; END IF;
 -- JSON numeric scale is not a commerce fact; 100 and 100.000 are the same amount.
 RETURN to_jsonb(amount::bigint);
END $$;

CREATE FUNCTION sync_host.product_attributes(value JSONB) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE attribute JSONB; result JSONB:='[]'; names TEXT[]:=ARRAY[]::text[]; name JSONB;
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'INVALID_PRODUCT' USING ERRCODE='23514'; END IF;
 IF jsonb_array_length(value)>30 THEN RAISE EXCEPTION 'INVALID_PRODUCT' USING ERRCODE='23514'; END IF;
 FOR attribute IN SELECT * FROM jsonb_array_elements(value) LOOP
  IF NOT sync_host.product_object(attribute,ARRAY['name','value']) THEN
   RAISE EXCEPTION 'INVALID_PRODUCT' USING ERRCODE='23514'; END IF;
  name:=sync_host.product_string(attribute->'name',100,true);
  IF name #>> '{}' =ANY(names) THEN RAISE EXCEPTION 'INVALID_PRODUCT' USING ERRCODE='23514'; END IF;
  names:=array_append(names,name #>> '{}');
  result:=result||jsonb_build_array(jsonb_build_object('name',name,
   'value',sync_host.product_string(attribute->'value',200,true)));
 END LOOP;
 RETURN result;
END $$;

CREATE FUNCTION sync_host.product_source(value JSONB) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE quality JSONB; issues TEXT[]; at TIMESTAMPTZ; updated JSONB:='null';
BEGIN
 IF NOT sync_host.product_object(value,ARRAY['version','updatedAt','quality']) THEN
  RAISE EXCEPTION 'INVALID_PRODUCT' USING ERRCODE='23514'; END IF;
 quality:=value->'quality';
 IF NOT sync_host.product_object(quality,ARRAY['state','issues'])
  OR jsonb_typeof(quality->'state') IS DISTINCT FROM 'string'
  OR jsonb_typeof(quality->'issues') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'INVALID_PRODUCT' USING ERRCODE='23514'; END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(quality->'issues') issue WHERE jsonb_typeof(issue)<>'string') THEN
  RAISE EXCEPTION 'INVALID_PRODUCT' USING ERRCODE='23514'; END IF;
 SELECT coalesce(array_agg(issue #>> '{}'),ARRAY[]::text[]) INTO issues FROM jsonb_array_elements(quality->'issues') issue;
 IF NOT commerce.valid_quality(quality->>'state',issues)
  OR (value->'updatedAt'='null'::jsonb AND NOT 'SOURCE_TIME_MISSING'=ANY(issues)) THEN
  RAISE EXCEPTION 'INVALID_PRODUCT' USING ERRCODE='23514'; END IF;
 IF value->'updatedAt'<>'null'::jsonb THEN
  IF jsonb_typeof(value->'updatedAt')<>'string' THEN RAISE EXCEPTION 'INVALID_PRODUCT' USING ERRCODE='23514'; END IF;
  at:=sync_host.product_time(value->>'updatedAt');
  IF at<timestamptz '0001-01-01 00:00:00Z' OR at>timestamptz '9999-12-31 23:59:59.999Z' THEN
   RAISE EXCEPTION 'SOURCE_TIME_STORAGE_RANGE' USING ERRCODE='23514'; END IF;
  updated:=to_jsonb(to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 END IF;
 RETURN jsonb_build_object('version',sync_host.product_string(value->'version',256,false,true),
  'updatedAt',updated,'quality',quality);
END $$;

CREATE FUNCTION sync_host.product_sku(value JSONB, product_id TEXT) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 IF NOT sync_host.product_object(value,ARRAY['externalSkuId','externalProductId','attributes','salePriceMinor','costPriceMinor','originalPriceMinor','status'])
  OR jsonb_typeof(value->'status') IS DISTINCT FROM 'string'
  OR value->>'status' NOT IN ('ACTIVE','INACTIVE')
  OR value->>'externalProductId' IS DISTINCT FROM product_id THEN
  RAISE EXCEPTION 'INVALID_PRODUCT' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('externalSkuId',sync_host.product_string(value->'externalSkuId',256,false),
  'externalProductId',sync_host.product_string(value->'externalProductId',256,false),
  'attributes',sync_host.product_attributes(value->'attributes'),
  'salePriceMinor',sync_host.product_minor(value->'salePriceMinor'),
  'costPriceMinor',sync_host.product_minor(value->'costPriceMinor',true),
  'originalPriceMinor',sync_host.product_minor(value->'originalPriceMinor',true),'status',value->'status');
END $$;

CREATE FUNCTION sync_host.normalize_product(value JSONB, external_store_id TEXT) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE source JSONB; skus JSONB:='[]'; sku JSONB; ids TEXT[]:=ARRAY[]::text[];
BEGIN
 IF NOT sync_host.product_object(value,ARRAY['externalStoreId','externalProductId','title','description','category','brand','status','source','skus'])
  OR value->>'externalStoreId' IS DISTINCT FROM external_store_id
  OR jsonb_typeof(value->'status') IS DISTINCT FROM 'string'
  OR value->>'status' NOT IN ('DRAFT','ACTIVE','INACTIVE','DELETED')
  OR jsonb_typeof(value->'skus') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'INVALID_PRODUCT' USING ERRCODE='23514'; END IF;
 IF jsonb_array_length(value->'skus') NOT BETWEEN 1 AND 500 THEN
  RAISE EXCEPTION 'INVALID_PRODUCT' USING ERRCODE='23514'; END IF;
 source:=sync_host.product_source(value->'source');
 FOR sku IN SELECT * FROM jsonb_array_elements(value->'skus') LOOP
  sku:=sync_host.product_sku(sku,value->>'externalProductId');
  IF sku->>'externalSkuId'=ANY(ids)
   OR (sku->'costPriceMinor'='null'::jsonb AND NOT source->'quality'->'issues' ? 'COST_MISSING') THEN
   RAISE EXCEPTION 'INVALID_PRODUCT' USING ERRCODE='23514'; END IF;
  ids:=array_append(ids,sku->>'externalSkuId'); skus:=skus||jsonb_build_array(sku);
 END LOOP;
 IF value->'category'='null'::jsonb AND NOT source->'quality'->'issues' ? 'CATEGORY_MISSING' THEN
  RAISE EXCEPTION 'INVALID_PRODUCT' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('externalStoreId',sync_host.product_string(value->'externalStoreId',256,false),
  'externalProductId',sync_host.product_string(value->'externalProductId',256,false),
  'title',sync_host.product_string(value->'title',200,true),
  'description',sync_host.product_string(value->'description',5000,true,true),
  'category',sync_host.product_string(value->'category',200,true,true),
  'brand',sync_host.product_string(value->'brand',200,true,true),
  'status',value->'status','source',source,'skus',skus);
END $$;

CREATE FUNCTION sync_host.product_payload_hash(value JSONB) RETURNS TEXT
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to((value-ARRAY['source','skus']||jsonb_build_object(
  'quality',jsonb_set(value->'source'->'quality','{issues}',
   (SELECT coalesce(jsonb_agg(issue ORDER BY issue #>> '{}' COLLATE "C"),'[]'::jsonb)
    FROM jsonb_array_elements(value->'source'->'quality'->'issues') issue)),
  'skus',(SELECT jsonb_agg(jsonb_set(sku,'{attributes}',
    (SELECT coalesce(jsonb_agg(attribute ORDER BY attribute->>'name' COLLATE "C"),'[]'::jsonb)
     FROM jsonb_array_elements(sku->'attributes') attribute)) ORDER BY sku->>'externalSkuId' COLLATE "C")
   FROM jsonb_array_elements(value->'skus') sku)))::text,'UTF8')),'hex')
$$;

CREATE FUNCTION sync_host.product_order_input(value JSONB) RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 IF NOT sync_host.product_object(value,ARRAY['version','updatedAt','payloadHash'])
  OR jsonb_typeof(value->'payloadHash') IS DISTINCT FROM 'string'
  OR value->>'payloadHash' !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'INVALID_SOURCE_ORDER' USING ERRCODE='23514'; END IF;
 PERFORM sync_host.product_string(value->'version',256,false,true);
 IF value->'updatedAt'<>'null'::jsonb THEN
  IF jsonb_typeof(value->'updatedAt')<>'string' THEN RAISE EXCEPTION 'INVALID_SOURCE_ORDER' USING ERRCODE='23514'; END IF;
  PERFORM sync_host.product_time(value->>'updatedAt');
 END IF;
END $$;

CREATE FUNCTION sync_host.product_source_order(previous JSONB, incoming JSONB) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE before_time TIMESTAMPTZ; after_time TIMESTAMPTZ;
BEGIN
 PERFORM sync_host.product_order_input(incoming);
 IF previous IS NULL OR previous='null'::jsonb THEN RETURN 'APPLY'; END IF;
 PERFORM sync_host.product_order_input(previous);
 IF previous->'updatedAt'<>'null'::jsonb AND incoming->'updatedAt'<>'null'::jsonb THEN
  before_time:=sync_host.product_time(previous->>'updatedAt'); after_time:=sync_host.product_time(incoming->>'updatedAt');
  IF after_time>before_time THEN RETURN 'APPLY'; END IF;
  IF after_time<before_time THEN RETURN 'STALE'; END IF;
 ELSIF previous->'updatedAt' IS DISTINCT FROM incoming->'updatedAt' THEN RETURN 'CONFLICT';
 END IF;
 IF (previous->'version',previous->'payloadHash') IS NOT DISTINCT FROM (incoming->'version',incoming->'payloadHash') THEN
  RETURN 'DUPLICATE'; END IF;
 RETURN 'CONFLICT';
END $$;

CREATE FUNCTION sync_host.product_page_input(value JSONB, external_store_id TEXT, requested_until TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE item JSONB; sku_count INTEGER:=0; observed TIMESTAMPTZ; watermark TIMESTAMPTZ;
BEGIN
 -- These RPC admission limits reject whole pages; they do not redefine ConnectorPage.
 IF octet_length(value::text)>16777216 THEN
  RAISE EXCEPTION 'PAGE_TOO_LARGE' USING ERRCODE='23514'; END IF;
 IF NOT sync_host.product_object(value,ARRAY['items','nextCursor','observedAt','sourceWatermark'])
  OR jsonb_typeof(value->'items') IS DISTINCT FROM 'array'
  OR jsonb_typeof(value->'observedAt') IS DISTINCT FROM 'string'
  OR requested_until IS NULL THEN RAISE EXCEPTION 'INVALID_PAGE' USING ERRCODE='23514'; END IF;
 IF jsonb_array_length(value->'items')>200 THEN RAISE EXCEPTION 'INVALID_PAGE' USING ERRCODE='23514'; END IF;
 PERFORM sync_host.product_string(value->'nextCursor',1024,false,true);
 observed:=sync_host.product_time(value->>'observedAt');
 IF value->'sourceWatermark'<>'null'::jsonb THEN
  IF jsonb_typeof(value->'sourceWatermark')<>'string' THEN RAISE EXCEPTION 'INVALID_PAGE' USING ERRCODE='23514'; END IF;
  watermark:=sync_host.product_time(value->>'sourceWatermark');
  IF watermark>least(requested_until,observed) THEN RAISE EXCEPTION 'INVALID_PAGE' USING ERRCODE='23514'; END IF;
 END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(value->'items') LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object'
   OR jsonb_typeof(item->'externalStoreId') IS DISTINCT FROM 'string'
   OR item->>'externalStoreId' IS DISTINCT FROM external_store_id THEN
   RAISE EXCEPTION 'SOURCE_SCOPE_MISMATCH' USING ERRCODE='23514'; END IF;
  IF jsonb_typeof(item->'skus')='array' THEN sku_count:=sku_count+jsonb_array_length(item->'skus'); END IF;
  IF sku_count>5000 THEN RAISE EXCEPTION 'PAGE_TOO_LARGE' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN value;
END $$;

CREATE FUNCTION sync_host.product_page_hash(job JSONB, expected_cursor TEXT, page JSONB) RETURNS TEXT
LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object('codec','product-page-v1',
  'job',(SELECT jsonb_object_agg(key,job->key) FROM unnest(ARRAY['id','organizationId','workspaceId',
   'storeId','connectionId','externalStoreId','provider','generation','since','until']) key),
  'expectedCursor',expected_cursor,'page',page)::text,'UTF8')),'hex')
$$;

REVOKE ALL ON FUNCTION sync_host.product_page_input(JSONB,TEXT,TIMESTAMPTZ), sync_host.product_page_hash(JSONB,TEXT,JSONB),
 sync_host.product_object(JSONB,TEXT[]),
 sync_host.product_string(JSONB,INTEGER,BOOLEAN,BOOLEAN), sync_host.product_time(TEXT),
 sync_host.product_minor(JSONB,BOOLEAN), sync_host.product_attributes(JSONB), sync_host.product_source(JSONB),
 sync_host.product_sku(JSONB,TEXT), sync_host.normalize_product(JSONB,TEXT),
 sync_host.product_payload_hash(JSONB), sync_host.product_order_input(JSONB), sync_host.product_source_order(JSONB,JSONB) FROM PUBLIC;
COMMIT;

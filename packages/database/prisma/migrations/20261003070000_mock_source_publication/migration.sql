BEGIN;
-- Pure invoker codec primitives. Later guards must derive scope/envelopes themselves;
-- accepting a caller hash never proves authorization or physical completeness.
CREATE FUNCTION mock_platform.integrity(valid BOOLEAN) RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF valid IS NOT TRUE THEN
    RAISE EXCEPTION 'Invalid source integrity' USING ERRCODE='SM005';
  END IF;
END $$;
CREATE FUNCTION mock_platform.hash_jsonb(value JSONB) RETURNS TEXT
LANGUAGE SQL IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT encode(sha256(convert_to(value::text,'UTF8')),'hex')
$$;
CREATE FUNCTION mock_platform.valid_uint(value TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF value IS NULL OR value !~ '^(0|[1-9][0-9]{0,18})$' THEN RETURN false; END IF;
  RETURN value::numeric<=9223372036854775807;
END $$;
CREATE FUNCTION mock_platform.source_uint(value TEXT) RETURNS BIGINT
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM mock_platform.integrity(mock_platform.valid_uint(value));
  RETURN value::bigint;
END $$;
CREATE FUNCTION mock_platform.increment_uint(value TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE number BIGINT;
BEGIN
  number:=mock_platform.source_uint(value);
  PERFORM mock_platform.integrity(number<9223372036854775807);
  RETURN (number+1)::text;
END $$;
CREATE FUNCTION mock_platform.valid_utc(value TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE parsed TIMESTAMP;
BEGIN
  IF value IS NULL OR value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    OR left(value,4)='0000' THEN RETURN false; END IF;
  parsed:=value::timestamp;
  RETURN isfinite(parsed) AND to_char(parsed,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=value;
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RETURN false;
END $$;
CREATE FUNCTION mock_platform.valid_date(value TEXT) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT coalesce(value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    AND mock_platform.valid_utc(value||'T00:00:00.000Z'),false)
$$;
CREATE FUNCTION mock_platform.canonical_utc(value TIMESTAMP) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE result TEXT;
BEGIN
  result:=to_char(value,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  PERFORM mock_platform.integrity(mock_platform.valid_utc(result)
    AND value=result::timestamp);
  RETURN result;
END $$;
CREATE FUNCTION mock_platform.canonical_utc(value TIMESTAMPTZ) RETURNS TEXT
LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT mock_platform.canonical_utc(timezone('UTC',value))
$$;
CREATE FUNCTION mock_platform.normalized_boundary(value TEXT) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT value<>'' AND value=btrim(value,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
$$;
CREATE FUNCTION mock_platform.valid_external_id(value TEXT,store_namespace BOOLEAN) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT coalesce(mock_platform.normalized_boundary(value)
    AND value !~ U&'[\0001-\001F\007F-\009F\200B-\200F\202A-\202E\2066-\2069]'
    AND CASE WHEN store_namespace THEN
      (SELECT coalesce(sum(CASE WHEN ascii(ch)>65535 THEN 2 ELSE 1 END),0)
        FROM regexp_split_to_table(value,'') ch)<=200
      ELSE octet_length(value)<=200 END,false)
$$;
CREATE FUNCTION mock_platform.valid_text(value TEXT,max_bytes INTEGER) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT coalesce(mock_platform.normalized_boundary(value) AND octet_length(value)<=max_bytes
    AND value=normalize(value,NFC)
    AND value !~ U&'[\0001-\0008\000B-\001F\007F-\009F\200B-\200F\202A-\202E\2066-\2069]',false)
$$;
CREATE FUNCTION mock_platform.valid_amount(value JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE number NUMERIC;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
  number:=value::numeric;
  RETURN number>=0 AND number<=9007199254740991 AND number=trunc(number);
END $$;
CREATE FUNCTION mock_platform.require_fields(value JSONB,keys TEXT[]) RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM mock_platform.integrity(jsonb_typeof(value)='object');
  PERFORM mock_platform.integrity(value ?& keys
    AND (SELECT count(*) FROM jsonb_object_keys(value))=cardinality(keys));
END $$;
CREATE FUNCTION mock_platform.require_data_bounds(value JSONB,max_bytes INTEGER,max_nodes INTEGER DEFAULT 20000,max_depth INTEGER DEFAULT 12) RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE values_stack JSONB[]; depth_stack INTEGER[]; node JSONB; depth INTEGER;
  nodes INTEGER:=0; size INTEGER; child JSONB;
BEGIN
  PERFORM mock_platform.integrity(value IS NOT NULL AND max_bytes BETWEEN 1 AND 2097152
    AND max_nodes BETWEEN 1 AND 2001000 AND max_depth BETWEEN 0 AND 15
    AND octet_length(value::text)<=max_bytes);
  values_stack:=ARRAY[value]; depth_stack:=ARRAY[0];
  WHILE cardinality(values_stack)>0 LOOP
    size:=cardinality(values_stack); node:=values_stack[size]; depth:=depth_stack[size];
    values_stack:=values_stack[1:size-1]; depth_stack:=depth_stack[1:size-1]; nodes:=nodes+1;
    PERFORM mock_platform.integrity(nodes<=max_nodes AND depth<=max_depth);
    IF jsonb_typeof(node)='number' THEN
      PERFORM mock_platform.integrity(abs(node::numeric)<=9007199254740991 AND node::numeric=trunc(node::numeric));
    ELSIF jsonb_typeof(node)='array' THEN
      PERFORM mock_platform.integrity(jsonb_array_length(node)<=500);
      FOR child IN SELECT jsonb_array_elements(node) LOOP
        values_stack:=array_append(values_stack,child); depth_stack:=array_append(depth_stack,depth+1);
      END LOOP;
    ELSIF jsonb_typeof(node)='object' THEN
      FOR child IN SELECT v FROM jsonb_each(node) AS e(k,v) LOOP
        values_stack:=array_append(values_stack,child); depth_stack:=array_append(depth_stack,depth+1);
      END LOOP;
    END IF;
  END LOOP;
END $$;
CREATE FUNCTION mock_platform.require_list(value JSONB,min_items INTEGER,max_items INTEGER) RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM mock_platform.integrity(jsonb_typeof(value)='array');
  PERFORM mock_platform.integrity(jsonb_array_length(value) BETWEEN min_items AND max_items);
END $$;
CREATE FUNCTION mock_platform.require_rules(value JSONB,rules JSONB) RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE field TEXT; rule TEXT; item JSONB; scalar TEXT; valid BOOLEAN;
BEGIN
  PERFORM mock_platform.require_fields(value,ARRAY(SELECT jsonb_object_keys(rules)));
  FOR field,rule IN SELECT k,v FROM jsonb_each_text(rules) AS r(k,v) LOOP
    item:=value->field;
    IF right(rule,1)='?' AND item='null'::jsonb THEN CONTINUE; END IF;
    rule:=rtrim(rule,'?'); scalar:=item#>>'{}';
    valid:=CASE
      WHEN rule='amount' THEN mock_platform.valid_amount(item)
      WHEN rule='positive' THEN mock_platform.valid_amount(item) AND item::numeric>0
      WHEN rule='lead' THEN mock_platform.valid_amount(item) AND item::numeric<=365
      WHEN rule='object' THEN jsonb_typeof(item)='object'
      WHEN rule='array' THEN jsonb_typeof(item)='array'
      WHEN jsonb_typeof(item) IS DISTINCT FROM 'string' THEN false
      WHEN rule='id' THEN mock_platform.valid_external_id(scalar,false)
      WHEN rule='store' THEN mock_platform.valid_external_id(scalar,true)
      WHEN rule='utc' THEN mock_platform.valid_utc(scalar)
      WHEN rule='date' THEN mock_platform.valid_date(scalar)
      WHEN left(rule,5)='text:' THEN mock_platform.valid_text(scalar,split_part(rule,':',2)::integer)
      WHEN left(rule,5)='enum:' THEN scalar=ANY(string_to_array(substr(rule,6),'|'))
      ELSE false END;
    PERFORM mock_platform.integrity(valid);
  END LOOP;
END $$;
CREATE FUNCTION mock_platform.declares(value JSONB,issue TEXT) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT coalesce(value->'source'->'quality'->>'state'='PARTIAL'
    AND value->'source'->'quality'->'issues' ? issue,false)
$$;
CREATE FUNCTION mock_platform.require_source(value JSONB,occurred_at TEXT) RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE quality JSONB; issues JSONB;
BEGIN
  PERFORM mock_platform.require_fields(value,ARRAY['version','updatedAt','quality']);
  PERFORM mock_platform.integrity(value->'version'='null'::jsonb AND value->'updatedAt'=to_jsonb(occurred_at)
    AND mock_platform.valid_utc(occurred_at));
  quality:=value->'quality';
  PERFORM mock_platform.require_fields(quality,ARRAY['state','issues']);
  issues:=quality->'issues';
  PERFORM mock_platform.require_list(issues,0,9);
  PERFORM mock_platform.integrity(quality->>'state' IN ('COMPLETE','PARTIAL')
    AND (quality->>'state'='COMPLETE')=(jsonb_array_length(issues)=0)
    AND (SELECT count(DISTINCT issue) FROM jsonb_array_elements(issues) issue)=jsonb_array_length(issues)
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(issues) issue WHERE jsonb_typeof(issue)<>'string'
      OR issue#>>'{}' NOT IN ('COST_MISSING','CATEGORY_MISSING','PAYMENT_UNKNOWN','REFUND_UNKNOWN',
      'INVENTORY_UNKNOWN','INVENTORY_STALE','MARKETING_UNKNOWN','SOURCE_TIME_MISSING','SOURCE_INCONSISTENT')));
END $$;
CREATE FUNCTION mock_platform.record_rules(kind TEXT) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE rules JSONB;
BEGIN
  rules:=CASE kind
    WHEN 'STORE' THEN '{"name":"text:200","category":"text:200?","currency":"enum:CNY","timeZone":"enum:Asia/Shanghai"}'::jsonb
    WHEN 'PRODUCT' THEN '{"externalProductId":"id","title":"text:200","description":"text:5000?","category":"text:200?","brand":"text:200?","status":"enum:DRAFT|ACTIVE|INACTIVE|DELETED","skus":"array"}'::jsonb
    WHEN 'ORDER' THEN '{"externalOrderId":"id","status":"enum:PENDING_PAYMENT|PAID|FULFILLED|COMPLETED|CANCELLED|CLOSED","orderedAt":"utc","paidAt":"utc?","currency":"enum:CNY","items":"array","grossMinor":"amount","discountMinor":"amount","shippingMinor":"amount","payableMinor":"amount","paidMinor":"amount?","refundedMinor":"amount?"}'::jsonb
    WHEN 'REFUND' THEN '{"externalRefundId":"id","externalOrderId":"id","externalSkuId":"id?","status":"enum:REQUESTED|APPROVED|PROCESSING|SUCCEEDED|FAILED|REJECTED|CANCELLED","requestedMinor":"amount","succeededMinor":"amount?","requestedAt":"utc","succeededAt":"utc?","currency":"enum:CNY"}'::jsonb
    WHEN 'INVENTORY' THEN '{"externalSkuId":"id","externalLocationId":"id","available":"amount?","reserved":"amount?","onHand":"amount?","safetyStock":"amount?","leadTimeDays":"lead?"}'::jsonb
    WHEN 'MARKETING' THEN '{"externalCampaignId":"id","date":"date","impressions":"amount?","clicks":"amount?","attributedOrders":"amount?","spendMinor":"amount?","attributedRevenueMinor":"amount?","currency":"enum:CNY"}'::jsonb
    ELSE NULL END;
  PERFORM mock_platform.integrity(rules IS NOT NULL);
  RETURN rules||'{"externalStoreId":"store","source":"object"}'::jsonb;
END $$;
CREATE FUNCTION mock_platform.require_attributes(value JSONB) RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE item JSONB;
BEGIN
  PERFORM mock_platform.require_list(value,0,30);
  FOR item IN SELECT jsonb_array_elements(value) LOOP
    PERFORM mock_platform.require_rules(item,'{"name":"text:100","value":"text:200"}');
  END LOOP;
  PERFORM mock_platform.integrity((SELECT count(DISTINCT attr->>'name') FROM jsonb_array_elements(value) attr)=jsonb_array_length(value));
END $$;
CREATE FUNCTION mock_platform.require_product(value JSONB) RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE sku JSONB; skus JSONB:=value->'skus';
BEGIN
  PERFORM mock_platform.require_list(skus,1,500);
  FOR sku IN SELECT jsonb_array_elements(skus) LOOP
    PERFORM mock_platform.require_rules(sku,'{"externalSkuId":"id","externalProductId":"id","attributes":"array","salePriceMinor":"amount","costPriceMinor":"amount?","originalPriceMinor":"amount?","status":"enum:ACTIVE|INACTIVE"}');
    PERFORM mock_platform.require_attributes(sku->'attributes');
    PERFORM mock_platform.integrity(sku->'externalProductId'=value->'externalProductId'
      AND (sku->'costPriceMinor'<>'null'::jsonb OR mock_platform.declares(value,'COST_MISSING')));
  END LOOP;
  PERFORM mock_platform.integrity((SELECT count(DISTINCT item->>'externalSkuId') FROM jsonb_array_elements(skus) item)=jsonb_array_length(skus)
    AND (value->'category'<>'null'::jsonb OR mock_platform.declares(value,'CATEGORY_MISSING')));
END $$;
CREATE FUNCTION mock_platform.require_order_items(value JSONB) RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE item JSONB; gross NUMERIC;
BEGIN
  PERFORM mock_platform.require_list(value,1,500);
  FOR item IN SELECT jsonb_array_elements(value) LOOP
    PERFORM mock_platform.require_rules(item,'{"externalLineId":"id","externalProductId":"id","externalSkuId":"id","quantity":"positive","unitPriceMinor":"amount","grossMinor":"amount","discountMinor":"amount","netMinor":"amount"}');
    gross:=(item->>'quantity')::numeric*(item->>'unitPriceMinor')::numeric;
    PERFORM mock_platform.integrity(gross<=9007199254740991 AND (item->>'grossMinor')::numeric=gross
      AND (item->>'discountMinor')::numeric<=gross AND (item->>'netMinor')::numeric=gross-(item->>'discountMinor')::numeric);
  END LOOP;
  PERFORM mock_platform.integrity((SELECT count(DISTINCT line->>'externalLineId') FROM jsonb_array_elements(value) line)=jsonb_array_length(value));
END $$;
CREATE FUNCTION mock_platform.require_payment(value JSONB) RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE paid NUMERIC:=(value->>'paidMinor')::numeric; payable NUMERIC:=(value->>'payableMinor')::numeric;
  settled BOOLEAN:=value->>'status' IN ('PAID','FULFILLED','COMPLETED');
BEGIN
  PERFORM mock_platform.integrity((NOT ((settled AND paid IS NOT NULL AND paid<>payable)
    OR (value->>'status'='PENDING_PAYMENT' AND (coalesce(paid>0,false) OR value->'paidAt'<>'null'::jsonb)))
    OR mock_platform.declares(value,'SOURCE_INCONSISTENT'))
    AND (value->'paidAt'<>'null'::jsonb OR (NOT settled AND (paid IS NULL OR paid=0))
      OR mock_platform.declares(value,'PAYMENT_UNKNOWN')));
END $$;
CREATE FUNCTION mock_platform.require_order(value JSONB) RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE gross NUMERIC; discount NUMERIC; payable NUMERIC; paid NUMERIC; refunded NUMERIC;
BEGIN
  PERFORM mock_platform.require_order_items(value->'items');
  SELECT sum((i->>'grossMinor')::numeric),sum((i->>'discountMinor')::numeric)
    INTO gross,discount FROM jsonb_array_elements(value->'items') i;
  payable:=gross-discount+(value->>'shippingMinor')::numeric;
  paid:=(value->>'paidMinor')::numeric; refunded:=(value->>'refundedMinor')::numeric;
  PERFORM mock_platform.integrity(gross<=9007199254740991 AND discount<=9007199254740991 AND payable<=9007199254740991
    AND (value->>'grossMinor')::numeric=gross AND (value->>'discountMinor')::numeric=discount
    AND (value->>'payableMinor')::numeric=payable AND (paid IS NULL OR paid<=payable)
    AND (refunded IS NULL OR refunded<=payable) AND (refunded IS NULL OR paid IS NULL OR refunded<=paid)
    AND (value->'paidAt'='null'::jsonb OR value->>'paidAt'>=value->>'orderedAt')
    AND (paid IS NOT NULL OR mock_platform.declares(value,'PAYMENT_UNKNOWN'))
    AND (refunded IS NOT NULL OR mock_platform.declares(value,'REFUND_UNKNOWN')));
  PERFORM mock_platform.require_payment(value);
END $$;
CREATE FUNCTION mock_platform.require_refund(value JSONB) RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE succeeded NUMERIC:=(value->>'succeededMinor')::numeric;
  succeeded_at TEXT:=value->>'succeededAt'; successful BOOLEAN:=value->>'status'='SUCCEEDED';
BEGIN
  PERFORM mock_platform.integrity((succeeded IS NULL OR succeeded<=(value->>'requestedMinor')::numeric)
    AND (succeeded_at IS NULL OR succeeded_at>=value->>'requestedAt')
    AND (NOT successful OR (succeeded IS NOT NULL AND succeeded_at IS NOT NULL) OR mock_platform.declares(value,'REFUND_UNKNOWN'))
    AND (successful OR ((succeeded IS NULL OR succeeded=0) AND succeeded_at IS NULL)
      OR mock_platform.declares(value,'SOURCE_INCONSISTENT')));
END $$;
CREATE FUNCTION mock_platform.require_inventory(value JSONB) RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE available NUMERIC:=(value->>'available')::numeric; reserved NUMERIC:=(value->>'reserved')::numeric;
  on_hand NUMERIC:=(value->>'onHand')::numeric;
BEGIN
  IF available IS NULL OR reserved IS NULL OR on_hand IS NULL THEN
    PERFORM mock_platform.integrity(mock_platform.declares(value,'INVENTORY_UNKNOWN'));
  ELSE PERFORM mock_platform.integrity(available+reserved<=on_hand); END IF;
END $$;
CREATE FUNCTION mock_platform.require_record(kind TEXT,value JSONB,external_store_id TEXT,occurred_at TEXT) RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM mock_platform.require_data_bounds(value,262144);
  PERFORM mock_platform.require_rules(value,mock_platform.record_rules(kind));
  PERFORM mock_platform.integrity(value->>'externalStoreId'=external_store_id
    AND mock_platform.valid_external_id(external_store_id,true));
  PERFORM mock_platform.require_source(value->'source',occurred_at);
  CASE kind
    WHEN 'STORE' THEN PERFORM mock_platform.integrity(value->'category'<>'null'::jsonb OR mock_platform.declares(value,'CATEGORY_MISSING'));
    WHEN 'PRODUCT' THEN PERFORM mock_platform.require_product(value);
    WHEN 'ORDER' THEN PERFORM mock_platform.require_order(value);
    WHEN 'REFUND' THEN PERFORM mock_platform.require_refund(value);
    WHEN 'INVENTORY' THEN PERFORM mock_platform.require_inventory(value);
    WHEN 'MARKETING' THEN PERFORM mock_platform.integrity(NOT EXISTS(SELECT 1 FROM jsonb_each(value) e
      WHERE e.key IN ('impressions','clicks','attributedOrders','spendMinor','attributedRevenueMinor') AND e.value='null'::jsonb)
      OR mock_platform.declares(value,'MARKETING_UNKNOWN'));
    ELSE PERFORM mock_platform.integrity(false);
  END CASE;
END $$;
CREATE FUNCTION mock_platform.phase_rank(kind TEXT) RETURNS SMALLINT
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE phase SMALLINT;
BEGIN
  phase:=CASE kind WHEN 'STORE' THEN 0 WHEN 'PRODUCT' THEN 10 WHEN 'ORDER' THEN 20
    WHEN 'REFUND' THEN 30 WHEN 'INVENTORY' THEN 40 WHEN 'MARKETING' THEN 50 ELSE NULL END;
  PERFORM mock_platform.integrity(phase IS NOT NULL);
  RETURN phase;
END $$;
CREATE FUNCTION mock_platform.entity_key(kind TEXT,value JSONB) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE key JSONB;
BEGIN
  PERFORM mock_platform.phase_rank(kind);
  key:=CASE kind WHEN 'STORE' THEN jsonb_build_array(kind,value->'externalStoreId')
    WHEN 'PRODUCT' THEN jsonb_build_array(kind,value->'externalProductId')
    WHEN 'ORDER' THEN jsonb_build_array(kind,value->'externalOrderId')
    WHEN 'REFUND' THEN jsonb_build_array(kind,value->'externalRefundId')
    WHEN 'INVENTORY' THEN jsonb_build_array(kind,value->'externalSkuId',value->'externalLocationId')
    WHEN 'MARKETING' THEN jsonb_build_array(kind,value->'externalCampaignId',value->'date') END;
  PERFORM mock_platform.integrity(jsonb_typeof(key->1)='string'
    AND mock_platform.valid_external_id(key->>1,kind='STORE')
    AND (kind<>'INVENTORY' OR (jsonb_typeof(key->2)='string' AND mock_platform.valid_external_id(key->>2,false)))
    AND (kind<>'MARKETING' OR (jsonb_typeof(key->2)='string' AND mock_platform.valid_date(key->>2))));
  RETURN key::text;
END $$;
CREATE FUNCTION mock_platform.require_event_tuple(value JSONB) RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE kind TEXT; key JSONB;
BEGIN
  PERFORM mock_platform.require_data_bounds(value,4096);
  PERFORM mock_platform.require_fields(value,ARRAY['occurredAt','kind','entityKey','ordinal']);
  PERFORM mock_platform.integrity(jsonb_typeof(value->'occurredAt')='string'
    AND mock_platform.valid_utc(value->>'occurredAt') AND jsonb_typeof(value->'kind')='string'
    AND jsonb_typeof(value->'ordinal')='string' AND mock_platform.valid_uint(value->>'ordinal'));
  kind:=value->>'kind'; key:=value->'entityKey'; PERFORM mock_platform.phase_rank(kind);
  PERFORM mock_platform.require_list(key,CASE WHEN kind IN ('INVENTORY','MARKETING') THEN 3 ELSE 2 END,
    CASE WHEN kind IN ('INVENTORY','MARKETING') THEN 3 ELSE 2 END);
  PERFORM mock_platform.integrity(key->0=to_jsonb(kind) AND jsonb_typeof(key->1)='string'
    AND mock_platform.valid_external_id(key->>1,kind='STORE')
    AND (kind<>'INVENTORY' OR (jsonb_typeof(key->2)='string' AND mock_platform.valid_external_id(key->>2,false)))
    AND (kind<>'MARKETING' OR (jsonb_typeof(key->2)='string' AND mock_platform.valid_date(key->>2))));
END $$;
CREATE FUNCTION mock_platform.compare_event_tuples(a JSONB,b JSONB) RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM mock_platform.require_event_tuple(a); PERFORM mock_platform.require_event_tuple(b);
  IF ROW((a->>'occurredAt')::timestamp,mock_platform.phase_rank(a->>'kind'),(a->'entityKey')::text COLLATE "C",mock_platform.source_uint(a->>'ordinal'))
    =ROW((b->>'occurredAt')::timestamp,mock_platform.phase_rank(b->>'kind'),(b->'entityKey')::text COLLATE "C",mock_platform.source_uint(b->>'ordinal')) THEN RETURN 0; END IF;
  IF ROW((a->>'occurredAt')::timestamp,mock_platform.phase_rank(a->>'kind'),(a->'entityKey')::text COLLATE "C",mock_platform.source_uint(a->>'ordinal'))
    <ROW((b->>'occurredAt')::timestamp,mock_platform.phase_rank(b->>'kind'),(b->'entityKey')::text COLLATE "C",mock_platform.source_uint(b->>'ordinal')) THEN RETURN -1; END IF;
  RETURN 1;
END $$;
-- Each fixed signature is explicit: never alter privileges of pre-existing helpers.
REVOKE ALL ON FUNCTION mock_platform.integrity(BOOLEAN),mock_platform.hash_jsonb(JSONB),
  mock_platform.valid_uint(TEXT),mock_platform.source_uint(TEXT),mock_platform.increment_uint(TEXT),
  mock_platform.valid_utc(TEXT),mock_platform.valid_date(TEXT),mock_platform.canonical_utc(TIMESTAMP),mock_platform.canonical_utc(TIMESTAMPTZ),
  mock_platform.normalized_boundary(TEXT),mock_platform.valid_external_id(TEXT,BOOLEAN),mock_platform.valid_text(TEXT,INTEGER),
  mock_platform.valid_amount(JSONB),mock_platform.require_fields(JSONB,TEXT[]),mock_platform.require_data_bounds(JSONB,INTEGER,INTEGER,INTEGER),
  mock_platform.require_list(JSONB,INTEGER,INTEGER),mock_platform.require_rules(JSONB,JSONB),mock_platform.declares(JSONB,TEXT),
  mock_platform.require_source(JSONB,TEXT),mock_platform.record_rules(TEXT),mock_platform.require_attributes(JSONB),mock_platform.require_product(JSONB),
  mock_platform.require_order_items(JSONB),mock_platform.require_payment(JSONB),mock_platform.require_order(JSONB),mock_platform.require_refund(JSONB),
  mock_platform.require_inventory(JSONB),mock_platform.require_record(TEXT,JSONB,TEXT,TEXT),mock_platform.phase_rank(TEXT),
  mock_platform.entity_key(TEXT,JSONB),mock_platform.require_event_tuple(JSONB),mock_platform.compare_event_tuples(JSONB,JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mock_platform.integrity(BOOLEAN),mock_platform.hash_jsonb(JSONB),
  mock_platform.valid_uint(TEXT),mock_platform.source_uint(TEXT),mock_platform.increment_uint(TEXT),
  mock_platform.valid_utc(TEXT),mock_platform.valid_date(TEXT),mock_platform.canonical_utc(TIMESTAMP),mock_platform.canonical_utc(TIMESTAMPTZ),
  mock_platform.normalized_boundary(TEXT),mock_platform.valid_external_id(TEXT,BOOLEAN),mock_platform.valid_text(TEXT,INTEGER),
  mock_platform.valid_amount(JSONB),mock_platform.require_fields(JSONB,TEXT[]),mock_platform.require_data_bounds(JSONB,INTEGER,INTEGER,INTEGER),
  mock_platform.require_list(JSONB,INTEGER,INTEGER),mock_platform.require_rules(JSONB,JSONB),mock_platform.declares(JSONB,TEXT),
  mock_platform.require_source(JSONB,TEXT),mock_platform.record_rules(TEXT),mock_platform.require_attributes(JSONB),mock_platform.require_product(JSONB),
  mock_platform.require_order_items(JSONB),mock_platform.require_payment(JSONB),mock_platform.require_order(JSONB),mock_platform.require_refund(JSONB),
  mock_platform.require_inventory(JSONB),mock_platform.require_record(TEXT,JSONB,TEXT,TEXT),mock_platform.phase_rank(TEXT),
  mock_platform.entity_key(TEXT,JSONB),mock_platform.require_event_tuple(JSONB),mock_platform.compare_event_tuples(JSONB,JSONB) TO shopmate_mock_source_worker;
COMMIT;


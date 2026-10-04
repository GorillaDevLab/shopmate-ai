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
-- Durable shape is complete; facts and publication stay closed until their physical
-- consistency guards are installed in a subsequent reviewed migration extension.
CREATE UNIQUE INDEX "Runtime_scope_key" ON mock_platform."Runtime"
  ("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation);
CREATE TABLE mock_platform."BuildJob" (
  "organizationId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "storeId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL, "connectionId" TEXT NOT NULL, "externalStoreId" TEXT NOT NULL, generation INTEGER NOT NULL,
  revision BIGINT NOT NULL CHECK (revision>0), "targetClockRevision" INTEGER NOT NULL CHECK ("targetClockRevision">=0),
  "targetTime" TIMESTAMP(3) NOT NULL, "baseRevision" BIGINT NOT NULL CHECK ("baseRevision">=0),
  "baseHighEventSeq" BIGINT NOT NULL CHECK ("baseHighEventSeq">=0), "baseProcessedThrough" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL, state TEXT NOT NULL CHECK (state IN ('BUILDING','FAILED','PUBLISHED')),
  "leaseGrantId" TEXT NOT NULL, "leaseOwner" TEXT NOT NULL CHECK ("leaseOwner" ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
  fence BIGINT NOT NULL CHECK (fence>0), "leaseUntil" TIMESTAMPTZ(3) NOT NULL,
  "failureCode" TEXT CHECK ("failureCode" IN ('INTERRUPTED','GENERATOR_INVALID')),
  checkpoint JSONB NOT NULL CHECK (octet_length(checkpoint::text)<=4096),
  "checkpointHash" TEXT NOT NULL CHECK ("checkpointHash" ~ '^[a-f0-9]{64}$'),
  "highEventSeq" BIGINT NOT NULL CHECK ("highEventSeq">=0), "eventCount" BIGINT NOT NULL CHECK ("eventCount">=0),
  "versionCount" BIGINT NOT NULL CHECK ("versionCount"="eventCount"),
  "lastAppendExpectedHash" TEXT CHECK ("lastAppendExpectedHash" ~ '^[a-f0-9]{64}$'),
  "lastAppendStartSeq" BIGINT CHECK ("lastAppendStartSeq">=0), "lastAppendEventCount" INTEGER CHECK ("lastAppendEventCount" BETWEEN 0 AND 100),
  "lastAppendHash" TEXT CHECK ("lastAppendHash" ~ '^[a-f0-9]{64}$'), "processedThrough" TIMESTAMP(3) NOT NULL,
  "generatorVersion" TEXT NOT NULL CHECK ("generatorVersion"='mock-source-v1'),
  "runtimeVersion" TEXT NOT NULL CHECK ("runtimeVersion"='mock-runtime-v2'), codec TEXT NOT NULL CHECK (codec='source-snapshot-v1'),
  "publishedAt" TIMESTAMPTZ(3), "certificateHash" TEXT CHECK ("certificateHash" ~ '^[a-f0-9]{64}$'), "mutationXid" xid8 NOT NULL,
  CONSTRAINT "BuildJob_pkey" PRIMARY KEY ("sessionId",generation,revision),
  CONSTRAINT "BuildJob_scope_revision_key" UNIQUE ("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,revision),
  CONSTRAINT "BuildJob_target_key" UNIQUE ("sessionId",generation,"targetClockRevision"),
  CONSTRAINT "BuildJob_runtime_fkey" FOREIGN KEY ("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation)
    REFERENCES mock_platform."Runtime" ("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "BuildJob_counts_check" CHECK ("highEventSeq"::numeric="baseHighEventSeq"::numeric+"eventCount"::numeric AND revision>"baseRevision"),
  CONSTRAINT "BuildJob_time_check" CHECK (isfinite("targetTime") AND "baseProcessedThrough">=timestamp '0001-01-01' AND "baseProcessedThrough"<="processedThrough" AND "processedThrough"<="targetTime" AND "targetTime"<=timestamp '9999-12-31 23:59:59.999'),
  CONSTRAINT "BuildJob_publication_check" CHECK ((state='PUBLISHED')=("publishedAt" IS NOT NULL AND "certificateHash" IS NOT NULL) AND (state='FAILED')=("failureCode" IS NOT NULL)),
  CONSTRAINT "BuildJob_receipt_check" CHECK (("lastAppendExpectedHash" IS NULL AND "lastAppendStartSeq" IS NULL AND "lastAppendEventCount" IS NULL AND "lastAppendHash" IS NULL)
    OR ("lastAppendExpectedHash" IS NOT NULL AND "lastAppendStartSeq" IS NOT NULL AND "lastAppendEventCount" IS NOT NULL AND "lastAppendHash" IS NOT NULL))
);
CREATE UNIQUE INDEX "BuildJob_open_key" ON mock_platform."BuildJob" ("sessionId",generation) WHERE state IN ('BUILDING','FAILED');
CREATE TABLE mock_platform."SourceEvent" (
  "organizationId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "storeId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL, "connectionId" TEXT NOT NULL, "externalStoreId" TEXT NOT NULL, generation INTEGER NOT NULL,
  "releaseRevision" BIGINT NOT NULL CHECK ("releaseRevision">0), "eventSeq" BIGINT NOT NULL CHECK ("eventSeq">0),
  "eventId" TEXT NOT NULL CHECK ("eventId" ~ '^[a-f0-9]{64}$'), "appendIndex" BIGINT NOT NULL CHECK ("appendIndex">0),
  "acceptedFence" BIGINT NOT NULL CHECK ("acceptedFence">0), "occurredAt" TIMESTAMP(3) NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('STORE','PRODUCT','ORDER','REFUND','INVENTORY','MARKETING')),
  "phaseRank" SMALLINT NOT NULL, "entityKey" TEXT NOT NULL, ordinal BIGINT NOT NULL CHECK (ordinal>=0),
  payload JSONB NOT NULL CHECK (octet_length(payload::text)<=262144), manifest JSONB NOT NULL,
  "envelopeHash" TEXT NOT NULL CHECK ("envelopeHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "SourceEvent_pkey" PRIMARY KEY ("sessionId",generation,"eventSeq"),
  CONSTRAINT "SourceEvent_id_key" UNIQUE ("sessionId",generation,"eventId"),
  CONSTRAINT "SourceEvent_scope_sequence_key" UNIQUE ("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,"releaseRevision","eventSeq"),
  CONSTRAINT "SourceEvent_runtime_fkey" FOREIGN KEY ("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation)
    REFERENCES mock_platform."Runtime" ("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "SourceEvent_job_fkey" FOREIGN KEY ("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,"releaseRevision")
    REFERENCES mock_platform."BuildJob" ("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,revision) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "SourceEvent_calendar_check" CHECK (isfinite("occurredAt") AND "occurredAt" BETWEEN timestamp '0001-01-01' AND timestamp '9999-12-31 23:59:59.999')
);
CREATE INDEX "SourceEvent_job_append_idx" ON mock_platform."SourceEvent" ("sessionId",generation,"releaseRevision","appendIndex","eventSeq");
CREATE TABLE mock_platform."EntityVersion" (
  "organizationId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "storeId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL, "connectionId" TEXT NOT NULL, "externalStoreId" TEXT NOT NULL, generation INTEGER NOT NULL,
  "releaseRevision" BIGINT NOT NULL CHECK ("releaseRevision">0), "eventSeq" BIGINT NOT NULL CHECK ("eventSeq">0),
  kind TEXT NOT NULL CHECK (kind IN ('STORE','PRODUCT','ORDER','REFUND','INVENTORY','MARKETING')),
  "entityKey" TEXT NOT NULL, "occurredAt" TIMESTAMP(3) NOT NULL,
  payload JSONB NOT NULL CHECK (octet_length(payload::text)<=262144), "versionHash" TEXT NOT NULL CHECK ("versionHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "EntityVersion_pkey" PRIMARY KEY ("sessionId",generation,"eventSeq"),
  CONSTRAINT "EntityVersion_runtime_fkey" FOREIGN KEY ("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation)
    REFERENCES mock_platform."Runtime" ("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "EntityVersion_event_fkey" FOREIGN KEY ("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,"releaseRevision","eventSeq")
    REFERENCES mock_platform."SourceEvent" ("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,"releaseRevision","eventSeq") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "EntityVersion_calendar_check" CHECK (isfinite("occurredAt") AND "occurredAt" BETWEEN timestamp '0001-01-01' AND timestamp '9999-12-31 23:59:59.999')
);
CREATE INDEX "EntityVersion_entity_sequence_idx" ON mock_platform."EntityVersion" ("sessionId",generation,kind,"entityKey" COLLATE "C","eventSeq" DESC);

CREATE FUNCTION mock_platform.source_scope(value JSONB) RETURNS JSONB
LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('organizationId',value->'organizationId','workspaceId',value->'workspaceId',
    'storeId',value->'storeId','sessionId',value->'sessionId','connectionId',value->'connectionId',
    'externalStoreId',value->'externalStoreId','generation',value->'generation')
$$;
CREATE FUNCTION mock_platform.source_conflict() RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Source publication conflict' USING ERRCODE='SM004';
END $$;
CREATE FUNCTION mock_platform.require_source_scope(value JSONB) RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE allowed BOOLEAN;
BEGIN
  IF value->>'sessionId' IS DISTINCT FROM current_setting('demo.control_session_id',true) THEN
    RAISE EXCEPTION 'Invalid source control protocol' USING ERRCODE='SM002';
  END IF;
  PERFORM demo.lock_source_control(value->>'sessionId');
  -- A separate SQL command after CONTROL observes committed authorization changes.
  SELECT mock_platform.has_worker_access(value->>'organizationId',value->>'workspaceId',value->>'storeId',
    value->>'sessionId',value->>'connectionId',value->>'externalStoreId',(value->>'generation')::integer) INTO allowed;
  IF allowed IS NOT TRUE THEN
    RAISE EXCEPTION 'Source control access denied' USING ERRCODE='SM001';
  END IF;
END $$;
CREATE FUNCTION mock_platform.require_lease_statement() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM demo.lock_source_control(current_setting('demo.control_session_id',true));
  IF current_setting('mock.source_op',true) IS NULL OR current_setting('mock.source_op',true) NOT IN ('CLAIM','RENEW','FAIL') THEN
    RAISE EXCEPTION 'Invalid source control protocol' USING ERRCODE='SM002';
  END IF;
  RETURN NULL;
END $$;
CREATE FUNCTION mock_platform.deny_source_fact_insert() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM demo.lock_source_control(current_setting('demo.control_session_id',true));
  RAISE EXCEPTION 'Invalid source control protocol' USING ERRCODE='SM002';
END $$;
CREATE FUNCTION mock_platform.deny_source_mutation() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Invalid source integrity' USING ERRCODE='SM005';
END $$;
CREATE FUNCTION mock_platform.require_lease_owner(owner_id TEXT) RETURNS VOID
LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT mock_platform.integrity(owner_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')
$$;
CREATE FUNCTION mock_platform.require_live_lease(job mock_platform."BuildJob") RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE input TEXT; ref JSONB;
BEGIN
  input:=current_setting('mock.source_lease',true);
  PERFORM mock_platform.integrity(input IS NOT NULL AND octet_length(input)<=1024);
  BEGIN ref:=input::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Invalid source integrity' USING ERRCODE='SM005';
  END;
  PERFORM mock_platform.require_fields(ref,ARRAY['revision','fence','ownerId']);
  PERFORM mock_platform.integrity(jsonb_typeof(ref->'revision')='string' AND jsonb_typeof(ref->'fence')='string'
    AND jsonb_typeof(ref->'ownerId')='string');
  PERFORM mock_platform.require_lease_owner(ref->>'ownerId');
  PERFORM mock_platform.integrity(mock_platform.source_uint(ref->>'revision')>0 AND mock_platform.source_uint(ref->>'fence')>0);
  IF ref->>'revision' IS DISTINCT FROM job.revision::text OR ref->>'fence' IS DISTINCT FROM job.fence::text
    OR ref->>'ownerId' IS DISTINCT FROM job."leaseOwner" OR job."leaseGrantId" IS DISTINCT FROM current_setting('mock.grant_id',true)
    OR job."leaseUntil"<=clock_timestamp() THEN
    RAISE EXCEPTION 'Source lease fence rejected' USING ERRCODE='SM003';
  END IF;
END $$;
CREATE FUNCTION mock_platform.initial_job(candidate mock_platform."BuildJob",runtime mock_platform."Runtime",head mock_platform."BuildJob") RETURNS mock_platform."BuildJob"
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE wall TIMESTAMPTZ(3):=clock_timestamp();
BEGIN
  candidate.revision:=mock_platform.source_uint(mock_platform.increment_uint(coalesce(head.revision,0)::text));
  SELECT d."clockNow",d."clockRevision" INTO candidate."targetTime",candidate."targetClockRevision"
    FROM demo."DemoCommerceSession" d WHERE d.id=candidate."sessionId";
  candidate."baseRevision":=coalesce(head.revision,0); candidate."baseHighEventSeq":=coalesce(head."highEventSeq",0);
  candidate."baseProcessedThrough":=coalesce(head."processedThrough",runtime."openingAt");
  candidate."processedThrough":=candidate."baseProcessedThrough"; candidate."highEventSeq":=candidate."baseHighEventSeq";
  candidate."eventCount":=0; candidate."versionCount":=0; candidate.state:='BUILDING'; candidate.fence:=1;
  candidate."leaseGrantId":=current_setting('mock.grant_id',true); candidate."createdAt":=wall; candidate."leaseUntil":=wall+interval '30 seconds';
  candidate."failureCode":=NULL; candidate."publishedAt":=NULL; candidate."certificateHash":=NULL;
  candidate."lastAppendExpectedHash":=NULL; candidate."lastAppendStartSeq":=NULL; candidate."lastAppendEventCount":=NULL; candidate."lastAppendHash":=NULL;
  candidate."generatorVersion":=runtime."generatorVersion"; candidate."runtimeVersion":=runtime."runtimeVersion"; candidate.codec:='source-snapshot-v1';
  candidate.checkpoint:=jsonb_build_object('codec','source-checkpoint-v1','chunkIndex','0','highEventSeq',candidate."highEventSeq"::text,
    'processedThrough',mock_platform.canonical_utc(candidate."processedThrough"),'lastEvent',coalesce(head.checkpoint->'lastEvent','null'::jsonb),'sealed',false);
  candidate."checkpointHash":=mock_platform.hash_jsonb(jsonb_build_object('codec','source-checkpoint-hash-v1',
    'scope',mock_platform.source_scope(to_jsonb(candidate)),'revision',candidate.revision::text,'checkpoint',candidate.checkpoint));
  candidate."mutationXid":=pg_current_xact_id();
  RETURN candidate;
END $$;
CREATE FUNCTION mock_platform.guard_job_insert() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE runtime mock_platform."Runtime"; head mock_platform."BuildJob"; target TIMESTAMP;
BEGIN
  PERFORM mock_platform.require_source_scope(to_jsonb(NEW));
  IF current_setting('mock.source_op',true) IS DISTINCT FROM 'CLAIM' THEN PERFORM mock_platform.source_conflict(); END IF;
  PERFORM mock_platform.require_lease_owner(NEW."leaseOwner");
  SELECT r.* INTO runtime FROM mock_platform."Runtime" r WHERE r."sessionId"=NEW."sessionId" AND r.generation=NEW.generation;
  IF runtime IS NULL THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM mock_platform."BuildJob" j WHERE j."sessionId"=NEW."sessionId" AND j.generation=NEW.generation AND j.state IN ('BUILDING','FAILED')) THEN RETURN NULL; END IF;
  SELECT j.* INTO head FROM mock_platform."BuildJob" j WHERE j."sessionId"=NEW."sessionId" AND j.generation=NEW.generation AND j.state='PUBLISHED' ORDER BY j.revision DESC LIMIT 1;
  SELECT d."clockNow" INTO target FROM demo."DemoCommerceSession" d WHERE d.id=NEW."sessionId";
  IF target<runtime."openingAt" OR (head.revision IS NOT NULL AND head."targetTime">=target) THEN RETURN NULL; END IF;
  RETURN mock_platform.initial_job(NEW,runtime,head);
END $$;
CREATE FUNCTION mock_platform.transition_job(old_job mock_platform."BuildJob",proposal mock_platform."BuildJob") RETURNS mock_platform."BuildJob"
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE op TEXT:=current_setting('mock.source_op',true); result mock_platform."BuildJob":=old_job;
BEGIN
  IF old_job.state='PUBLISHED' THEN PERFORM mock_platform.source_conflict(); END IF;
  PERFORM mock_platform.integrity(old_job."mutationXid"<>pg_current_xact_id());
  IF (to_jsonb(proposal)-ARRAY['state','leaseOwner','failureCode']) IS DISTINCT FROM (to_jsonb(old_job)-ARRAY['state','leaseOwner','failureCode']) THEN
    PERFORM mock_platform.source_conflict();
  END IF;
  IF op='CLAIM' THEN
    IF old_job.state='BUILDING' AND old_job."leaseUntil">clock_timestamp() THEN RETURN NULL; END IF;
    IF proposal.state IS DISTINCT FROM 'BUILDING' OR proposal."failureCode" IS NOT NULL THEN PERFORM mock_platform.source_conflict(); END IF;
    PERFORM mock_platform.require_lease_owner(proposal."leaseOwner");
    result."leaseOwner":=proposal."leaseOwner"; result.fence:=mock_platform.source_uint(mock_platform.increment_uint(old_job.fence::text));
    result.state:='BUILDING'; result."failureCode":=NULL; result."leaseGrantId":=current_setting('mock.grant_id',true);
  ELSE
    PERFORM mock_platform.require_live_lease(old_job);
    IF old_job.state<>'BUILDING' OR proposal."leaseOwner" IS DISTINCT FROM old_job."leaseOwner" THEN PERFORM mock_platform.source_conflict(); END IF;
    IF op='RENEW' THEN
      IF proposal.state IS DISTINCT FROM old_job.state OR proposal."failureCode" IS NOT NULL THEN PERFORM mock_platform.source_conflict(); END IF;
    ELSIF op='FAIL' THEN
      IF proposal.state IS DISTINCT FROM 'FAILED' OR proposal."failureCode" IS NULL OR proposal."failureCode" NOT IN ('INTERRUPTED','GENERATOR_INVALID') THEN PERFORM mock_platform.source_conflict(); END IF;
      result.state:='FAILED'; result."failureCode":=proposal."failureCode";
    ELSE PERFORM mock_platform.source_conflict(); END IF;
  END IF;
  IF op IN ('CLAIM','RENEW') THEN result."leaseUntil":=clock_timestamp()+interval '30 seconds'; END IF;
  result."mutationXid":=pg_current_xact_id();
  RETURN result;
END $$;
CREATE FUNCTION mock_platform.guard_job_update() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE locked mock_platform."BuildJob";
BEGIN
  PERFORM mock_platform.require_source_scope(to_jsonb(OLD));
  SELECT j.* INTO locked FROM mock_platform."BuildJob" j WHERE j."sessionId"=OLD."sessionId" AND j.generation=OLD.generation AND j.revision=OLD.revision FOR UPDATE;
  -- This distinct command follows the job lock too; RLS on the outer UPDATE is insufficient.
  PERFORM mock_platform.require_source_scope(to_jsonb(OLD));
  PERFORM mock_platform.integrity(locked.revision IS NOT NULL AND locked IS NOT DISTINCT FROM OLD);
  RETURN mock_platform.transition_job(OLD,NEW);
END $$;
CREATE FUNCTION mock_platform.check_final_job_lease() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE final mock_platform."BuildJob";
BEGIN
  PERFORM mock_platform.require_source_scope(to_jsonb(NEW));
  SELECT j.* INTO final FROM mock_platform."BuildJob" j WHERE j."sessionId"=NEW."sessionId" AND j.generation=NEW.generation AND j.revision=NEW.revision;
  PERFORM mock_platform.integrity(final.revision IS NOT NULL AND final IS NOT DISTINCT FROM NEW);
  IF final."leaseGrantId" IS DISTINCT FROM current_setting('mock.grant_id',true) OR final."leaseUntil"<=clock_timestamp() THEN
    RAISE EXCEPTION 'Source lease fence rejected' USING ERRCODE='SM003';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER source_job_control_insert BEFORE INSERT ON mock_platform."BuildJob" FOR EACH STATEMENT EXECUTE FUNCTION mock_platform.require_lease_statement();
CREATE TRIGGER source_job_control_update BEFORE UPDATE ON mock_platform."BuildJob" FOR EACH STATEMENT EXECUTE FUNCTION mock_platform.require_lease_statement();
CREATE TRIGGER source_job_insert BEFORE INSERT ON mock_platform."BuildJob" FOR EACH ROW EXECUTE FUNCTION mock_platform.guard_job_insert();
CREATE TRIGGER source_job_update BEFORE UPDATE ON mock_platform."BuildJob" FOR EACH ROW EXECUTE FUNCTION mock_platform.guard_job_update();
CREATE CONSTRAINT TRIGGER source_job_final_lease AFTER INSERT OR UPDATE ON mock_platform."BuildJob" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mock_platform.check_final_job_lease();
CREATE TRIGGER source_job_destructive BEFORE DELETE OR TRUNCATE ON mock_platform."BuildJob" FOR EACH STATEMENT EXECUTE FUNCTION mock_platform.deny_source_mutation();
CREATE TRIGGER source_event_closed BEFORE INSERT ON mock_platform."SourceEvent" FOR EACH STATEMENT EXECUTE FUNCTION mock_platform.deny_source_fact_insert();
CREATE TRIGGER source_event_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON mock_platform."SourceEvent" FOR EACH STATEMENT EXECUTE FUNCTION mock_platform.deny_source_mutation();
CREATE TRIGGER source_version_closed BEFORE INSERT ON mock_platform."EntityVersion" FOR EACH STATEMENT EXECUTE FUNCTION mock_platform.deny_source_fact_insert();
CREATE TRIGGER source_version_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON mock_platform."EntityVersion" FOR EACH STATEMENT EXECUTE FUNCTION mock_platform.deny_source_mutation();

ALTER TABLE mock_platform."BuildJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE mock_platform."BuildJob" FORCE ROW LEVEL SECURITY;
ALTER TABLE mock_platform."SourceEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE mock_platform."SourceEvent" FORCE ROW LEVEL SECURITY;
ALTER TABLE mock_platform."EntityVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE mock_platform."EntityVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY source_worker_job_select ON mock_platform."BuildJob" FOR SELECT TO shopmate_mock_source_worker USING (mock_platform.has_worker_access("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation));
CREATE POLICY source_worker_job_insert ON mock_platform."BuildJob" FOR INSERT TO shopmate_mock_source_worker WITH CHECK (mock_platform.has_worker_access("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation));
CREATE POLICY source_worker_job_update ON mock_platform."BuildJob" FOR UPDATE TO shopmate_mock_source_worker USING (mock_platform.has_worker_access("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation)) WITH CHECK (mock_platform.has_worker_access("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation));
CREATE POLICY source_worker_event_select ON mock_platform."SourceEvent" FOR SELECT TO shopmate_mock_source_worker USING (mock_platform.has_worker_access("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation));
CREATE POLICY source_worker_event_insert ON mock_platform."SourceEvent" FOR INSERT TO shopmate_mock_source_worker WITH CHECK (mock_platform.has_worker_access("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation));
CREATE POLICY source_worker_version_select ON mock_platform."EntityVersion" FOR SELECT TO shopmate_mock_source_worker USING (mock_platform.has_worker_access("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation));
CREATE POLICY source_worker_version_insert ON mock_platform."EntityVersion" FOR INSERT TO shopmate_mock_source_worker WITH CHECK (mock_platform.has_worker_access("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation));
CREATE POLICY source_reader_certificate ON mock_platform."BuildJob" FOR SELECT TO shopmate_mock_source_reader USING (state='PUBLISHED' AND mock_platform.has_current_access("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation));
CREATE POLICY source_reader_version ON mock_platform."EntityVersion" FOR SELECT TO shopmate_mock_source_reader USING (
  mock_platform.has_current_access("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation)
  AND EXISTS (SELECT 1 FROM mock_platform."BuildJob" j WHERE j."organizationId"="EntityVersion"."organizationId" AND j."workspaceId"="EntityVersion"."workspaceId"
    AND j."storeId"="EntityVersion"."storeId" AND j."sessionId"="EntityVersion"."sessionId" AND j."connectionId"="EntityVersion"."connectionId"
    AND j."externalStoreId"="EntityVersion"."externalStoreId" AND j.generation="EntityVersion".generation AND j.revision="EntityVersion"."releaseRevision" AND j.state='PUBLISHED'));
REVOKE ALL ON mock_platform."BuildJob",mock_platform."SourceEvent",mock_platform."EntityVersion" FROM PUBLIC;
GRANT SELECT ON mock_platform."BuildJob",mock_platform."SourceEvent",mock_platform."EntityVersion" TO shopmate_mock_source_worker;
GRANT INSERT ("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,"leaseOwner") ON mock_platform."BuildJob" TO shopmate_mock_source_worker;
GRANT UPDATE (state,"leaseOwner",checkpoint,"failureCode") ON mock_platform."BuildJob" TO shopmate_mock_source_worker;
GRANT INSERT ("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,"releaseRevision",kind,"occurredAt",ordinal,payload) ON mock_platform."SourceEvent" TO shopmate_mock_source_worker;
GRANT INSERT ("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,"releaseRevision","eventSeq") ON mock_platform."EntityVersion" TO shopmate_mock_source_worker;
GRANT SELECT ("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,revision,"targetClockRevision","targetTime","baseRevision","baseHighEventSeq","highEventSeq","eventCount","versionCount","processedThrough","generatorVersion","runtimeVersion",codec,"publishedAt","certificateHash",state) ON mock_platform."BuildJob" TO shopmate_mock_source_reader;
GRANT SELECT ON mock_platform."EntityVersion" TO shopmate_mock_source_reader;
REVOKE ALL ON FUNCTION mock_platform.source_scope(JSONB),mock_platform.source_conflict(),mock_platform.require_source_scope(JSONB),mock_platform.require_lease_statement(),
  mock_platform.deny_source_fact_insert(),mock_platform.deny_source_mutation(),mock_platform.require_lease_owner(TEXT),mock_platform.require_live_lease(mock_platform."BuildJob"),
  mock_platform.initial_job(mock_platform."BuildJob",mock_platform."Runtime",mock_platform."BuildJob"),mock_platform.guard_job_insert(),
  mock_platform.transition_job(mock_platform."BuildJob",mock_platform."BuildJob"),mock_platform.guard_job_update(),mock_platform.check_final_job_lease() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mock_platform.source_scope(JSONB),mock_platform.source_conflict(),mock_platform.require_source_scope(JSONB),mock_platform.require_lease_statement(),
  mock_platform.deny_source_fact_insert(),mock_platform.deny_source_mutation(),mock_platform.require_lease_owner(TEXT),mock_platform.require_live_lease(mock_platform."BuildJob"),
  mock_platform.initial_job(mock_platform."BuildJob",mock_platform."Runtime",mock_platform."BuildJob"),mock_platform.guard_job_insert(),
  mock_platform.transition_job(mock_platform."BuildJob",mock_platform."BuildJob"),mock_platform.guard_job_update(),mock_platform.check_final_job_lease() TO shopmate_mock_source_worker;
COMMIT;


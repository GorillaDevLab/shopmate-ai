BEGIN;

CREATE FUNCTION mock_platform.observed_config_fields(value JSONB, keys TEXT[]) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT CASE WHEN jsonb_typeof(value)='object'
    THEN value ?& keys AND value-keys='{}'::jsonb ELSE false END
$$;

CREATE FUNCTION mock_platform.observed_config_integer(value JSONB, minimum INTEGER, maximum BIGINT)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE number NUMERIC;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
  number:=value::numeric;
  RETURN number BETWEEN minimum AND maximum AND number=trunc(number);
END $$;

CREATE FUNCTION mock_platform.observed_config_delivery(delivery JSONB) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT CASE delivery->>'kind'
    WHEN 'NORMAL' THEN mock_platform.observed_config_fields(delivery,ARRAY['kind'])
    WHEN 'INTERRUPT' THEN mock_platform.observed_config_fields(delivery,ARRAY['kind','durationMs'])
      AND mock_platform.observed_config_integer(delivery->'durationMs',1,86400000)
    WHEN 'REPLAY_SAVED_PAGE' THEN mock_platform.observed_config_fields(delivery,ARRAY['kind','repetitions'])
      AND mock_platform.observed_config_integer(delivery->'repetitions',1,3)
    ELSE false END
$$;

CREATE FUNCTION mock_platform.observed_config_mutation(mutation JSONB, sku_count INTEGER)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT mock_platform.observed_config_fields(mutation, ARRAY[
    'skuIndex','retainDemandBps','priceBps','discountBps','refundBps','cancelBps',
    'restockBps','launchRampDays','restockDelayDays'])
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES ('skuIndex',0,least(299,sku_count::bigint-1)),('retainDemandBps',0,10000),
      ('priceBps',1000,30000),('discountBps',0,9000),('refundBps',0,10000),
      ('cancelBps',0,10000),('restockBps',0,100000),('launchRampDays',0,14),
      ('restockDelayDays',0,5)) AS limits(key,minimum,maximum)
    WHERE NOT mock_platform.observed_config_integer(mutation->key,minimum,maximum)
  )
$$;

CREATE FUNCTION mock_platform.observed_config_scenario(plan JSONB, external_id TEXT, days INTEGER, sku_count INTEGER)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE mutations JSONB:=plan->'mutations';
BEGIN
  IF NOT mock_platform.observed_config_fields(plan,ARRAY['version','scenarioId','externalStoreId',
    'startDay','endDay','mutations','campaignSpendBps','campaignConversionBps','delivery'])
    OR plan->>'version' IS DISTINCT FROM 'mock-scenario-v1'
    OR (plan->>'scenarioId' ~ '^SCENARIO_(00[1-9]|01[0-5])$') IS NOT TRUE
    OR plan->'externalStoreId' IS DISTINCT FROM to_jsonb(external_id)
    OR NOT mock_platform.observed_config_integer(plan->'startDay',0,364)
    OR NOT mock_platform.observed_config_integer(plan->'endDay',1,days)
    OR NOT mock_platform.observed_config_integer(plan->'campaignSpendBps',1000,100000)
    OR NOT mock_platform.observed_config_integer(plan->'campaignConversionBps',0,10000)
    OR NOT mock_platform.observed_config_delivery(plan->'delivery')
    OR jsonb_typeof(mutations) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(mutations)>3 OR (plan->'startDay')::numeric>=(plan->'endDay')::numeric
    THEN RETURN false; END IF;
  RETURN (SELECT count(DISTINCT value->'skuIndex')=count(*)
    AND coalesce(bool_and(mock_platform.observed_config_mutation(value,sku_count)),true)
    FROM jsonb_array_elements(mutations));
END $$;

-- JSONB drops object order. Rebuild each object in the frozen contract's declaration order.
CREATE FUNCTION mock_platform.observed_config_properties(value JSONB, keys TEXT[]) RETURNS TEXT
LANGUAGE SQL IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT string_agg(to_jsonb(key)::text||':'||
    CASE jsonb_typeof(value->key)
      WHEN 'number' THEN trim_scale((value->key)::numeric)::text
      WHEN 'string' THEN (value->key)::text
    END,',' ORDER BY position)
  FROM unnest(keys) WITH ORDINALITY AS field(key,position)
$$;

CREATE FUNCTION mock_platform.observed_config_scenario_json(plan JSONB) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE mutations JSONB:=plan->'mutations'; delivery JSONB:=plan->'delivery'; items TEXT;
  delivery_keys TEXT[]:=ARRAY['kind'];
BEGIN
  PERFORM mock_platform.integrity(jsonb_typeof(mutations)='array');
  PERFORM mock_platform.integrity(jsonb_array_length(mutations)<=3);
  SELECT coalesce(string_agg('{'||mock_platform.observed_config_properties(item, ARRAY[
    'skuIndex','retainDemandBps','priceBps','discountBps','refundBps','cancelBps',
    'restockBps','launchRampDays','restockDelayDays'])||'}',',' ORDER BY position),'')
  INTO items FROM jsonb_array_elements(mutations) WITH ORDINALITY AS entry(item,position);
  CASE delivery->>'kind'
    WHEN 'INTERRUPT' THEN delivery_keys:=array_append(delivery_keys,'durationMs');
    WHEN 'REPLAY_SAVED_PAGE' THEN delivery_keys:=array_append(delivery_keys,'repetitions');
    ELSE NULL;
  END CASE;
  RETURN '{'||mock_platform.observed_config_properties(plan, ARRAY[
    'version','scenarioId','externalStoreId','startDay','endDay'])
    ||',"mutations":['||items||'],'||mock_platform.observed_config_properties(plan,
      ARRAY['campaignSpendBps','campaignConversionBps'])
    ||',"delivery":{'||mock_platform.observed_config_properties(delivery,delivery_keys)||'}}';
END $$;

CREATE FUNCTION mock_platform.observed_config_json(config JSONB) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM mock_platform.integrity(pg_column_size(config)<=1000000);
  RETURN '{'||mock_platform.observed_config_properties(config,ARRAY['modelVersion'])
    ||',"binding":{'||mock_platform.observed_config_properties(config->'binding', ARRAY[
      'organizationId','workspaceId','storeId','connectionId','externalStoreId'])||'},'
    ||mock_platform.observed_config_properties(config, ARRAY['seed','profile','historyStart',
      'days','productCount','variantsPerProduct','dailyOrders','growthBps','refundBps','adSpendMinor'])
    ||',"scenarioPlan":'||CASE WHEN config->'scenarioPlan'='null'::jsonb THEN 'null'
      ELSE mock_platform.observed_config_scenario_json(config->'scenarioPlan') END||'}';
END $$;

CREATE FUNCTION mock_platform.observed_config_shape(config JSONB, binding JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE keys TEXT[]:=ARRAY['modelVersion','binding','seed','profile','historyStart','days',
  'productCount','variantsPerProduct','dailyOrders','growthBps','refundBps','adSpendMinor','scenarioPlan'];
BEGIN
  IF NOT mock_platform.observed_config_fields(config,keys)
    OR config->'binding' IS DISTINCT FROM binding
    OR NOT mock_platform.valid_external_id(binding->>'externalStoreId',true)
    OR config->>'modelVersion' IS DISTINCT FROM 'mock-business-observed-v1'
    OR (config->>'profile' IN ('mature','growing','problematic','new')) IS NOT TRUE
    OR (config->>'historyStart' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T16:00:00\.000Z$') IS NOT TRUE
    OR NOT mock_platform.valid_utc(config->>'historyStart') THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM (VALUES ('seed',0,4294967295::bigint),('days',1,365),
      ('productCount',1,100),('variantsPerProduct',1,3),('dailyOrders',1,300),
      ('growthBps',0,10000),('refundBps',0,5000),('adSpendMinor',0,100000000)) AS limits(key,minimum,maximum)
    WHERE NOT mock_platform.observed_config_integer(config->key,minimum,maximum)
  ) THEN RETURN false; END IF;
  RETURN (config->'days')::integer*ceil((config->'dailyOrders')::integer*1.35)<=150000
    AND ((config->>'historyStart')::timestamp+((config->'days')::integer+5)*interval '1 day'
      <=timestamp '9999-12-31 23:59:59.999')
    AND (config->'scenarioPlan'='null'::jsonb OR mock_platform.observed_config_scenario(
      config->'scenarioPlan',binding->>'externalStoreId',(config->'days')::integer,
      (config->'productCount')::integer*(config->'variantsPerProduct')::integer
    ));
END $$;

CREATE FUNCTION mock_platform.observed_runtime_calendar(candidate mock_platform."Runtime", config JSONB)
RETURNS VOID LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE binding JSONB; start_at TIMESTAMP; days INTEGER; offset_days INTEGER;
BEGIN
  binding:=jsonb_build_object('organizationId',candidate."organizationId",'workspaceId',candidate."workspaceId",
    'storeId',candidate."storeId",'connectionId',candidate."connectionId",'externalStoreId',candidate."externalStoreId");
  IF NOT mock_platform.observed_config_shape(config,binding) THEN
    RAISE EXCEPTION 'Invalid source snapshot' USING ERRCODE='23514';
  END IF;
  IF candidate."configHash" IS DISTINCT FROM
    encode(sha256(convert_to(mock_platform.observed_config_json(config),'UTF8')),'hex') THEN
    RAISE EXCEPTION 'Invalid source snapshot' USING ERRCODE='23514';
  END IF;
  days:=(config->'days')::integer; start_at:=(config->>'historyStart')::timestamp;
  offset_days:=CASE WHEN config->>'profile'='new' THEN greatest(0,days-14) ELSE 0 END;
  IF candidate."openingAt" IS DISTINCT FROM start_at+offset_days*interval '1 day'
    OR candidate."baselineEnd" IS DISTINCT FROM start_at+days*interval '1 day' THEN
    RAISE EXCEPTION 'Invalid source calendar' USING ERRCODE='23514';
  END IF;
END $$;

-- Keep the historical calendar path and errors for v1 and v2.
CREATE FUNCTION mock_platform.legacy_runtime_calendar(candidate mock_platform."Runtime", config JSONB)
RETURNS VOID LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE start_at TIMESTAMP; days INTEGER; offset_days INTEGER;
BEGIN
  IF (config->>'profile' IN ('mature','growing','problematic','new') AND pg_catalog.jsonb_typeof(config->'days')='number'
      AND config->>'days' ~ '^[0-9]{1,3}$' AND config->>'historyStart' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T16:00:00.000Z$') IS NOT TRUE THEN
    RAISE EXCEPTION 'Invalid source snapshot' USING ERRCODE='23514';
  END IF;
  days:=(config->>'days')::integer; start_at:=(config->>'historyStart')::timestamp;
  offset_days:=CASE WHEN config->>'profile'='new' THEN greatest(0,days-14) ELSE 0 END;
  IF days NOT BETWEEN 1 AND 365 OR start_at<timestamp '0001-01-01' OR start_at+(days+5)*interval '1 day'>timestamp '9999-12-31 23:59:59.999'
    OR candidate."openingAt" IS DISTINCT FROM start_at+offset_days*interval '1 day'
    OR candidate."baselineEnd" IS DISTINCT FROM start_at+days*interval '1 day' THEN
    RAISE EXCEPTION 'Invalid source calendar' USING ERRCODE='23514';
  END IF;
END $$;

-- The authoritative lookup still takes place after the shared source-control lock.
CREATE OR REPLACE FUNCTION mock_platform.validate_runtime_insert() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE config JSONB; allowed BOOLEAN;
BEGIN
  IF NEW."sessionId" IS DISTINCT FROM pg_catalog.current_setting('demo.control_session_id',true) THEN
    RAISE EXCEPTION 'Invalid source control protocol' USING ERRCODE='SM002';
  END IF;
  PERFORM demo.lock_source_control(NEW."sessionId");
  SELECT mock_platform.has_worker_access(NEW."organizationId",NEW."workspaceId",NEW."storeId",NEW."sessionId",NEW."connectionId",NEW."externalStoreId",NEW.generation) INTO allowed;
  IF allowed IS NOT TRUE THEN
    RAISE EXCEPTION 'Source control access denied' USING ERRCODE='SM001';
  END IF;
  SELECT d.config INTO config FROM demo."DemoCommerceSession" d
    WHERE d.id=NEW."sessionId" AND d.config=NEW."sourceConfig" AND d."configHash"=NEW."configHash" AND d."generatorVersion"=NEW."generatorVersion";
  IF config IS NULL OR pg_catalog.octet_length(config::text)>1000000 THEN
    RAISE EXCEPTION 'Invalid source snapshot' USING ERRCODE='23514';
  END IF;
  CASE NEW."generatorVersion"
    WHEN 'mock-source-v3' THEN PERFORM mock_platform.observed_runtime_calendar(NEW,config);
    WHEN 'mock-source-v2','mock-source-v1' THEN PERFORM mock_platform.legacy_runtime_calendar(NEW,config);
    ELSE RAISE EXCEPTION 'Invalid source snapshot' USING ERRCODE='23514';
  END CASE;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION mock_platform.observed_config_fields(JSONB,TEXT[]),
  mock_platform.observed_config_integer(JSONB,INTEGER,BIGINT),mock_platform.observed_config_delivery(JSONB),
  mock_platform.observed_config_mutation(JSONB,INTEGER),mock_platform.observed_config_scenario(JSONB,TEXT,INTEGER,INTEGER),
  mock_platform.observed_config_properties(JSONB,TEXT[]),mock_platform.observed_config_scenario_json(JSONB),
  mock_platform.observed_config_json(JSONB),mock_platform.observed_config_shape(JSONB,JSONB),
  mock_platform.observed_runtime_calendar(mock_platform."Runtime",JSONB),
  mock_platform.legacy_runtime_calendar(mock_platform."Runtime",JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mock_platform.observed_config_fields(JSONB,TEXT[]),
  mock_platform.observed_config_integer(JSONB,INTEGER,BIGINT),mock_platform.observed_config_delivery(JSONB),
  mock_platform.observed_config_mutation(JSONB,INTEGER),mock_platform.observed_config_scenario(JSONB,TEXT,INTEGER,INTEGER),
  mock_platform.observed_config_properties(JSONB,TEXT[]),mock_platform.observed_config_scenario_json(JSONB),
  mock_platform.observed_config_json(JSONB),mock_platform.observed_config_shape(JSONB,JSONB),
  mock_platform.observed_runtime_calendar(mock_platform."Runtime",JSONB),
  mock_platform.legacy_runtime_calendar(mock_platform."Runtime",JSONB) TO shopmate_mock_source_worker;

ALTER TABLE mock_platform."Runtime" DROP CONSTRAINT "Runtime_generatorVersion_check";
ALTER TABLE mock_platform."Runtime" ADD CONSTRAINT "Runtime_generatorVersion_check" CHECK ((
  ("generatorVersion"='mock-source-v1' AND NOT ("sourceConfig" ? 'scenarioPlan')) OR
  ("generatorVersion"='mock-source-v2' AND jsonb_typeof("sourceConfig"->'scenarioPlan')='object'
    AND "sourceConfig"->'scenarioPlan'->>'version'='mock-scenario-v1'
    AND "sourceConfig"->'scenarioPlan'->>'externalStoreId'="externalStoreId") OR
  ("generatorVersion"='mock-source-v3' AND "sourceConfig"->>'modelVersion'='mock-business-observed-v1'
    AND ("sourceConfig" ? 'scenarioPlan'))
) IS TRUE);
ALTER TABLE mock_platform."BuildJob" DROP CONSTRAINT "BuildJob_generatorVersion_check";
ALTER TABLE mock_platform."BuildJob" ADD CONSTRAINT "BuildJob_generatorVersion_check"
  CHECK ("generatorVersion" IN ('mock-source-v1','mock-source-v2','mock-source-v3'));

COMMIT;

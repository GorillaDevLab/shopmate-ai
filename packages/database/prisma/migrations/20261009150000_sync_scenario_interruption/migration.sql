BEGIN;
CREATE FUNCTION sync_host.scenario_interrupt_rule(descriptor JSONB) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE run demo."DemoScenarioRun"; duration_ms BIGINT; expires TIMESTAMP;
BEGIN
 IF descriptor->>'state'<>'READY' OR descriptor->>'generatorVersion'<>'mock-source-v2' THEN RETURN NULL; END IF;
 SELECT * INTO run FROM demo."DemoScenarioRun" r WHERE
  (r."organizationId",r."workspaceId",r."storeId",r."sessionId",r."connectionId",r."externalStoreId",r.generation)
  =(descriptor->'scope'->>'organizationId',descriptor->'scope'->>'workspaceId',descriptor->'scope'->>'storeId',
    descriptor->'scope'->>'sessionId',descriptor->'scope'->>'connectionId',descriptor->'scope'->>'externalStoreId',
    (descriptor->'scope'->>'generation')::integer)
  AND r."configHash"=descriptor->>'configHash' AND r.config=descriptor->'config';
 IF run.id IS NULL OR run.config->'scenarioPlan'->'delivery'->>'kind'<>'INTERRUPT' THEN RETURN NULL; END IF;
 IF (run.config->'scenarioPlan'->'delivery'->>'durationMs') !~ '^[0-9]{1,8}$' THEN
  RAISE EXCEPTION 'SYNC_DELIVERY_POLICY_INVALID' USING ERRCODE='23514'; END IF;
 duration_ms:=(run.config->'scenarioPlan'->'delivery'->>'durationMs')::bigint;
 IF duration_ms IS NULL OR duration_ms NOT BETWEEN 1 AND 86400000 THEN
  RAISE EXCEPTION 'SYNC_DELIVERY_POLICY_INVALID' USING ERRCODE='23514'; END IF;
 expires:=run."businessClock"+duration_ms*interval '1 millisecond';
 IF expires<=(descriptor->>'businessNow')::timestamptz AT TIME ZONE 'UTC' THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('id','scenario-interrupt:'||encode(sha256(convert_to(run.id,'UTF8')),'hex'),'priority',1000,
  'startsAt',to_char(run."businessClock",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'endsAt',to_char(expires,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'methods',jsonb_build_array('listProducts','listOrders','listRefunds','getInventory','getMarketingMetrics'),
  'effect',jsonb_build_object('kind','FAIL','code','TEMPORARY','retryAfterMs',NULL));
END $$;
-- New LOAD creates a fresh generation: reserve one of 32 slots and priority 1000 for its interruption.
-- Existing management IDs remain intact; the generated namespace can never collide with newly managed IDs.
CREATE FUNCTION demo.reserve_scenario_failure_rule() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE session demo."DemoCommerceSession";
BEGIN
 IF NEW.id LIKE 'scenario-interrupt:%' THEN
  RAISE EXCEPTION 'Reserved scenario rule namespace' USING ERRCODE='23514'; END IF;
 SELECT * INTO session FROM demo."DemoCommerceSession" WHERE id=NEW."sessionId";
 IF session."generatorVersion"='mock-source-v2' AND EXISTS (
  SELECT 1 FROM demo."DemoScenarioRun" r WHERE
   (r."organizationId",r."workspaceId",r."storeId",r."sessionId",r."connectionId",r."externalStoreId",r.generation)
   =(NEW."organizationId",NEW."workspaceId",NEW."storeId",NEW."sessionId",NEW."connectionId",NEW."externalStoreId",NEW.generation)
   AND r."configHash"=session."configHash" AND r.config=session.config AND r.config->'scenarioPlan'->'delivery'->>'kind'='INTERRUPT')
  AND (NEW.priority=1000 OR (SELECT count(*) FROM demo."DemoFailureRule" r WHERE r."sessionId"=NEW."sessionId"
   AND r.generation=NEW.generation AND r."removedRevision" IS NULL AND r."endsAt">session."clockNow")>=31) THEN
  RAISE EXCEPTION 'Scenario interruption reserves one rule slot and priority 1000' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER failure_scenario_capacity BEFORE INSERT ON demo."DemoFailureRule"
 FOR EACH ROW EXECUTE FUNCTION demo.reserve_scenario_failure_rule();
CREATE OR REPLACE FUNCTION sync_host.runtime_failure_rules(requested_grant TEXT) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE descriptor JSONB; after_read JSONB; rules JSONB; interruption JSONB;
BEGIN
 descriptor:=sync_host.runtime_bootstrap(requested_grant);
 IF descriptor IS NULL THEN RETURN NULL; END IF;
 SELECT coalesce(jsonb_agg(rule ORDER BY priority DESC,id),'[]'::jsonb) INTO rules FROM (
  SELECT r.id,r.priority,jsonb_build_object('id',r.id,'priority',r.priority,
   'startsAt',to_char(r."startsAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'endsAt',to_char(r."endsAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'methods',r.methods,
   'effect',CASE WHEN r."effectKind"='FAIL' THEN jsonb_build_object('kind','FAIL','code',r."effectCode",'retryAfterMs',r."retryAfterMs")
    ELSE jsonb_build_object('kind','DELAY','delayMs',r."delayMs") END) AS rule
  FROM demo."DemoFailureRule" r WHERE
   (r."organizationId",r."workspaceId",r."storeId",r."sessionId",r."connectionId",r."externalStoreId",r.generation)
    =(descriptor->'scope'->>'organizationId',descriptor->'scope'->>'workspaceId',descriptor->'scope'->>'storeId',
      descriptor->'scope'->>'sessionId',descriptor->'scope'->>'connectionId',descriptor->'scope'->>'externalStoreId',
      (descriptor->'scope'->>'generation')::integer)
   AND r."removedRevision" IS NULL AND r."endsAt">(descriptor->>'businessNow')::timestamptz AT TIME ZONE 'UTC'
  ORDER BY r.priority DESC,r.id LIMIT 33
 ) active_rules;
 interruption:=sync_host.scenario_interrupt_rule(descriptor);
 IF interruption IS NOT NULL THEN rules:=jsonb_build_array(interruption)||rules; END IF;
 -- Overflow is explicit; no managed rule or active interruption is silently dropped.
 IF jsonb_array_length(rules)>32 THEN RAISE EXCEPTION 'SYNC_FAILURE_RULE_CAPACITY' USING ERRCODE='23514'; END IF;
 after_read:=sync_host.bootstrap_descriptor(requested_grant);
 IF after_read IS NULL OR after_read IS DISTINCT FROM descriptor THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('context',after_read,'rules',rules);
END $$;
REVOKE ALL ON FUNCTION sync_host.scenario_interrupt_rule(JSONB),demo.reserve_scenario_failure_rule() FROM PUBLIC;
COMMIT;

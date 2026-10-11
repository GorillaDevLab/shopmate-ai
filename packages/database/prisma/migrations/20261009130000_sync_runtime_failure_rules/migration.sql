BEGIN;
-- Read-only guarded metadata bridge; workers receive no direct demo table privileges.
CREATE FUNCTION sync_host.runtime_failure_rules(requested_grant TEXT) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE descriptor JSONB; after_read JSONB; rules JSONB;
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
   AND r."removedRevision" IS NULL AND r."endsAt">(descriptor->>'businessNow')::timestamp
  ORDER BY r.priority DESC,r.id LIMIT 33
 ) active_rules;
 -- The control lock stays held; a fresh descriptor also fences membership/grant revocation.
 after_read:=sync_host.bootstrap_descriptor(requested_grant);
 IF after_read IS NULL OR after_read IS DISTINCT FROM descriptor THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('context',after_read,'rules',rules);
END $$;
REVOKE ALL ON FUNCTION sync_host.runtime_failure_rules(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sync_host.runtime_failure_rules(TEXT) TO shopmate_sync_worker;
COMMIT;

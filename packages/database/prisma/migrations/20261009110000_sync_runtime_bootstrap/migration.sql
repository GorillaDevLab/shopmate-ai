BEGIN;
-- Private lookup runs only as the guarded RPC's owner; no broad table grant reaches workers.
CREATE FUNCTION sync_host.bootstrap_descriptor(requested_grant TEXT) RETURNS JSONB
LANGUAGE SQL VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
  'grantId',g.id,'principalUserId',g."principalUserId",'merchantId',s."merchantId",'provider',g.provider,
  'scope',jsonb_build_object('organizationId',g."organizationId",'workspaceId',g."workspaceId",'storeId',g."storeId",
   'connectionId',g."connectionId",'externalStoreId',g."externalStoreId",'sessionId',d.id,'generation',g.generation),
  'initialSince',to_char(g."initialSince",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'businessNow',to_char(d."clockNow",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'clockRevision',d."clockRevision",'sessionRevision',d.revision,'config',d.config,'configHash',d."configHash",'generatorVersion',d."generatorVersion",
  'runtimeOpening',to_char(r."openingAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'state',CASE WHEN r."sessionId" IS NULL THEN 'WAITING_RUNTIME' ELSE 'READY' END)
 FROM sync_host."WorkerGrant" g JOIN public."Store" s ON s.id=g."storeId"
 JOIN demo."DemoCommerceSession" d ON (d."organizationId",d."workspaceId",d."storeId",d."connectionId",d."externalStoreId")
  =(g."organizationId",g."workspaceId",g."storeId",g."connectionId",g."externalStoreId")
 LEFT JOIN mock_platform."Runtime" r ON (r."sessionId",r.generation,r."organizationId",r."workspaceId",r."storeId",r."connectionId",r."externalStoreId")
  =(d.id,g.generation,g."organizationId",g."workspaceId",g."storeId",g."connectionId",g."externalStoreId")
  AND r."sourceConfig"=d.config AND r."configHash"=d."configHash" AND r."generatorVersion"=d."generatorVersion"
 WHERE g.id=requested_grant AND g."databaseRole"=session_user AND g.status='ACTIVE' AND g.provider='MOCK'
  AND sync_host.safe_login(session_user)
  AND sync_host.authorized(g."principalUserId",g."organizationId",g."workspaceId",g."storeId",g."connectionId",g."externalStoreId",g.provider,g.generation)
  AND EXISTS (SELECT 1 FROM public."DemoTenant" t WHERE t."organizationId"=g."organizationId")
  AND EXISTS (SELECT 1 FROM public."TenantBootstrapEnvironment" e WHERE e.id='singleton' AND e.environment='DEMO')
$$;
REVOKE ALL ON FUNCTION sync_host.bootstrap_descriptor(TEXT) FROM PUBLIC;

CREATE FUNCTION sync_host.runtime_bootstrap(requested_grant TEXT) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE descriptor JSONB;
BEGIN
 IF requested_grant IS NULL OR requested_grant !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
  OR NOT sync_host.safe_login(session_user)
  OR current_setting('role') NOT IN ('none',session_user)
  OR current_setting('transaction_isolation')<>'read committed' THEN RETURN NULL; END IF;
 descriptor:=sync_host.bootstrap_descriptor(requested_grant);
 IF descriptor IS NULL THEN RETURN NULL; END IF;
 PERFORM set_config('lock_timeout','5s',true);
 PERFORM demo.lock_source_control(descriptor->'scope'->>'sessionId');
 -- VOLATILE performs a fresh lookup after lock waits instead of reusing the outer SQL snapshot.
 RETURN sync_host.bootstrap_descriptor(requested_grant);
END $$;
REVOKE ALL ON FUNCTION sync_host.runtime_bootstrap(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sync_host.runtime_bootstrap(TEXT) TO shopmate_sync_worker;
COMMIT;

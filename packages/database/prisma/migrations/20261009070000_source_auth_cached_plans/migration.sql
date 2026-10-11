-- Cache SQL execution plans per backend; every call still evaluates live RLS and actor settings.
-- CREATE OR REPLACE preserves function ownership and existing EXECUTE privileges.
BEGIN;

CREATE OR REPLACE FUNCTION demo.has_store_access(org_id TEXT, workspace_id TEXT, store_id TEXT, writable BOOLEAN)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog,public,demo AS $$
BEGIN
  RETURN (SELECT EXISTS (
    SELECT 1 FROM public."Store" s
    JOIN public."Organization" o ON o.id=s."organizationId" AND o."legacyMerchantId"=s."merchantId"
    JOIN public."Workspace" w ON w.id=s."workspaceId" AND w."organizationId"=o.id
    JOIN public."OrganizationMember" m ON m."organizationId"=o.id
    JOIN public."DemoTenant" d ON d."organizationId"=o.id
    JOIN public."TenantBootstrapEnvironment" e ON e.id='singleton' AND e.environment='DEMO'
    WHERE s.id=store_id AND o.id=org_id AND w.id=workspace_id
      AND m."userId"=current_setting('app.user_id',true)
      AND m.status='ACTIVE' AND o.status='ACTIVE' AND w.status='ACTIVE'
      AND (NOT writable OR m.role IN ('OWNER','ADMIN'))
      AND (m.role IN ('OWNER','ADMIN') OR EXISTS (
        SELECT 1 FROM public."WorkspaceMember" wm WHERE wm."organizationId"=o.id
          AND wm."workspaceId"=w.id AND wm."userId"=m."userId" AND wm.status='ACTIVE'))
  ));
END
$$;

CREATE OR REPLACE FUNCTION mock_platform.has_current_access(org_id TEXT, workspace_id TEXT, store_id TEXT, session_id TEXT, connection_id TEXT, external_id TEXT, current_generation INTEGER)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  RETURN (SELECT demo.has_store_access(org_id,workspace_id,store_id,false) AND EXISTS (
    SELECT 1 FROM public."Store" s JOIN demo."DemoCommerceSession" d ON d."storeId"=s.id
    JOIN public."PlatformConnection" c ON c.id=d."connectionId"
    WHERE s.id=store_id AND s."merchantId"=current_setting('app.merchant_id',true)
      AND d.id=session_id AND d."organizationId"=org_id AND d."workspaceId"=workspace_id
      AND d."connectionId"=connection_id AND d."externalStoreId"=external_id
      AND c."organizationId"=org_id AND c."workspaceId"=workspace_id AND c."storeId"=store_id
      AND c."externalStoreId"=external_id AND c.provider='MOCK' AND c.status='ACTIVE' AND c.generation=current_generation
  ));
END
$$;

CREATE OR REPLACE FUNCTION mock_platform.has_worker_access(org_id TEXT, workspace_id TEXT, store_id TEXT, session_id TEXT, connection_id TEXT, external_id TEXT, current_generation INTEGER)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  RETURN (SELECT mock_platform.has_current_access(org_id,workspace_id,store_id,session_id,connection_id,external_id,current_generation)
    AND EXISTS (
      SELECT 1 FROM demo."MockWorkerGrant" g
      JOIN public."OrganizationMember" m ON m."organizationId"=g."organizationId" AND m."userId"=g."principalUserId"
      JOIN public."WorkspaceMember" w ON w."organizationId"=g."organizationId" AND w."workspaceId"=g."workspaceId" AND w."userId"=g."principalUserId"
      WHERE g.id=current_setting('mock.grant_id',true) AND g."databaseRole"=session_user AND g."databaseRole"=current_user
        AND g.status='ACTIVE' AND g.operation='SOURCE_BUILD' AND g."principalUserId"=current_setting('app.user_id',true)
        AND g."organizationId"=org_id AND g."workspaceId"=workspace_id AND g."storeId"=store_id AND g."sessionId"=session_id
        AND g."connectionId"=connection_id AND g."externalStoreId"=external_id
        AND m.status='ACTIVE' AND m.role='VIEWER' AND w.status='ACTIVE'
    ));
END
$$;

COMMIT;

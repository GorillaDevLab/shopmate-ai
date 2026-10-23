BEGIN;
-- A retained binding alone cannot authorize a snapshot from a reset source generation.
CREATE FUNCTION public.metric_source_revision_current(org_ TEXT, workspace_ TEXT, store_ TEXT, connection_ TEXT, external_ TEXT, revision_ TEXT)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS (
  SELECT 1 FROM public.metric_source_bundles b
  JOIN commerce."SourceScope" s ON s.id=b."scopeId"
  WHERE b."inputRevision"=revision_
   AND (b."organizationId",b."workspaceId",b."storeId")=(org_,workspace_,store_)
   AND (s."organizationId",s."workspaceId",s."storeId",s."connectionId",s."externalStoreId")
    =(org_,workspace_,store_,connection_,external_)
   AND public.metric_source_authorized(s))
$$;
ALTER FUNCTION public.metric_source_revision_current(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION public.metric_source_revision_current(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.metric_source_revision_current(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) TO shopmate_metric_source;
-- Restrictive AND composition preserves P15 membership and generic capability contracts.
CREATE POLICY metric_snapshots_current_source ON public.metric_snapshots AS RESTRICTIVE
 FOR SELECT TO shopmate_metric_source
 USING (public.metric_source_revision_current("organizationId","workspaceId","storeId","connectionId","externalStoreId","inputRevision"));
COMMIT;

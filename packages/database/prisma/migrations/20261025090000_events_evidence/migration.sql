-- Forward-only event/evidence storage. No application login or credential grants.
BEGIN;
CREATE TABLE public.events (
  id TEXT COLLATE "C" NOT NULL,
  "organizationId" TEXT COLLATE "C" NOT NULL,
  "workspaceId" TEXT COLLATE "C" NOT NULL,
  "storeId" TEXT COLLATE "C" NOT NULL,
  "connectionId" TEXT COLLATE "C" NOT NULL,
  "externalStoreId" TEXT COLLATE "C" NOT NULL,
  "schemaVersion" INTEGER NOT NULL,
  "eventType" TEXT COLLATE "C" NOT NULL,
  "entityKind" TEXT COLLATE "C" NOT NULL,
  "entityId" TEXT COLLATE "C" NOT NULL,
  "baselineVersion" TEXT COLLATE "C",
  fingerprint TEXT COLLATE "C" NOT NULL,
  "severityFloor" TEXT COLLATE "C" NOT NULL,
  "rulePolicyVersion" TEXT COLLATE "C" NOT NULL,
  state TEXT COLLATE "C" NOT NULL,
  revision BIGINT NOT NULL,
  "firstSeenAt" TIMESTAMPTZ(3) NOT NULL,
  "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
  "currentEvidenceId" TEXT COLLATE "C" NOT NULL,
  "currentEvidenceVersion" TEXT COLLATE "C" NOT NULL,
  "currentEvidenceHash" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT events_pkey PRIMARY KEY (id)
);
CREATE TABLE public.event_evidence (
  id TEXT COLLATE "C" NOT NULL,
  "eventId" TEXT COLLATE "C" NOT NULL,
  "organizationId" TEXT COLLATE "C" NOT NULL,
  "workspaceId" TEXT COLLATE "C" NOT NULL,
  "storeId" TEXT COLLATE "C" NOT NULL,
  "connectionId" TEXT COLLATE "C" NOT NULL,
  "externalStoreId" TEXT COLLATE "C" NOT NULL,
  "evidenceRevision" BIGINT NOT NULL,
  "schemaVersion" INTEGER NOT NULL,
  fingerprint TEXT COLLATE "C" NOT NULL,
  version TEXT COLLATE "C" NOT NULL,
  hash TEXT COLLATE "C" NOT NULL,
  "definitionVersion" TEXT COLLATE "C" NOT NULL,
  "periodStart" TIMESTAMPTZ(3) NOT NULL,
  "periodEnd" TIMESTAMPTZ(3) NOT NULL,
  "observedAt" TIMESTAMPTZ(3) NOT NULL,
  "sourceWatermark" TIMESTAMPTZ(3),
  timezone TEXT COLLATE "C" NOT NULL,
  currency TEXT COLLATE "C" NOT NULL,
  "dataStatus" TEXT COLLATE "C" NOT NULL,
  "sampleSize" BIGINT NOT NULL,
  "coverageBasisPoints" INTEGER NOT NULL,
  issues JSONB NOT NULL,
  payload JSONB NOT NULL,
  CONSTRAINT event_evidence_pkey PRIMARY KEY (id)
);
CREATE TABLE public.event_evidence_metrics (
  "evidenceId" TEXT COLLATE "C" NOT NULL,
  "metricSnapshotId" UUID NOT NULL,
  "organizationId" TEXT COLLATE "C" NOT NULL,
  "workspaceId" TEXT COLLATE "C" NOT NULL,
  "storeId" TEXT COLLATE "C" NOT NULL,
  "connectionId" TEXT COLLATE "C" NOT NULL,
  "externalStoreId" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT event_evidence_metrics_pkey PRIMARY KEY ("evidenceId","metricSnapshotId")
);
CREATE UNIQUE INDEX events_scope_identity_key ON public.events
  (id,"organizationId","workspaceId","storeId","connectionId","externalStoreId",fingerprint);
-- Canonical fingerprint includes org/workspace/store/type/entity/baseline, intentionally not connection.
CREATE UNIQUE INDEX events_active_fingerprint_key ON public.events (fingerprint)
  WHERE state IN ('OPEN','ACKNOWLEDGED','SUPPRESSED');
CREATE INDEX events_scope_history_idx ON public.events ("organizationId","workspaceId","storeId","lastSeenAt",id);
CREATE UNIQUE INDEX event_evidence_event_revision_key ON public.event_evidence ("eventId","evidenceRevision");
CREATE UNIQUE INDEX event_evidence_scope_key ON public.event_evidence
  (id,"organizationId","workspaceId","storeId","connectionId","externalStoreId");
CREATE UNIQUE INDEX event_evidence_reference_key ON public.event_evidence
  (id,"eventId","organizationId","workspaceId","storeId","connectionId","externalStoreId",fingerprint,version,hash);
CREATE UNIQUE INDEX metric_snapshots_event_scope_key ON public.metric_snapshots
  (id,"organizationId","workspaceId","storeId","connectionId","externalStoreId");
ALTER TABLE public.events
  ADD CONSTRAINT events_store_fkey FOREIGN KEY ("organizationId","workspaceId","storeId")
    REFERENCES public."Store"("organizationId","workspaceId",id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT events_connection_fkey FOREIGN KEY ("connectionId","organizationId","workspaceId","storeId","externalStoreId")
    REFERENCES public."PlatformConnection"(id,"organizationId","workspaceId","storeId","externalStoreId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT events_current_evidence_fkey FOREIGN KEY ("currentEvidenceId",id,"organizationId","workspaceId","storeId","connectionId","externalStoreId",fingerprint,"currentEvidenceVersion","currentEvidenceHash")
    REFERENCES public.event_evidence(id,"eventId","organizationId","workspaceId","storeId","connectionId","externalStoreId",fingerprint,version,hash)
    ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.event_evidence
  ADD CONSTRAINT event_evidence_event_fkey FOREIGN KEY ("eventId","organizationId","workspaceId","storeId","connectionId","externalStoreId",fingerprint)
    REFERENCES public.events(id,"organizationId","workspaceId","storeId","connectionId","externalStoreId",fingerprint)
    ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.event_evidence_metrics
  ADD CONSTRAINT event_evidence_metrics_evidence_fkey FOREIGN KEY ("evidenceId","organizationId","workspaceId","storeId","connectionId","externalStoreId")
    REFERENCES public.event_evidence(id,"organizationId","workspaceId","storeId","connectionId","externalStoreId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT event_evidence_metrics_metric_fkey FOREIGN KEY ("metricSnapshotId","organizationId","workspaceId","storeId","connectionId","externalStoreId")
    REFERENCES public.metric_snapshots(id,"organizationId","workspaceId","storeId","connectionId","externalStoreId") ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE FUNCTION public.event_identity_valid(row_ public.events) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT (row_."eventType" IN ('STOCKOUT_RISK','INVENTORY_STAGNATION','REFUND_SPIKE','CANCELLED_ORDER_SPIKE',
    'PROFIT_MARGIN_DROP','UNUSUAL_DISCOUNT','ROAS_DROP','AD_SPEND_SPIKE','CONVERSION_DROP','PRODUCT_BREAKOUT','SYNC_FAILURE','REVENUE_DROP')
    AND CASE WHEN row_."eventType" IN ('STOCKOUT_RISK','INVENTORY_STAGNATION','PRODUCT_BREAKOUT') THEN row_."entityKind"='SKU'
      WHEN row_."eventType" IN ('ROAS_DROP','AD_SPEND_SPIKE') THEN row_."entityKind"='CAMPAIGN'
      WHEN row_."eventType"='SYNC_FAILURE' THEN row_."entityKind"='CONNECTION' AND row_."entityId"=row_."connectionId"
      ELSE row_."entityKind" IN ('STORE','SKU') END
    AND public.metric_literal(row_."entityId")
    AND (row_."entityKind"<>'STORE' OR row_."entityId"=row_."storeId")
    AND (row_."baselineVersion" IS NULL OR public.metric_literal(row_."baselineVersion"))
    AND length(row_.fingerprint)<=4096
    AND row_.fingerprint=array_to_json(ARRAY['event-fingerprint-v1',row_."organizationId",row_."workspaceId",row_."storeId",
      row_."eventType",row_."entityKind",row_."entityId",row_."baselineVersion"])::text
    AND (row_."eventType"<>'PRODUCT_BREAKOUT' OR row_."severityFloor" IN ('INFO','LOW'))) IS TRUE
$$;
CREATE FUNCTION public.event_issues_valid(issues_ JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE issue_ JSONB; allowed_ TEXT[];
BEGIN
  IF jsonb_typeof(issues_)<>'array' THEN RETURN false; END IF;
  IF jsonb_array_length(issues_)>100 THEN RETURN false; END IF;
  FOR issue_ IN SELECT value FROM jsonb_array_elements(issues_) LOOP
    IF jsonb_typeof(issue_->'evidenceIds') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    SELECT array_agg(value) INTO allowed_ FROM jsonb_array_elements_text(issue_->'evidenceIds');
    IF public.metric_issue_valid(issue_,allowed_) IS NOT TRUE THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END
$$;
CREATE FUNCTION public.event_payload_valid(row_ public.event_evidence) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE p_ JSONB := row_.payload; identity_ JSONB := row_.fingerprint::jsonb; entity_ JSONB;
BEGIN
  entity_ := CASE identity_->>5 WHEN 'STORE' THEN jsonb_build_object('kind','STORE')
    WHEN 'SKU' THEN jsonb_build_object('kind','SKU','externalSkuId',identity_->>6)
    WHEN 'CAMPAIGN' THEN jsonb_build_object('kind','CAMPAIGN','externalCampaignId',identity_->>6)
    WHEN 'CONNECTION' THEN jsonb_build_object('kind','CONNECTION','connectionId',identity_->>6) END;
  RETURN (jsonb_typeof(p_)='object' AND jsonb_typeof(p_->'facts')='object' AND p_->'issues'=row_.issues
    AND p_ ?& ARRAY['schemaVersion','binding','eventType','entity','definitionVersion','baselineVersion','periodStart','periodEnd',
      'observedAt','sourceWatermark','timezone','currency','dataStatus','sampleSize','coverageBasisPoints','issues','baselineAlignment','baseline','sourceReferences','facts']
    AND p_-ARRAY['schemaVersion','binding','eventType','entity','definitionVersion','baselineVersion','periodStart','periodEnd',
      'observedAt','sourceWatermark','timezone','currency','dataStatus','sampleSize','coverageBasisPoints','issues','baselineAlignment','baseline','sourceReferences','facts']='{}'::jsonb
    AND p_ @> jsonb_build_object('schemaVersion',row_."schemaVersion",'eventType',identity_->>4,'entity',entity_,
      'binding',jsonb_build_object('organizationId',row_."organizationId",'workspaceId',row_."workspaceId",'storeId',row_."storeId",'connectionId',row_."connectionId",'externalStoreId',row_."externalStoreId"),
      'definitionVersion',row_."definitionVersion",'baselineVersion',identity_->7,'timezone',row_.timezone,'currency',row_.currency,
      'dataStatus',row_."dataStatus",'sampleSize',row_."sampleSize",'coverageBasisPoints',row_."coverageBasisPoints",'issues',row_.issues)
    AND (p_->>'periodStart')::timestamptz=row_."periodStart" AND (p_->>'periodEnd')::timestamptz=row_."periodEnd"
    AND (p_->>'observedAt')::timestamptz=row_."observedAt"
    AND ((p_->>'sourceWatermark')::timestamptz IS NOT DISTINCT FROM row_."sourceWatermark")
    AND CASE WHEN p_->'baseline'='null'::jsonb THEN p_->'baselineVersion'='null'::jsonb AND p_->>'baselineAlignment'='MISSING'
      ELSE jsonb_typeof(p_->'baseline')='object' AND p_->>'baselineVersion'=p_->'baseline'->>'version'
        AND p_->>'baselineAlignment'=p_->'baseline'->>'alignment' AND p_->>'baselineAlignment' IN ('ALIGNED','MISSING','UNALIGNED') END
    AND public.event_sources_valid(p_->'sourceReferences',row_)) IS TRUE;
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END
$$;
CREATE FUNCTION public.event_sources_valid(refs_ JSONB, row_ public.event_evidence) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE ref_ JSONB; binding_ JSONB;
BEGIN
  IF jsonb_typeof(refs_)<>'array' THEN RETURN false; END IF;
  IF jsonb_array_length(refs_) NOT BETWEEN 1 AND 200 THEN RETURN false; END IF;
  binding_ := jsonb_build_object('organizationId',row_."organizationId",'workspaceId',row_."workspaceId",'storeId',row_."storeId",'connectionId',row_."connectionId",'externalStoreId',row_."externalStoreId");
  FOR ref_ IN SELECT value FROM jsonb_array_elements(refs_) LOOP
    IF (jsonb_typeof(ref_)='object' AND ref_->'binding'=binding_ AND ref_->>'definitionVersion'=row_."definitionVersion"
      AND ref_->>'kind' IN ('METRIC_SNAPSHOT','NORMALIZED_AGGREGATE') AND public.metric_literal(ref_->>'id')
      AND public.metric_literal(ref_->>'version') AND public.metric_literal(ref_->>'hash')
      AND (ref_->>'observedAt')::timestamptz BETWEEN row_."periodEnd" AND row_."observedAt"
      AND (ref_->'period'->>'periodStart')::timestamptz=row_."periodStart"
      AND (ref_->'period'->>'periodEnd')::timestamptz=row_."periodEnd"
      AND ref_->'period'->>'timezone'=row_.timezone AND ref_->'period'->>'currency'=row_.currency
      AND (ref_->>'kind'<>'METRIC_SNAPSHOT' OR jsonb_typeof(ref_->'measure')='object')) IS NOT TRUE THEN RETURN false; END IF;
  END LOOP;
  RETURN (SELECT count(*)=count(DISTINCT jsonb_build_array(r->>'kind',r->>'id',r->>'version')) FROM jsonb_array_elements(refs_) r);
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END
$$;
ALTER TABLE public.events
  ADD CONSTRAINT events_identity_check CHECK (public.event_identity_valid(events) IS TRUE),
  ADD CONSTRAINT events_envelope_check CHECK ("schemaVersion"=1 AND public.metric_literal(id) IS TRUE
    AND public.metric_literal("rulePolicyVersion") IS TRUE AND public.metric_literal("currentEvidenceId") IS TRUE
    AND public.metric_literal("currentEvidenceVersion") IS TRUE AND public.metric_literal("currentEvidenceHash") IS TRUE
    AND "severityFloor" IN ('INFO','LOW','MEDIUM','HIGH','CRITICAL')
    AND state IN ('OPEN','ACKNOWLEDGED','RESOLVED','SUPPRESSED') AND revision BETWEEN 1 AND 9007199254740991),
  ADD CONSTRAINT events_time_check CHECK (public.metric_time_valid("firstSeenAt") IS TRUE
    AND public.metric_time_valid("lastSeenAt") IS TRUE AND "firstSeenAt"<="lastSeenAt");
ALTER TABLE public.event_evidence
  ADD CONSTRAINT event_evidence_envelope_check CHECK ("schemaVersion"=1
    AND public.metric_literal(id) IS TRUE AND public.metric_literal(version) IS TRUE AND public.metric_literal(hash) IS TRUE
    AND public.metric_literal("definitionVersion") IS TRUE AND "evidenceRevision" BETWEEN 1 AND 9007199254740991
    AND jsonb_typeof(payload)='object' AND public.event_issues_valid(issues) IS TRUE AND public.event_payload_valid(event_evidence) IS TRUE),
  ADD CONSTRAINT event_evidence_time_check CHECK (timezone='Asia/Shanghai' AND currency='CNY'
    AND public.metric_time_valid("periodStart") IS TRUE AND public.metric_time_valid("periodEnd") IS TRUE
    AND public.metric_time_valid("observedAt") IS TRUE AND "periodStart"<"periodEnd" AND "periodEnd"<="observedAt"
    AND ("sourceWatermark" IS NULL OR (public.metric_time_valid("sourceWatermark") IS TRUE AND "sourceWatermark"<="observedAt"))),
  ADD CONSTRAINT event_evidence_quality_check CHECK (("sampleSize" BETWEEN 0 AND 9007199254740991
    AND "coverageBasisPoints" BETWEEN 0 AND 10000 AND "dataStatus" IN ('VERIFIED','ESTIMATED','INSUFFICIENT','STALE','UNAVAILABLE')
    AND CASE WHEN "dataStatus"='VERIFIED' THEN "coverageBasisPoints"=10000 AND issues='[]'::jsonb AND "sourceWatermark">="periodEnd"
      ELSE issues<>'[]'::jsonb END) IS TRUE);

DO $$
DECLARE name_ TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Event policy owner must bypass forced tenant RLS' USING ERRCODE='42501';
  END IF;
  FOREACH name_ IN ARRAY ARRAY['shopmate_event_reader','shopmate_event_writer'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=name_) THEN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=name_ AND
        (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
        RAISE EXCEPTION 'Unsafe existing event capability role' USING ERRCODE='42501';
      END IF;
    ELSE
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION',name_);
    END IF;
  END LOOP;
END
$$;
-- Deliberately separate from metric writes: assigned OPERATOR may manage events.
CREATE FUNCTION public.event_scope_access(org_ TEXT, workspace_ TEXT, store_ TEXT, connection_ TEXT, external_ TEXT, writable_ BOOLEAN)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT (current_setting('transaction_isolation')='read committed'
    AND org_=current_setting('app.organization_id',true) AND workspace_=current_setting('app.workspace_id',true)
    AND store_=current_setting('app.store_id',true) AND connection_=current_setting('app.connection_id',true)
    AND external_=current_setting('app.external_store_id',true)
    AND nullif(current_setting('app.user_id',true),'') IS NOT NULL
    AND EXISTS (SELECT 1 FROM public."Store" s
      JOIN public."Organization" o ON o.id=s."organizationId" AND o."legacyMerchantId"=s."merchantId"
      JOIN public."Workspace" w ON w.id=s."workspaceId" AND w."organizationId"=o.id
      JOIN public."OrganizationMember" m ON m."organizationId"=o.id
      JOIN public."PlatformConnection" c ON c.id=connection_ AND c."organizationId"=o.id AND c."workspaceId"=w.id
        AND c."storeId"=s.id AND c."externalStoreId"=external_
      WHERE s.id=store_ AND o.id=org_ AND w.id=workspace_ AND m."userId"=current_setting('app.user_id',true)
        AND m.status='ACTIVE' AND o.status='ACTIVE' AND w.status='ACTIVE'
        AND (NOT writable_ OR m.role IN ('OWNER','ADMIN','OPERATOR'))
        AND (m.role IN ('OWNER','ADMIN') OR EXISTS (SELECT 1 FROM public."WorkspaceMember" wm
          WHERE wm."organizationId"=o.id AND wm."workspaceId"=w.id AND wm."userId"=m."userId" AND wm.status='ACTIVE')))) IS TRUE
$$;
CREATE FUNCTION public.event_history_immutable() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Event evidence history is immutable; append a revision' USING ERRCODE='23514';
END
$$;
CREATE FUNCTION public.event_identity_immutable() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['state','revision','lastSeenAt','currentEvidenceId','currentEvidenceVersion','currentEvidenceHash'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revision','lastSeenAt','currentEvidenceId','currentEvidenceVersion','currentEvidenceHash'])
    OR NEW."lastSeenAt"<OLD."lastSeenAt" OR NEW.revision<OLD.revision THEN
    RAISE EXCEPTION 'Event identity and monotone history are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER events_identity_immutable BEFORE UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION public.event_identity_immutable();
CREATE TRIGGER events_no_delete BEFORE DELETE ON public.events FOR EACH STATEMENT EXECUTE FUNCTION public.event_history_immutable();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON public.events FOR EACH STATEMENT EXECUTE FUNCTION public.event_history_immutable();
CREATE TRIGGER event_evidence_immutable BEFORE UPDATE OR DELETE ON public.event_evidence FOR EACH STATEMENT EXECUTE FUNCTION public.event_history_immutable();
CREATE TRIGGER event_evidence_no_truncate BEFORE TRUNCATE ON public.event_evidence FOR EACH STATEMENT EXECUTE FUNCTION public.event_history_immutable();
CREATE TRIGGER event_evidence_metrics_immutable BEFORE UPDATE OR DELETE ON public.event_evidence_metrics FOR EACH STATEMENT EXECUTE FUNCTION public.event_history_immutable();
CREATE TRIGGER event_evidence_metrics_no_truncate BEFORE TRUNCATE ON public.event_evidence_metrics FOR EACH STATEMENT EXECUTE FUNCTION public.event_history_immutable();
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.event_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE public.event_evidence_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_evidence_metrics FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.events,public.event_evidence,public.event_evidence_metrics FROM PUBLIC,shopmate_event_reader,shopmate_event_writer;
GRANT USAGE ON SCHEMA public TO shopmate_event_reader,shopmate_event_writer;
GRANT SELECT ON public.events,public.event_evidence,public.event_evidence_metrics TO shopmate_event_reader,shopmate_event_writer;
GRANT INSERT ON public.events,public.event_evidence,public.event_evidence_metrics TO shopmate_event_writer;
GRANT UPDATE (state,revision,"lastSeenAt","currentEvidenceId","currentEvidenceVersion","currentEvidenceHash") ON public.events TO shopmate_event_writer;
REVOKE ALL ON FUNCTION public.event_scope_access(TEXT,TEXT,TEXT,TEXT,TEXT,BOOLEAN),public.event_identity_valid(public.events),
  public.event_issues_valid(JSONB),public.event_payload_valid(public.event_evidence),public.event_sources_valid(JSONB,public.event_evidence),
  public.event_history_immutable(),public.event_identity_immutable() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.event_scope_access(TEXT,TEXT,TEXT,TEXT,TEXT,BOOLEAN) TO shopmate_event_reader,shopmate_event_writer;
GRANT EXECUTE ON FUNCTION public.event_identity_valid(public.events),public.event_issues_valid(JSONB),public.event_payload_valid(public.event_evidence),
  public.event_sources_valid(JSONB,public.event_evidence),public.metric_literal(TEXT),
  public.metric_time_valid(TIMESTAMPTZ),public.metric_issue_valid(JSONB,TEXT[]),public.metric_issue_evidence(JSONB,TEXT[]),public.metric_evidence_valid(TEXT[]) TO shopmate_event_writer;
CREATE POLICY events_read ON public.events FOR SELECT TO shopmate_event_reader,shopmate_event_writer
  USING (public.event_scope_access("organizationId","workspaceId","storeId","connectionId","externalStoreId",false));
CREATE POLICY events_append ON public.events FOR INSERT TO shopmate_event_writer
  WITH CHECK (public.event_scope_access("organizationId","workspaceId","storeId","connectionId","externalStoreId",true));
CREATE POLICY events_manage ON public.events FOR UPDATE TO shopmate_event_writer
  USING (public.event_scope_access("organizationId","workspaceId","storeId","connectionId","externalStoreId",true))
  WITH CHECK (public.event_scope_access("organizationId","workspaceId","storeId","connectionId","externalStoreId",true));
CREATE POLICY event_evidence_read ON public.event_evidence FOR SELECT TO shopmate_event_reader,shopmate_event_writer
  USING (public.event_scope_access("organizationId","workspaceId","storeId","connectionId","externalStoreId",false));
CREATE POLICY event_evidence_append ON public.event_evidence FOR INSERT TO shopmate_event_writer
  WITH CHECK (public.event_scope_access("organizationId","workspaceId","storeId","connectionId","externalStoreId",true));
CREATE POLICY event_evidence_metrics_read ON public.event_evidence_metrics FOR SELECT TO shopmate_event_reader,shopmate_event_writer
  USING (public.event_scope_access("organizationId","workspaceId","storeId","connectionId","externalStoreId",false));
CREATE POLICY event_evidence_metrics_append ON public.event_evidence_metrics FOR INSERT TO shopmate_event_writer
  WITH CHECK (public.event_scope_access("organizationId","workspaceId","storeId","connectionId","externalStoreId",true));
COMMIT;

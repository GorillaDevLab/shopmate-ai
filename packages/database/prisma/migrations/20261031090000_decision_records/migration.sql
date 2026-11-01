-- Versioned immutable outcomes; no login, credentials or runtime wiring.
BEGIN;
CREATE TABLE public.decision_claims (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" TEXT COLLATE "C" NOT NULL,
  "workspaceId" TEXT COLLATE "C" NOT NULL,
  "storeId" TEXT COLLATE "C" NOT NULL,
  "connectionId" TEXT COLLATE "C" NOT NULL,
  "externalStoreId" TEXT COLLATE "C" NOT NULL,
  "eventId" TEXT COLLATE "C" NOT NULL,
  "eventRevision" BIGINT NOT NULL,
  fingerprint TEXT COLLATE "C" NOT NULL,
  "evidenceId" TEXT COLLATE "C" NOT NULL,
  "evidenceVersion" TEXT COLLATE "C" NOT NULL,
  "evidenceHash" TEXT COLLATE "C" NOT NULL,
  "decisionKey" TEXT COLLATE "C" NOT NULL,
  "claimToken" TEXT COLLATE "C" NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "winnerRunId" TEXT COLLATE "C",
  "winnerMode" TEXT COLLATE "C" NOT NULL DEFAULT 'PRIMARY',
  "winnerStatus" TEXT COLLATE "C" NOT NULL DEFAULT 'EVALUATED',
  CONSTRAINT decision_claims_pkey PRIMARY KEY (id),
  CONSTRAINT decision_claims_shape_check CHECK ((public.metric_literal("decisionKey") AND public.metric_literal("claimToken")
    AND "eventRevision" BETWEEN 1 AND 9007199254740991 AND public.metric_time_valid("createdAt")
    AND public.metric_time_valid("expiresAt") AND "expiresAt">"createdAt" AND "winnerMode"='PRIMARY' AND "winnerStatus"='EVALUATED') IS TRUE)
);
CREATE TABLE public.decision_runs (
  id TEXT COLLATE "C" NOT NULL,
  "organizationId" TEXT COLLATE "C" NOT NULL,
  "workspaceId" TEXT COLLATE "C" NOT NULL,
  "storeId" TEXT COLLATE "C" NOT NULL,
  "connectionId" TEXT COLLATE "C" NOT NULL,
  "externalStoreId" TEXT COLLATE "C" NOT NULL,
  "claimId" UUID NOT NULL,
  "claimToken" TEXT COLLATE "C" NOT NULL,
  "eventId" TEXT COLLATE "C" NOT NULL,
  fingerprint TEXT COLLATE "C" NOT NULL,
  "evidenceId" TEXT COLLATE "C" NOT NULL,
  "evidenceVersion" TEXT COLLATE "C" NOT NULL,
  "evidenceHash" TEXT COLLATE "C" NOT NULL,
  "decisionKey" TEXT COLLATE "C" NOT NULL,
  "schemaVersion" INTEGER NOT NULL,
  "requestId" TEXT COLLATE "C" NOT NULL,
  "correlationId" UUID NOT NULL,
  "providerKey" TEXT COLLATE "C" NOT NULL,
  "providerVersion" TEXT COLLATE "C" NOT NULL,
  "supportedInputVersions" JSONB NOT NULL,
  "rulesetVersion" TEXT COLLATE "C" NOT NULL,
  mode TEXT COLLATE "C" NOT NULL,
  "fallbackOf" TEXT COLLATE "C",
  "fallbackMode" TEXT COLLATE "C",
  "fallbackStatus" TEXT COLLATE "C",
  "resultStatus" TEXT COLLATE "C" NOT NULL,
  result JSONB NOT NULL,
  effective JSONB,
  "overrideReason" TEXT COLLATE "C",
  "latencyMs" BIGINT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT decision_runs_pkey PRIMARY KEY (id)
);
CREATE TABLE public.decision_records (
  "runId" TEXT COLLATE "C" NOT NULL,
  "organizationId" TEXT COLLATE "C" NOT NULL,
  "workspaceId" TEXT COLLATE "C" NOT NULL,
  "storeId" TEXT COLLATE "C" NOT NULL,
  "connectionId" TEXT COLLATE "C" NOT NULL,
  "externalStoreId" TEXT COLLATE "C" NOT NULL,
  "decisionType" TEXT COLLATE "C" NOT NULL,
  suggested JSONB NOT NULL,
  effective JSONB,
  CONSTRAINT decision_records_pkey PRIMARY KEY ("runId","decisionType")
);
CREATE TABLE public.decision_comparisons (
  id TEXT COLLATE "C" NOT NULL,
  "claimId" UUID NOT NULL,
  "organizationId" TEXT COLLATE "C" NOT NULL,
  "workspaceId" TEXT COLLATE "C" NOT NULL,
  "storeId" TEXT COLLATE "C" NOT NULL,
  "connectionId" TEXT COLLATE "C" NOT NULL,
  "externalStoreId" TEXT COLLATE "C" NOT NULL,
  "schemaVersion" INTEGER NOT NULL,
  "eventId" TEXT COLLATE "C" NOT NULL,
  fingerprint TEXT COLLATE "C" NOT NULL,
  "evidenceId" TEXT COLLATE "C" NOT NULL,
  "evidenceVersion" TEXT COLLATE "C" NOT NULL,
  "evidenceHash" TEXT COLLATE "C" NOT NULL,
  "decisionKey" TEXT COLLATE "C" NOT NULL,
  "correlationId" UUID NOT NULL,
  "primaryRunId" TEXT COLLATE "C" NOT NULL,
  "primaryMode" TEXT COLLATE "C" NOT NULL,
  "shadowRunId" TEXT COLLATE "C" NOT NULL,
  "shadowMode" TEXT COLLATE "C" NOT NULL,
  "resultStatus" TEXT COLLATE "C" NOT NULL,
  "evaluationVersion" TEXT COLLATE "C" NOT NULL,
  differences JSONB NOT NULL,
  CONSTRAINT decision_comparisons_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX decision_claims_key ON public.decision_claims
  ("eventId","evidenceId","decisionKey");
CREATE UNIQUE INDEX decision_claims_reference_key ON public.decision_claims
  (id,"claimToken","organizationId","workspaceId","storeId","connectionId","externalStoreId");
CREATE UNIQUE INDEX decision_runs_scope_key ON public.decision_runs
  (id,"organizationId","workspaceId","storeId","connectionId","externalStoreId");
CREATE UNIQUE INDEX decision_runs_winner_key ON public.decision_runs (id,"claimId",mode,"resultStatus");
CREATE UNIQUE INDEX decision_runs_fallback_key ON public.decision_runs (id,"claimId","correlationId",mode,"resultStatus");
CREATE UNIQUE INDEX decision_claims_scope_key ON public.decision_claims
  (id,"organizationId","workspaceId","storeId","connectionId","externalStoreId");
CREATE INDEX decision_runs_history_idx ON public.decision_runs ("organizationId","workspaceId","storeId","eventId","createdAt",id);
CREATE UNIQUE INDEX decision_comparisons_pair_key ON public.decision_comparisons ("primaryRunId","shadowRunId","evaluationVersion");
ALTER TABLE public.decision_claims
  ADD CONSTRAINT decision_claims_evidence_fkey FOREIGN KEY ("evidenceId","eventId","organizationId","workspaceId","storeId","connectionId","externalStoreId",fingerprint,"evidenceVersion","evidenceHash")
    REFERENCES public.event_evidence(id,"eventId","organizationId","workspaceId","storeId","connectionId","externalStoreId",fingerprint,version,hash) ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT decision_claims_winner_fkey FOREIGN KEY ("winnerRunId",id,"winnerMode","winnerStatus")
    REFERENCES public.decision_runs(id,"claimId",mode,"resultStatus") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.decision_runs
  ADD CONSTRAINT decision_runs_claim_fkey FOREIGN KEY ("claimId","claimToken","organizationId","workspaceId","storeId","connectionId","externalStoreId")
    REFERENCES public.decision_claims(id,"claimToken","organizationId","workspaceId","storeId","connectionId","externalStoreId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT decision_runs_fallback_fkey FOREIGN KEY ("fallbackOf","claimId","correlationId","fallbackMode","fallbackStatus")
    REFERENCES public.decision_runs(id,"claimId","correlationId",mode,"resultStatus") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.decision_records
  ADD CONSTRAINT decision_records_run_fkey FOREIGN KEY ("runId","organizationId","workspaceId","storeId","connectionId","externalStoreId")
    REFERENCES public.decision_runs(id,"organizationId","workspaceId","storeId","connectionId","externalStoreId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.decision_comparisons
  ADD CONSTRAINT decision_comparisons_claim_fkey FOREIGN KEY ("claimId","organizationId","workspaceId","storeId","connectionId","externalStoreId")
    REFERENCES public.decision_claims(id,"organizationId","workspaceId","storeId","connectionId","externalStoreId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT decision_comparisons_primary_fkey FOREIGN KEY ("primaryRunId","claimId","correlationId","primaryMode","resultStatus")
    REFERENCES public.decision_runs(id,"claimId","correlationId",mode,"resultStatus") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT decision_comparisons_shadow_fkey FOREIGN KEY ("shadowRunId","claimId","correlationId","shadowMode","resultStatus")
    REFERENCES public.decision_runs(id,"claimId","correlationId",mode,"resultStatus") ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE FUNCTION public.decision_codes_valid(value_ JSONB, allowed_ TEXT[], minimum_ INTEGER) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
  IF jsonb_typeof(value_) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  RETURN jsonb_array_length(value_) BETWEEN minimum_ AND cardinality(allowed_)
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(value_) v WHERE jsonb_typeof(v)<>'string' OR NOT (v#>>'{}')=ANY(allowed_))
    AND jsonb_array_length(value_)=(SELECT count(DISTINCT v) FROM jsonb_array_elements(value_) v);
END
$$;
CREATE FUNCTION public.decision_label_valid(kind_ TEXT, value_ JSONB) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE kind_
    WHEN 'SEVERITY' THEN value_ <@ '["INFO","LOW","MEDIUM","HIGH","CRITICAL"]'::jsonb AND jsonb_typeof(value_)='string'
    WHEN 'NOTIFICATION_ROUTE' THEN value_ <@ '["IGNORE","DAILY_BRIEF","NOTIFY_NOW","ESCALATE"]'::jsonb AND jsonb_typeof(value_)='string'
    WHEN 'LLM_ESCALATION' THEN value_ <@ '["NO_LLM_NEEDED","SIMPLE_EXPLANATION","DEEP_REASONING_REQUIRED"]'::jsonb AND jsonb_typeof(value_)='string'
    WHEN 'EVIDENCE_SUFFICIENCY' THEN value_ <@ '["SUFFICIENT","INSUFFICIENT_DATA","AMBIGUOUS"]'::jsonb AND jsonb_typeof(value_)='string'
    WHEN 'ATTENTION_PRIORITY' THEN value_ <@ '["LOW_PRIORITY","NORMAL_PRIORITY","HIGH_PRIORITY","URGENT"]'::jsonb AND jsonb_typeof(value_)='string'
    WHEN 'REASON_CODES' THEN public.decision_codes_valid(value_,ARRAY['CONFIRMED_STOCKOUT','INVENTORY_COVERAGE_LOW','INVENTORY_STAGNATION',
      'REFUND_RATE_HIGH','REFUND_CONCENTRATION','CANCELLATION_RATE_HIGH','PROFIT_MARGIN_DROP','DISCOUNT_HIGH','ROAS_LOW','AD_SPEND_HIGH',
      'CONVERSION_DROP','PRODUCT_BREAKOUT','REVENUE_DROP','SYNC_FAILURE','INSUFFICIENT_SAMPLE','MISSING_DATA','PARTIAL_COVERAGE',
      'STALE_DATA','CONFLICTING_DATA','ZERO_BASELINE','NORMAL_SEASONALITY','NO_MATERIAL_CHANGE'],1)
    ELSE false END IS TRUE
$$;
CREATE FUNCTION public.decision_label_key(kind_ TEXT) RETURNS TEXT
LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE kind_ WHEN 'SEVERITY' THEN 'severity' WHEN 'NOTIFICATION_ROUTE' THEN 'notificationRoute'
    WHEN 'LLM_ESCALATION' THEN 'llmEscalation' WHEN 'EVIDENCE_SUFFICIENCY' THEN 'evidenceSufficiency'
    WHEN 'ATTENTION_PRIORITY' THEN 'attentionPriority' WHEN 'REASON_CODES' THEN 'reasonCodes' END
$$;
CREATE FUNCTION public.decision_labels_valid(value_ JSONB) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT (jsonb_typeof(value_)='object' AND value_ ?& ARRAY['severity','notificationRoute','llmEscalation','evidenceSufficiency','attentionPriority','reasonCodes']
    AND value_-ARRAY['severity','notificationRoute','llmEscalation','evidenceSufficiency','attentionPriority','reasonCodes']='{}'::jsonb
    AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['SEVERITY','NOTIFICATION_ROUTE','LLM_ESCALATION','EVIDENCE_SUFFICIENCY','ATTENTION_PRIORITY','REASON_CODES']) k
      WHERE NOT public.decision_label_valid(k,value_->public.decision_label_key(k)))) IS TRUE
$$;
CREATE FUNCTION public.decision_confidence_valid(value_ JSONB) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT (value_='null'::jsonb OR (jsonb_typeof(value_)='object'
    AND value_ ?& ARRAY['kind','value','semanticsVersion','calibrationVersion']
    AND value_-ARRAY['kind','value','semanticsVersion','calibrationVersion']='{}'::jsonb
    AND value_->>'kind'='HOST_ACCEPTANCE' AND jsonb_typeof(value_->'value')='boolean'
    AND value_->>'semanticsVersion'='host-acceptance-v1' AND value_->'calibrationVersion'='null'::jsonb)) IS TRUE
$$;
CREATE FUNCTION public.decision_result_valid(row_ public.decision_runs) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT (jsonb_typeof(row_.result)='object' AND row_.result @> jsonb_build_object('schemaVersion',1,'status',row_."resultStatus")
    AND CASE WHEN jsonb_typeof(row_.result->'correlationId')='string'
      AND row_.result->>'correlationId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (row_.result->>'correlationId')::uuid=row_."correlationId" ELSE false END
    AND CASE row_."resultStatus" WHEN 'EVALUATED' THEN
      row_.result ?& ARRAY['schemaVersion','correlationId','status','rulesetVersion','labels','confidenceMetadata']
      AND row_.result-ARRAY['schemaVersion','correlationId','status','rulesetVersion','labels','confidenceMetadata']='{}'::jsonb
      AND jsonb_typeof(row_.result->'rulesetVersion')='string' AND row_.result->>'rulesetVersion'=row_."rulesetVersion" AND public.decision_labels_valid(row_.result->'labels')
      AND public.decision_confidence_valid(row_.result->'confidenceMetadata')
      AND CASE WHEN row_.mode='PRIMARY' THEN public.decision_labels_valid(row_.effective)
        AND (row_.effective=row_.result->'labels' OR row_."overrideReason" IS NOT NULL) ELSE row_.effective IS NULL END
    WHEN 'UNAVAILABLE' THEN row_.result ?& ARRAY['schemaVersion','correlationId','status','code']
      AND row_.result-ARRAY['schemaVersion','correlationId','status','code']='{}'::jsonb
      AND row_.result->>'code' IN ('TIMEOUT','ABORTED','PROVIDER_FAILURE','INVALID_RESULT','UNSUPPORTED_SCHEMA')
      AND row_.effective IS NULL AND row_."overrideReason" IS NULL ELSE false END) IS TRUE
$$;
ALTER TABLE public.decision_runs
  ADD CONSTRAINT decision_runs_shape_check CHECK (("schemaVersion"=1 AND public.metric_literal(id) AND public.metric_literal("requestId")
    AND "providerKey"~'^[a-z][a-z0-9-]{0,63}$' AND public.metric_literal("providerVersion") AND "supportedInputVersions"='[1]'::jsonb
    AND public.metric_literal("rulesetVersion") AND "latencyMs" BETWEEN 0 AND 9007199254740991 AND public.metric_time_valid("createdAt")
    AND mode IN ('PRIMARY','SHADOW') AND public.decision_result_valid(decision_runs)
    AND (mode='PRIMARY' OR (effective IS NULL AND "overrideReason" IS NULL AND "fallbackOf" IS NULL))
    AND ("overrideReason" IS NULL OR "overrideReason" IN ('SEVERITY_FLOOR','INSUFFICIENT_EVIDENCE','SECURITY_POLICY','QUIET_HOURS','COOLDOWN','NOTIFICATION_PREFERENCE','LLM_BUDGET','PROVIDER_UNAVAILABLE'))
    AND CASE WHEN "fallbackOf" IS NULL THEN "fallbackMode" IS NULL AND "fallbackStatus" IS NULL
      ELSE "fallbackOf"<>id AND mode='PRIMARY' AND "fallbackMode"='PRIMARY' AND "fallbackStatus"='UNAVAILABLE' END) IS TRUE);
ALTER TABLE public.decision_records ADD CONSTRAINT decision_records_value_check CHECK
  (public.decision_label_valid("decisionType",suggested) AND (effective IS NULL OR public.decision_label_valid("decisionType",effective)));
ALTER TABLE public.decision_comparisons ADD CONSTRAINT decision_comparisons_shape_check CHECK
  (("schemaVersion"=1 AND public.metric_literal(id) AND public.metric_literal("evaluationVersion") AND "primaryRunId"<>"shadowRunId"
    AND "primaryMode"='PRIMARY' AND "shadowMode"='SHADOW' AND "resultStatus"='EVALUATED'
    AND public.decision_codes_valid(differences,ARRAY['SEVERITY','NOTIFICATION_ROUTE','LLM_ESCALATION','EVIDENCE_SUFFICIENCY','ATTENTION_PRIORITY','REASON_CODES'],0)) IS TRUE);

CREATE FUNCTION public.decision_record_projection() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE row_ public.decision_runs; key_ TEXT := public.decision_label_key(NEW."decisionType");
BEGIN
  SELECT * INTO row_ FROM public.decision_runs WHERE id=NEW."runId";
  IF NOT FOUND OR row_."resultStatus"<>'EVALUATED' OR key_ IS NULL
    OR NEW.suggested IS DISTINCT FROM row_.result->'labels'->key_
    OR NEW.effective IS DISTINCT FROM row_.effective->key_ THEN
    RAISE EXCEPTION 'Decision record must project its immutable run' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE FUNCTION public.decision_claim_update() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE source_ public.events;
BEGIN
  IF (to_jsonb(NEW)-'winnerRunId') IS DISTINCT FROM (to_jsonb(OLD)-'winnerRunId')
    OR OLD."winnerRunId" IS NOT NULL OR NEW."winnerRunId" IS NULL THEN
    RAISE EXCEPTION 'Decision lease is immutable and winner is write once' USING ERRCODE='23514';
  END IF;
  SELECT * INTO source_ FROM public.events WHERE id=OLD."eventId" FOR UPDATE;
  IF (clock_timestamp()<OLD."expiresAt" AND source_.revision=OLD."eventRevision"
    AND source_."currentEvidenceId"=OLD."evidenceId" AND source_."currentEvidenceVersion"=OLD."evidenceVersion"
    AND source_."currentEvidenceHash"=OLD."evidenceHash"
    AND public.event_scope_access(OLD."organizationId",OLD."workspaceId",OLD."storeId",OLD."connectionId",OLD."externalStoreId",true)) IS NOT TRUE THEN
    RAISE EXCEPTION 'Decision winner requires a live current authorized lease' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
-- Keep variable-width evidence outside redundant B-tree tuples; compare the raw values exactly.
CREATE FUNCTION public.decision_binding_matches(row_ JSONB, lease_ public.decision_claims) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT (ROW(row_->>'eventId' COLLATE "C",row_->>'fingerprint' COLLATE "C",row_->>'evidenceId' COLLATE "C",row_->>'evidenceVersion' COLLATE "C",row_->>'evidenceHash' COLLATE "C",row_->>'decisionKey' COLLATE "C")
    =ROW(lease_."eventId",lease_.fingerprint,lease_."evidenceId",lease_."evidenceVersion",lease_."evidenceHash",lease_."decisionKey")) IS TRUE
$$;
CREATE FUNCTION public.decision_comparison_binding() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE lease_ public.decision_claims;
BEGIN
  SELECT * INTO lease_ FROM public.decision_claims WHERE id=NEW."claimId";
  IF NOT public.decision_binding_matches(to_jsonb(NEW),lease_) THEN
    RAISE EXCEPTION 'Decision comparison must match its immutable claim' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END
$$;
CREATE FUNCTION public.decision_run_current() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE lease_ public.decision_claims; event_ public.events;
BEGIN
  SELECT * INTO event_ FROM public.events WHERE id=NEW."eventId" FOR UPDATE;
  SELECT * INTO lease_ FROM public.decision_claims WHERE id=NEW."claimId" FOR UPDATE;
  IF NOT public.decision_binding_matches(to_jsonb(NEW),lease_) THEN
    RAISE EXCEPTION 'Decision run must match its immutable claim' USING ERRCODE='23503';
  END IF;
  IF lease_.id IS NOT NULL AND (clock_timestamp()>=lease_."expiresAt"
    OR event_.revision IS DISTINCT FROM lease_."eventRevision"
    OR event_."currentEvidenceId" IS DISTINCT FROM lease_."evidenceId"
    OR event_."currentEvidenceVersion" IS DISTINCT FROM lease_."evidenceVersion"
    OR event_."currentEvidenceHash" IS DISTINCT FROM lease_."evidenceHash"
    OR (NEW.mode='PRIMARY' AND lease_."winnerRunId" IS NOT NULL)) THEN
    RAISE EXCEPTION 'Decision lease is expired, superseded or already committed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER decision_comparisons_binding BEFORE INSERT ON public.decision_comparisons FOR EACH ROW EXECUTE FUNCTION public.decision_comparison_binding();
CREATE TRIGGER decision_records_projection BEFORE INSERT ON public.decision_records FOR EACH ROW EXECUTE FUNCTION public.decision_record_projection();
CREATE TRIGGER decision_claims_update BEFORE UPDATE ON public.decision_claims FOR EACH ROW EXECUTE FUNCTION public.decision_claim_update();
CREATE TRIGGER decision_runs_current BEFORE INSERT ON public.decision_runs FOR EACH ROW EXECUTE FUNCTION public.decision_run_current();
CREATE TRIGGER decision_claims_no_delete BEFORE DELETE OR TRUNCATE ON public.decision_claims FOR EACH STATEMENT EXECUTE FUNCTION public.event_history_immutable();
CREATE TRIGGER decision_runs_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.decision_runs FOR EACH STATEMENT EXECUTE FUNCTION public.event_history_immutable();
CREATE TRIGGER decision_records_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.decision_records FOR EACH STATEMENT EXECUTE FUNCTION public.event_history_immutable();
CREATE TRIGGER decision_comparisons_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.decision_comparisons FOR EACH STATEMENT EXECUTE FUNCTION public.event_history_immutable();

CREATE FUNCTION public.decision_claim(event_ TEXT, evidence_ TEXT, version_ TEXT, hash_ TEXT, key_ TEXT, token_ TEXT, deadline_ TIMESTAMPTZ)
RETURNS public.decision_claims LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE source_ public.events; lease_ public.decision_claims;
BEGIN
  SELECT * INTO source_ FROM public.events WHERE id=event_ FOR UPDATE;
  IF NOT FOUND OR NOT public.event_scope_access(source_."organizationId",source_."workspaceId",source_."storeId",source_."connectionId",source_."externalStoreId",true) THEN
    RAISE EXCEPTION 'Decision scope is forbidden' USING ERRCODE='42501';
  END IF;
  IF (source_."currentEvidenceId"=evidence_ AND source_."currentEvidenceVersion"=version_ AND source_."currentEvidenceHash"=hash_
    AND public.metric_literal(key_) AND public.metric_literal(token_) AND public.metric_time_valid(deadline_) AND deadline_>clock_timestamp()) IS NOT TRUE THEN
    RAISE EXCEPTION 'Invalid current decision claim' USING ERRCODE='23514';
  END IF;
  INSERT INTO public.decision_claims ("organizationId","workspaceId","storeId","connectionId","externalStoreId","eventId","eventRevision",fingerprint,"evidenceId","evidenceVersion","evidenceHash","decisionKey","claimToken","expiresAt")
    VALUES (source_."organizationId",source_."workspaceId",source_."storeId",source_."connectionId",source_."externalStoreId",source_.id,source_.revision,source_.fingerprint,evidence_,version_,hash_,key_,token_,deadline_)
    ON CONFLICT ("eventId","evidenceId","decisionKey") DO NOTHING;
  SELECT * INTO lease_ FROM public.decision_claims WHERE "eventId"=event_ AND "evidenceId"=evidence_
    AND "evidenceVersion"=version_ AND "evidenceHash"=hash_ AND "decisionKey"=key_;
  RETURN lease_;
END
$$;
CREATE FUNCTION public.decision_commit(claim_ UUID, token_ TEXT, run_ TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE lease_ public.decision_claims; source_ public.events; won_ UUID;
BEGIN
  SELECT * INTO lease_ FROM public.decision_claims WHERE id=claim_;
  IF NOT FOUND OR NOT public.event_scope_access(lease_."organizationId",lease_."workspaceId",lease_."storeId",lease_."connectionId",lease_."externalStoreId",true) THEN RETURN false; END IF;
  SELECT * INTO source_ FROM public.events WHERE id=lease_."eventId" FOR UPDATE;
  IF (source_.revision=lease_."eventRevision" AND source_."currentEvidenceId"=lease_."evidenceId"
    AND source_."currentEvidenceVersion"=lease_."evidenceVersion" AND source_."currentEvidenceHash"=lease_."evidenceHash") IS NOT TRUE THEN RETURN false; END IF;
  UPDATE public.decision_claims SET "winnerRunId"=run_ WHERE id=claim_ AND "claimToken"=token_
    AND "winnerRunId" IS NULL AND clock_timestamp()<"expiresAt" AND EXISTS
      (SELECT 1 FROM public.decision_runs r WHERE r.id=run_ AND r."claimId"=claim_ AND r.mode='PRIMARY' AND r."resultStatus"='EVALUATED')
    RETURNING id INTO won_;
  RETURN won_ IS NOT NULL;
END
$$;
DO $$
DECLARE name_ TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Decision policy owner must bypass forced tenant RLS' USING ERRCODE='42501';
  END IF;
  FOREACH name_ IN ARRAY ARRAY['shopmate_decision_reader','shopmate_decision_writer'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=name_) THEN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=name_ AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
        RAISE EXCEPTION 'Unsafe existing decision capability role' USING ERRCODE='42501';
      END IF;
    ELSE
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION',name_);
    END IF;
  END LOOP;
END
$$;
REVOKE ALL ON public.decision_claims,public.decision_runs,public.decision_records,public.decision_comparisons FROM PUBLIC,shopmate_decision_reader,shopmate_decision_writer;
GRANT USAGE ON SCHEMA public TO shopmate_decision_reader,shopmate_decision_writer;
GRANT SELECT ON public.decision_claims,public.decision_runs,public.decision_records,public.decision_comparisons TO shopmate_decision_reader,shopmate_decision_writer;
GRANT INSERT ON public.decision_runs,public.decision_records,public.decision_comparisons TO shopmate_decision_writer;
REVOKE ALL ON FUNCTION public.decision_claim(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ),public.decision_commit(UUID,TEXT,TEXT),
  public.decision_codes_valid(JSONB,TEXT[],INTEGER),public.decision_label_valid(TEXT,JSONB),public.decision_label_key(TEXT),public.decision_labels_valid(JSONB),
  public.decision_confidence_valid(JSONB),public.decision_result_valid(public.decision_runs),public.decision_record_projection(),public.decision_claim_update(),public.decision_run_current(),
  public.decision_binding_matches(JSONB,public.decision_claims),public.decision_comparison_binding() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.event_scope_access(TEXT,TEXT,TEXT,TEXT,TEXT,BOOLEAN) TO shopmate_decision_reader,shopmate_decision_writer;
GRANT EXECUTE ON FUNCTION public.decision_claim(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ),public.decision_commit(UUID,TEXT,TEXT),
  public.decision_codes_valid(JSONB,TEXT[],INTEGER),public.decision_label_valid(TEXT,JSONB),public.decision_label_key(TEXT),public.decision_labels_valid(JSONB),
  public.decision_confidence_valid(JSONB),public.decision_result_valid(public.decision_runs),public.metric_literal(TEXT),public.metric_time_valid(TIMESTAMPTZ) TO shopmate_decision_writer;
DO $$
DECLARE table_ TEXT;
BEGIN
  FOREACH table_ IN ARRAY ARRAY['decision_claims','decision_runs','decision_records','decision_comparisons'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO shopmate_decision_reader,shopmate_decision_writer USING (public.event_scope_access("organizationId","workspaceId","storeId","connectionId","externalStoreId",false))',table_||'_read',table_);
    IF table_<>'decision_claims' THEN
      EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO shopmate_decision_writer WITH CHECK (public.event_scope_access("organizationId","workspaceId","storeId","connectionId","externalStoreId",true))',table_||'_append',table_);
    END IF;
  END LOOP;
END
$$;
COMMIT;

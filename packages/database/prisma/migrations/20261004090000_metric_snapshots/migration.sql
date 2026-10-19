-- Additive metric history: depends only on tenant foundation and PlatformConnection.
BEGIN;
CREATE TABLE public.metric_definitions (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" TEXT COLLATE "C" NOT NULL,
  "workspaceId" TEXT COLLATE "C" NOT NULL,
  "storeId" TEXT COLLATE "C" NOT NULL,
  "connectionId" TEXT COLLATE "C" NOT NULL,
  "externalStoreId" TEXT COLLATE "C" NOT NULL,
  key TEXT COLLATE "C" NOT NULL,
  "definitionVersion" TEXT COLLATE "C" NOT NULL,
  unit TEXT COLLATE "C" NOT NULL,
  "definitionHash" TEXT COLLATE "C" NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT metric_definitions_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX metric_definitions_scope_version_key ON public.metric_definitions
  ("organizationId","workspaceId","storeId","connectionId","externalStoreId",key,"definitionVersion");
CREATE TABLE public.metric_snapshots (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" TEXT COLLATE "C" NOT NULL,
  "workspaceId" TEXT COLLATE "C" NOT NULL,
  "storeId" TEXT COLLATE "C" NOT NULL,
  "connectionId" TEXT COLLATE "C" NOT NULL,
  "externalStoreId" TEXT COLLATE "C" NOT NULL,
  key TEXT COLLATE "C" NOT NULL,
  "definitionVersion" TEXT COLLATE "C" NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "hashVersion" TEXT COLLATE "C" NOT NULL DEFAULT 'metric-input-sha256-v1',
  "inputRevision" TEXT COLLATE "C" NOT NULL,
  "inputHash" TEXT COLLATE "C" NOT NULL,
  "subjectKind" TEXT COLLATE "C" NOT NULL,
  "subjectId" TEXT COLLATE "C" NOT NULL,
  "periodStart" TIMESTAMPTZ(3) NOT NULL,
  "periodEnd" TIMESTAMPTZ(3) NOT NULL,
  timezone TEXT COLLATE "C" NOT NULL,
  currency TEXT COLLATE "C" NOT NULL,
  "visibleAt" TIMESTAMPTZ(3) NOT NULL,
  "sourceWatermark" TIMESTAMPTZ(3),
  "computedAt" TIMESTAMPTZ(3) NOT NULL,
  "sampleSize" BIGINT NOT NULL,
  "coverageBasisPoints" INTEGER NOT NULL,
  status TEXT COLLATE "C" NOT NULL,
  "evidenceIds" TEXT[] COLLATE "C" NOT NULL,
  issues JSONB NOT NULL,
  "valueMinor" BIGINT,
  "valueUnits" BIGINT,
  "valueBasisPoints" BIGINT,
  "valueHours" DOUBLE PRECISION,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT metric_snapshots_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX metric_snapshots_identity_revision_key ON public.metric_snapshots
  ("organizationId","workspaceId","storeId","connectionId","externalStoreId",key,"subjectKind","subjectId","definitionVersion","periodStart","periodEnd","inputRevision");
CREATE INDEX metric_snapshots_scope_period_history_idx ON public.metric_snapshots
  ("organizationId","workspaceId","storeId",key,"periodStart","periodEnd","computedAt");
ALTER TABLE public.metric_definitions
  ADD CONSTRAINT metric_definitions_store_fkey FOREIGN KEY ("organizationId","workspaceId","storeId")
    REFERENCES public."Store"("organizationId","workspaceId",id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT metric_definitions_connection_fkey FOREIGN KEY ("connectionId","organizationId","workspaceId","storeId","externalStoreId")
    REFERENCES public."PlatformConnection"(id,"organizationId","workspaceId","storeId","externalStoreId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.metric_snapshots
  ADD CONSTRAINT metric_snapshots_store_fkey FOREIGN KEY ("organizationId","workspaceId","storeId")
    REFERENCES public."Store"("organizationId","workspaceId",id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT metric_snapshots_connection_fkey FOREIGN KEY ("connectionId","organizationId","workspaceId","storeId","externalStoreId")
    REFERENCES public."PlatformConnection"(id,"organizationId","workspaceId","storeId","externalStoreId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.metric_snapshots ADD CONSTRAINT metric_snapshots_definition_fkey
  FOREIGN KEY ("organizationId","workspaceId","storeId","connectionId","externalStoreId",key,"definitionVersion")
  REFERENCES public.metric_definitions("organizationId","workspaceId","storeId","connectionId","externalStoreId",key,"definitionVersion") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- One mapping matches the public MetricValueSchema; calculators are never stored as executable text.
CREATE FUNCTION public.metric_unit(metric_key TEXT) RETURNS TEXT
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT CASE
    WHEN metric_key IN ('GMV','PAID_REVENUE','AOV','REFUND_SETTLED_AMOUNT','COGS',
      'NET_REVENUE_SETTLEMENT','NET_MERCHANDISE_REVENUE','GROSS_PROFIT','CONTRIBUTION','ESTIMATED_NET_PROFIT','PROFIT_DELTA') THEN 'minorCNY'
    WHEN metric_key IN ('PAID_ORDERS','PAID_UNITS','REFUNDED_COHORT_ORDERS','INVENTORY_AVAILABLE') THEN 'units'
    WHEN metric_key IN ('REFUND_COHORT_ORDER_RATE','REFUND_COHORT_AMOUNT_RATE','CONVERSION_RATE','CART_RATE','CHECKOUT_RATE','ROAS') THEN 'basisPoints'
    WHEN metric_key IN ('INVENTORY_HOURS_REMAINING','LEAD_TIME_HOURS') THEN 'hours'
  END
$$;
CREATE FUNCTION public.metric_literal(value TEXT) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT length(value)+length(regexp_replace(value,U&'[\0001-\FFFF]','','g')) BETWEEN 1 AND 256
    AND value=btrim(value,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
    AND value !~ U&'[\0001-\001F\007F-\009F\200B-\200F\202A-\202E\2066-\2069]'
$$;
CREATE FUNCTION public.metric_evidence_valid(ids TEXT[]) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT (array_ndims(ids)=1 AND cardinality(ids)>0
    AND NOT EXISTS (SELECT 1 FROM unnest(ids) AS e(value) WHERE public.metric_literal(value) IS NOT TRUE)
    AND cardinality(ids)=(SELECT count(DISTINCT value COLLATE "C") FROM unnest(ids) AS e(value))) IS TRUE
$$;
CREATE FUNCTION public.metric_issue_evidence(ids JSONB, allowed TEXT[]) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE values_ TEXT[];
BEGIN
  IF jsonb_typeof(ids) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(ids) e WHERE jsonb_typeof(e) IS DISTINCT FROM 'string') THEN RETURN false; END IF;
  SELECT array_agg(value) INTO values_ FROM jsonb_array_elements_text(ids) e(value);
  RETURN (public.metric_evidence_valid(values_) AND values_ <@ allowed) IS TRUE;
END
$$;
CREATE FUNCTION public.metric_issue_valid(issue JSONB, allowed TEXT[]) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
  IF jsonb_typeof(issue) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  RETURN (issue ?& ARRAY['code','field','evidenceIds']
    AND issue - ARRAY['code','field','evidenceIds']='{}'::jsonb
    AND jsonb_typeof(issue->'code')='string'
    AND issue->>'code' IN ('NOT_SYNCHRONIZED','SOURCE_INCONSISTENT','SOURCE_TIME_MISSING','PAYMENT_UNKNOWN',
      'REFUND_UNKNOWN','COST_MISSING','COST_ESTIMATED','RETURN_UNKNOWN','FEE_MISSING','FEE_ESTIMATED','TRAFFIC_MISSING',
      'ATTRIBUTION_MISSING','INVENTORY_UNKNOWN','LEAD_TIME_MISSING','STALE_SOURCE','LOW_SAMPLE','ZERO_DENOMINATOR',
      'IMMATURE_COHORT','PARTIAL_COVERAGE','WINDOW_MISMATCH','VERSION_MISMATCH')
    AND jsonb_typeof(issue->'field')='string' AND public.metric_literal(issue->>'field')
    AND public.metric_issue_evidence(issue->'evidenceIds',allowed)) IS TRUE;
END
$$;
CREATE FUNCTION public.metric_issues_valid(issues JSONB, allowed TEXT[]) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
  IF jsonb_typeof(issues) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  RETURN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(issues) issue WHERE public.metric_issue_valid(issue,allowed) IS NOT TRUE);
END
$$;
CREATE FUNCTION public.metric_time_valid(value TIMESTAMPTZ) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT isfinite(value) AND value>=timestamptz '0001-01-01 00:00:00+00'
    AND value<=timestamptz '9999-12-31 23:59:59.999+00'
$$;
CREATE FUNCTION public.metric_value_valid(metric_key TEXT, state TEXT, minor_ BIGINT, units_ BIGINT, bps_ BIGINT, hours_ DOUBLE PRECISION)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN state='UNAVAILABLE' THEN num_nonnulls(minor_,units_,bps_,hours_)=0
    ELSE num_nonnulls(minor_,units_,bps_,hours_)=1 AND CASE public.metric_unit(metric_key)
      WHEN 'minorCNY' THEN minor_ IS NOT NULL AND minor_ BETWEEN
        CASE WHEN metric_key IN ('GMV','PAID_REVENUE','AOV','REFUND_SETTLED_AMOUNT','COGS') THEN 0 ELSE -9007199254740991 END AND 9007199254740991
      WHEN 'units' THEN units_ IS NOT NULL AND units_ BETWEEN 0 AND 9007199254740991
      WHEN 'basisPoints' THEN bps_ IS NOT NULL AND bps_ BETWEEN 0 AND CASE WHEN metric_key='ROAS' THEN 9007199254740991 ELSE 10000 END
      WHEN 'hours' THEN hours_ IS NOT NULL AND hours_ BETWEEN 0 AND 9007199254740991
      ELSE false END END
$$;
ALTER TABLE public.metric_definitions
  ADD CONSTRAINT metric_definitions_unit_check CHECK ((public.metric_unit(key)=unit) IS TRUE),
  ADD CONSTRAINT metric_definitions_hash_check CHECK ("definitionHash" ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT metric_definitions_version_check CHECK (public.metric_literal("definitionVersion") IS TRUE),
  ADD CONSTRAINT metric_definitions_created_check CHECK (public.metric_time_valid("createdAt") IS TRUE);
ALTER TABLE public.metric_snapshots
  ADD CONSTRAINT metric_snapshots_version_check CHECK ("schemaVersion"=1 AND "hashVersion"='metric-input-sha256-v1'
    AND public.metric_literal("definitionVersion") IS TRUE AND public.metric_literal("inputRevision") IS TRUE),
  ADD CONSTRAINT metric_snapshots_hash_check CHECK ("inputHash" ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT metric_snapshots_subject_check CHECK (("subjectKind"='STORE' AND "subjectId"='')
    OR ("subjectKind" IN ('SKU','CAMPAIGN') AND public.metric_literal("subjectId") IS TRUE)),
  ADD CONSTRAINT metric_snapshots_window_check CHECK (timezone='Asia/Shanghai' AND currency='CNY'
    AND public.metric_time_valid("periodStart") IS TRUE AND public.metric_time_valid("periodEnd") IS TRUE
    AND public.metric_time_valid("visibleAt") IS TRUE AND public.metric_time_valid("computedAt") IS TRUE
    AND public.metric_time_valid("createdAt") IS TRUE AND "periodStart"<"periodEnd"
    AND "periodEnd"<="visibleAt" AND "visibleAt"<="computedAt"
    AND ("sourceWatermark" IS NULL OR (public.metric_time_valid("sourceWatermark") IS TRUE AND "sourceWatermark"<="visibleAt"))),
  ADD CONSTRAINT metric_snapshots_sample_check CHECK ("sampleSize" BETWEEN 0 AND 9007199254740991 AND "coverageBasisPoints" BETWEEN 0 AND 10000),
  ADD CONSTRAINT metric_snapshots_values_check CHECK (public.metric_value_valid(key,status,"valueMinor","valueUnits","valueBasisPoints","valueHours") IS TRUE),
  ADD CONSTRAINT metric_snapshots_evidence_check CHECK (public.metric_evidence_valid("evidenceIds") IS TRUE AND public.metric_issues_valid(issues,"evidenceIds") IS TRUE),
  ADD CONSTRAINT metric_snapshots_quality_check CHECK ((status IN ('VERIFIED','ESTIMATED','INSUFFICIENT','STALE','UNAVAILABLE')
    AND ("sourceWatermark" IS NOT NULL OR status='UNAVAILABLE')
    AND CASE WHEN status='VERIFIED' THEN "coverageBasisPoints"=10000 AND issues='[]'::jsonb AND "sourceWatermark">="periodEnd"
      ELSE issues<>'[]'::jsonb END) IS TRUE);
ALTER TABLE public.metric_definitions ADD CONSTRAINT metric_definitions_scope_check CHECK (
    "organizationId" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
    AND "workspaceId" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
    AND "storeId" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
    AND "connectionId" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
    AND public.metric_literal("externalStoreId") IS TRUE);
ALTER TABLE public.metric_snapshots ADD CONSTRAINT metric_snapshots_scope_check CHECK (
    "organizationId" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
    AND "workspaceId" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
    AND "storeId" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
    AND "connectionId" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
    AND public.metric_literal("externalStoreId") IS TRUE);

-- Capability groups are provisioned without credentials or membership grants to application logins.
DO $$
DECLARE name_ TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Metric policy owner must bypass forced tenant RLS' USING ERRCODE='42501';
  END IF;
  FOREACH name_ IN ARRAY ARRAY['shopmate_metric_reader','shopmate_metric_writer','shopmate_metric_definition_writer'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=name_) THEN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=name_ AND
        (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
        RAISE EXCEPTION 'Unsafe existing metric capability role' USING ERRCODE='42501';
      END IF;
    ELSE
      -- The identifier comes only from the fixed local allowlist above.
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION',name_);
    END IF;
  END LOOP;
END
$$;
-- Narrow boolean authority check: no tenant rows or credentials are returned to callers.
CREATE FUNCTION public.metric_scope_access(org_ TEXT, workspace_ TEXT, store_ TEXT, connection_ TEXT, external_ TEXT, writable_ BOOLEAN)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT (current_setting('transaction_isolation')='read committed'
    AND org_=current_setting('app.organization_id',true)
    AND workspace_=current_setting('app.workspace_id',true)
    AND store_=current_setting('app.store_id',true)
    AND connection_=current_setting('app.connection_id',true)
    AND external_=current_setting('app.external_store_id',true)
    AND nullif(current_setting('app.user_id',true),'') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public."Store" s
      JOIN public."Organization" o ON o.id=s."organizationId" AND o."legacyMerchantId"=s."merchantId"
      JOIN public."Workspace" w ON w.id=s."workspaceId" AND w."organizationId"=o.id
      JOIN public."OrganizationMember" m ON m."organizationId"=o.id
      WHERE s.id=store_ AND o.id=org_ AND w.id=workspace_
        AND m."userId"=current_setting('app.user_id',true)
        AND m.status='ACTIVE' AND o.status='ACTIVE' AND w.status='ACTIVE'
        AND (NOT writable_ OR m.role IN ('OWNER','ADMIN'))
        AND (m.role IN ('OWNER','ADMIN') OR EXISTS (
          SELECT 1 FROM public."WorkspaceMember" wm WHERE wm."organizationId"=o.id
            AND wm."workspaceId"=w.id AND wm."userId"=m."userId" AND wm.status='ACTIVE'))
    )) IS TRUE
$$;
CREATE FUNCTION public.metric_history_immutable() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Metric history is immutable; append a new revision or definition version' USING ERRCODE='23514';
END
$$;
CREATE TRIGGER metric_definitions_immutable BEFORE UPDATE OR DELETE ON public.metric_definitions
  FOR EACH ROW EXECUTE FUNCTION public.metric_history_immutable();
CREATE TRIGGER metric_snapshots_immutable BEFORE UPDATE OR DELETE ON public.metric_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.metric_history_immutable();
CREATE TRIGGER metric_definitions_no_truncate BEFORE TRUNCATE ON public.metric_definitions
  FOR EACH STATEMENT EXECUTE FUNCTION public.metric_history_immutable();
CREATE TRIGGER metric_snapshots_no_truncate BEFORE TRUNCATE ON public.metric_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION public.metric_history_immutable();
ALTER TABLE public.metric_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.metric_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.metric_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.metric_snapshots FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.metric_definitions,public.metric_snapshots FROM PUBLIC,shopmate_metric_reader,shopmate_metric_writer,shopmate_metric_definition_writer;
GRANT USAGE ON SCHEMA public TO shopmate_metric_reader,shopmate_metric_writer,shopmate_metric_definition_writer;
GRANT SELECT ON public.metric_definitions TO shopmate_metric_reader,shopmate_metric_writer,shopmate_metric_definition_writer;
GRANT SELECT ON public.metric_snapshots TO shopmate_metric_reader,shopmate_metric_writer;
GRANT INSERT ON public.metric_snapshots TO shopmate_metric_writer;
GRANT INSERT ON public.metric_definitions TO shopmate_metric_definition_writer;
REVOKE ALL ON FUNCTION public.metric_unit(TEXT),public.metric_literal(TEXT),public.metric_evidence_valid(TEXT[]),
  public.metric_issue_evidence(JSONB,TEXT[]),public.metric_issue_valid(JSONB,TEXT[]),public.metric_issues_valid(JSONB,TEXT[]),
  public.metric_time_valid(TIMESTAMPTZ),public.metric_value_valid(TEXT,TEXT,BIGINT,BIGINT,BIGINT,DOUBLE PRECISION),
  public.metric_scope_access(TEXT,TEXT,TEXT,TEXT,TEXT,BOOLEAN),public.metric_history_immutable() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.metric_scope_access(TEXT,TEXT,TEXT,TEXT,TEXT,BOOLEAN)
  TO shopmate_metric_reader,shopmate_metric_writer,shopmate_metric_definition_writer;
GRANT EXECUTE ON FUNCTION public.metric_unit(TEXT),public.metric_literal(TEXT),public.metric_time_valid(TIMESTAMPTZ)
  TO shopmate_metric_writer,shopmate_metric_definition_writer;
GRANT EXECUTE ON FUNCTION public.metric_evidence_valid(TEXT[]),public.metric_issue_evidence(JSONB,TEXT[]),
  public.metric_issue_valid(JSONB,TEXT[]),public.metric_issues_valid(JSONB,TEXT[]),
  public.metric_value_valid(TEXT,TEXT,BIGINT,BIGINT,BIGINT,DOUBLE PRECISION) TO shopmate_metric_writer;
CREATE POLICY metric_definitions_read ON public.metric_definitions FOR SELECT
  TO shopmate_metric_reader,shopmate_metric_writer,shopmate_metric_definition_writer
  USING (public.metric_scope_access("organizationId","workspaceId","storeId","connectionId","externalStoreId",false));
CREATE POLICY metric_definitions_append ON public.metric_definitions FOR INSERT TO shopmate_metric_definition_writer
  WITH CHECK (public.metric_scope_access("organizationId","workspaceId","storeId","connectionId","externalStoreId",true));
CREATE POLICY metric_snapshots_read ON public.metric_snapshots FOR SELECT TO shopmate_metric_reader,shopmate_metric_writer
  USING (public.metric_scope_access("organizationId","workspaceId","storeId","connectionId","externalStoreId",false));
CREATE POLICY metric_snapshots_append ON public.metric_snapshots FOR INSERT TO shopmate_metric_writer
  WITH CHECK (public.metric_scope_access("organizationId","workspaceId","storeId","connectionId","externalStoreId",true));
COMMIT;

-- Version 1 hashes are supplied by the canonical API hasher, never recomputed from JSONB.
-- Recipe: lowercase SHA256(UTF8('shopmate.audit.entry.v1') || NUL || canonical entry bytes).
BEGIN;
DO $$
DECLARE name_ TEXT;
BEGIN
  FOREACH name_ IN ARRAY ARRAY['shopmate_audit_reader','shopmate_audit_writer','shopmate_audit_service_writer','shopmate_auth_security_writer','shopmate_audit_chain'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=name_) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION',name_);
    ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=name_ AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
      RAISE EXCEPTION 'Unsafe audit capability role' USING ERRCODE='42501';
    END IF;
  END LOOP;
END $$;

CREATE FUNCTION public.audit_id(value_ TEXT) RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT value_ ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
$$;

-- Audit accepts opaque ExternalId values even when metric migrations are intentionally pending.
CREATE FUNCTION public.audit_literal(value_ TEXT) RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT length(value_)+length(regexp_replace(value_,U&'[\0001-\FFFF]','','g')) BETWEEN 1 AND 256
    AND value_=btrim(value_,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
    AND value_ !~ U&'[\0001-\001F\007F-\009F\200B-\200F\202A-\202E\2066-\2069]'
$$;

CREATE FUNCTION public.audit_keys(value_ JSONB, keys_ TEXT[]) RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT (jsonb_typeof(value_)='object' AND value_ ?& keys_ AND value_-keys_='{}'::jsonb) IS TRUE
$$;

CREATE FUNCTION public.audit_enum(value_ JSONB, choices_ TEXT[], nullable_ BOOLEAN DEFAULT false) RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT ((nullable_ AND value_='null'::jsonb) OR (jsonb_typeof(value_)='string' AND value_#>>'{}'=ANY(choices_))) IS TRUE
$$;

CREATE FUNCTION public.audit_number(value_ JSONB, min_ BIGINT DEFAULT 0) RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN jsonb_typeof(value_)='number' AND value_::text ~ '^[0-9]+$'
    THEN (value_::text)::numeric BETWEEN min_ AND 9007199254740991 ELSE false END
$$;

CREATE FUNCTION public.audit_timestamp(value_ JSONB) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE text_ TEXT:=value_#>>'{}'; year_ INTEGER; month_ INTEGER; day_ INTEGER; days_ INTEGER[];
BEGIN
  IF jsonb_typeof(value_) IS DISTINCT FROM 'string' OR text_ !~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$' THEN RETURN false; END IF;
  year_:=substring(text_,1,4)::integer; month_:=substring(text_,6,2)::integer; day_:=substring(text_,9,2)::integer;
  -- Validate the DTO's proleptic Gregorian calendar without PostgreSQL's timezone/year restrictions.
  days_:=ARRAY[31,CASE WHEN year_%4=0 AND (year_%100<>0 OR year_%400=0) THEN 29 ELSE 28 END,31,30,31,30,31,31,30,31,30,31];
  RETURN day_<=days_[month_];
END $$;

CREATE FUNCTION public.audit_reason(value_ JSONB) RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT public.audit_enum(value_,ARRAY['REQUESTED','COMPLETED','POLICY_DENIED','VALIDATION_FAILED','EXPIRED','CONFLICT','UPSTREAM_UNAVAILABLE'],true)
$$;

CREATE FUNCTION public.audit_entity_valid(ref_ JSONB) RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT (public.audit_enum(ref_->'eventType',ARRAY['REVENUE_DROP','REFUND_SPIKE','CANCELLED_ORDER_SPIKE','PROFIT_MARGIN_DROP','UNUSUAL_DISCOUNT','CONVERSION_DROP','STOCKOUT_RISK','INVENTORY_STAGNATION','PRODUCT_BREAKOUT','ROAS_DROP','AD_SPEND_SPIKE','SYNC_FAILURE'])
    AND CASE ref_->'entity'->>'kind'
      WHEN 'STORE' THEN public.audit_keys(ref_->'entity',ARRAY['kind']) AND ref_->>'eventType' NOT IN ('STOCKOUT_RISK','INVENTORY_STAGNATION','PRODUCT_BREAKOUT','ROAS_DROP','AD_SPEND_SPIKE','SYNC_FAILURE')
      WHEN 'SKU' THEN public.audit_keys(ref_->'entity',ARRAY['kind','externalSkuId']) AND jsonb_typeof(ref_->'entity'->'externalSkuId')='string' AND public.audit_literal(ref_->'entity'->>'externalSkuId') AND ref_->>'eventType' NOT IN ('ROAS_DROP','AD_SPEND_SPIKE','SYNC_FAILURE')
      WHEN 'CAMPAIGN' THEN public.audit_keys(ref_->'entity',ARRAY['kind','externalCampaignId']) AND jsonb_typeof(ref_->'entity'->'externalCampaignId')='string' AND public.audit_literal(ref_->'entity'->>'externalCampaignId') AND ref_->>'eventType' IN ('ROAS_DROP','AD_SPEND_SPIKE')
      WHEN 'CONNECTION' THEN public.audit_keys(ref_->'entity',ARRAY['kind','connectionId']) AND ref_->'entity'->'connectionId'=ref_->'binding'->'connectionId' AND ref_->>'eventType'='SYNC_FAILURE'
      ELSE false END) IS TRUE
$$;

CREATE FUNCTION public.audit_reference_valid(ref_ JSONB) RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT (public.audit_keys(ref_,ARRAY['schemaVersion','id','version','hash','binding','eventType','entity','definitionVersion','baselineVersion'])
    AND ref_->'schemaVersion'='1'::jsonb
    AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['id','version','hash','definitionVersion']) k WHERE jsonb_typeof(ref_->k)<>'string' OR NOT public.audit_literal(ref_->>k))
    AND (ref_->'baselineVersion'='null'::jsonb OR (jsonb_typeof(ref_->'baselineVersion')='string' AND public.audit_literal(ref_->>'baselineVersion')))
    AND public.audit_keys(ref_->'binding',ARRAY['organizationId','workspaceId','storeId','connectionId','externalStoreId'])
    AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['organizationId','workspaceId','storeId','connectionId']) k WHERE jsonb_typeof(ref_->'binding'->k)<>'string' OR NOT public.audit_id(ref_->'binding'->>k))
    AND jsonb_typeof(ref_->'binding'->'externalStoreId')='string' AND public.audit_literal(ref_->'binding'->>'externalStoreId')
    AND public.audit_entity_valid(ref_)) IS TRUE
$$;

CREATE FUNCTION public.audit_lifecycle_valid(meta_ JSONB) RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT (public.audit_keys(meta_,ARRAY['fromState','toState','reason','expectedRevision','revision','evidenceReference'])
    AND public.audit_number(meta_->'expectedRevision',1) AND public.audit_number(meta_->'revision',1)
    AND CASE WHEN public.audit_number(meta_->'expectedRevision',1) AND public.audit_number(meta_->'revision',1)
      THEN (meta_->>'revision')::numeric=(meta_->>'expectedRevision')::numeric+1 ELSE false END
    AND public.audit_reference_valid(meta_->'evidenceReference') AND meta_->>'fromState' IN ('OPEN','ACKNOWLEDGED')
    AND CASE meta_->>'toState'
      WHEN 'ACKNOWLEDGED' THEN meta_->>'fromState'='OPEN' AND meta_->>'reason'='ACKNOWLEDGED_BY_OPERATOR'
      WHEN 'RESOLVED' THEN meta_->>'reason' IN ('CONDITION_CLEARED','MANUALLY_RESOLVED')
      WHEN 'SUPPRESSED' THEN meta_->>'reason' IN ('FALSE_POSITIVE','DUPLICATE','MAINTENANCE') ELSE false END) IS TRUE
$$;

CREATE FUNCTION public.audit_detail_valid(detail_ JSONB) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE kind_ TEXT:=detail_->>'eventType'; meta_ JSONB:=detail_->'redactedMetadata';
BEGIN
  IF NOT public.audit_keys(detail_,ARRAY['eventType','redactedMetadata']) THEN RETURN false; END IF;
  CASE
    WHEN kind_=ANY(ARRAY['AUTH_LOGIN','AUTH_LOGOUT','AUTHORIZATION','CREDENTIAL_CHANGE','EXPORT','DISCONNECT','DELETE']) THEN
      RETURN public.audit_keys(meta_,ARRAY['reasonCode']) AND public.audit_reason(meta_->'reasonCode');
    WHEN kind_='ROLE_CHANGE' THEN
      RETURN public.audit_keys(meta_,ARRAY['previousRole','nextRole']) AND public.audit_enum(meta_->'previousRole',ARRAY['OWNER','ADMIN','OPERATOR','ANALYST','VIEWER'],true)
        AND public.audit_enum(meta_->'nextRole',ARRAY['OWNER','ADMIN','OPERATOR','ANALYST','VIEWER'],true);
    WHEN kind_=ANY(ARRAY['PROPOSAL','APPROVAL','REJECTION','EXECUTION','VERIFICATION','COMPENSATION']) THEN
      RETURN public.audit_keys(meta_,ARRAY['actionKind','oldPriceMinor','newPriceMinor','reasonCode']) AND public.audit_enum(meta_->'actionKind',ARRAY['PRICE','INVENTORY','PRODUCT'])
        AND (meta_->'oldPriceMinor'='null'::jsonb OR public.audit_number(meta_->'oldPriceMinor'))
        AND (meta_->'newPriceMinor'='null'::jsonb OR public.audit_number(meta_->'newPriceMinor')) AND public.audit_reason(meta_->'reasonCode');
    WHEN kind_='AGENT_RUN' THEN
      RETURN public.audit_keys(meta_,ARRAY['runStatus']) AND public.audit_enum(meta_->'runStatus',ARRAY['STARTED','COMPLETED','FAILED','STOPPED']);
    WHEN kind_=ANY(ARRAY['NOTIFICATION_INTENT','NOTIFICATION_DELIVERY','NOTIFICATION_READ','NOTIFICATION_PREFERENCE','BRIEF']) THEN
      RETURN public.audit_keys(meta_,ARRAY['channel','deliveryStatus']) AND meta_->'channel'='"IN_APP"'::jsonb
        AND public.audit_enum(meta_->'deliveryStatus',ARRAY['PENDING','DELIVERED','READ','FAILED','NOT_APPLICABLE']);
    WHEN kind_='EVENT_STATE_CHANGE' THEN RETURN public.audit_lifecycle_valid(meta_);
    ELSE RETURN false;
  END CASE;
END $$;

CREATE TABLE public.audit_logs (
  "auditId" TEXT COLLATE "C" PRIMARY KEY CHECK (public.audit_id("auditId")),
  "organizationId" TEXT COLLATE "C" NOT NULL,
  "workspaceId" TEXT COLLATE "C" NOT NULL,
  "storeId" TEXT COLLATE "C" NOT NULL,
  "actorId" TEXT COLLATE "C" NOT NULL CHECK (public.audit_id("actorId")),
  "actorKind" TEXT NOT NULL CHECK ("actorKind" IN ('USER','SERVICE','SYSTEM')),
  "requestId" TEXT COLLATE "C" NOT NULL CHECK (public.audit_id("requestId")),
  "occurrenceId" TEXT COLLATE "C" NOT NULL CHECK (public.audit_id("occurrenceId")),
  sequence BIGINT NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  "prevHash" TEXT COLLATE "C" CHECK ("prevHash" ~ '^[a-f0-9]{64}$'),
  "entryHash" TEXT COLLATE "C" NOT NULL CHECK ("entryHash" ~ '^[a-f0-9]{64}$'),
  "hashVersion" INTEGER NOT NULL CHECK ("hashVersion"=1),
  "redactionVersion" INTEGER NOT NULL CHECK ("redactionVersion"=1),
  payload JSONB NOT NULL,
  CONSTRAINT audit_logs_store_fkey FOREIGN KEY ("organizationId","workspaceId","storeId") REFERENCES public."Store"("organizationId","workspaceId",id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT audit_logs_org_sequence_key UNIQUE ("organizationId",sequence),
  CONSTRAINT audit_logs_occurrence_key UNIQUE ("organizationId","requestId","occurrenceId"),
  CONSTRAINT audit_logs_anchor_key UNIQUE ("organizationId","workspaceId","storeId",sequence,"entryHash","hashVersion")
);
CREATE INDEX audit_logs_scope_history_idx ON public.audit_logs ("organizationId","workspaceId","storeId",sequence);
CREATE TABLE public.audit_checkpoints (
  "organizationId" TEXT COLLATE "C" NOT NULL,
  "workspaceId" TEXT COLLATE "C" NOT NULL,
  "storeId" TEXT COLLATE "C" NOT NULL,
  sequence BIGINT NOT NULL,
  "entryHash" TEXT COLLATE "C" NOT NULL,
  "hashVersion" INTEGER NOT NULL CHECK ("hashVersion"=1),
  "checkpointVersion" INTEGER NOT NULL DEFAULT 1 CHECK ("checkpointVersion"=1),
  PRIMARY KEY ("organizationId",sequence),
  CONSTRAINT audit_checkpoints_anchor_fkey FOREIGN KEY ("organizationId","workspaceId","storeId",sequence,"entryHash","hashVersion") REFERENCES public.audit_logs("organizationId","workspaceId","storeId",sequence,"entryHash","hashVersion") ON DELETE RESTRICT ON UPDATE NO ACTION
);
-- Provisioner-only mapping: actor IDs are never human user FKs or body-controlled capabilities.
CREATE TABLE public.audit_service_grants (
  "loginRole" TEXT COLLATE "C" NOT NULL,
  "organizationId" TEXT COLLATE "C" NOT NULL,
  "workspaceId" TEXT COLLATE "C" NOT NULL,
  "storeId" TEXT COLLATE "C" NOT NULL,
  "actorId" TEXT COLLATE "C" NOT NULL CHECK (public.audit_id("actorId")),
  "actorKind" TEXT NOT NULL CHECK ("actorKind" IN ('SERVICE','SYSTEM')),
  "authorizedByUserId" TEXT NOT NULL,
  PRIMARY KEY ("loginRole","organizationId","workspaceId","storeId"),
  FOREIGN KEY ("organizationId","workspaceId","storeId") REFERENCES public."Store"("organizationId","workspaceId",id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  FOREIGN KEY ("organizationId","authorizedByUserId") REFERENCES public."OrganizationMember"("organizationId","userId") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE TABLE public.auth_security_events (
  "auditId" TEXT COLLATE "C" PRIMARY KEY CHECK (public.audit_id("auditId")),
  payload JSONB NOT NULL
);

CREATE FUNCTION public.audit_resource_valid(payload_ JSONB) RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT (CASE WHEN payload_->'event'->>'eventType'='EVENT_STATE_CHANGE' THEN
    public.audit_keys(payload_->'resource',ARRAY['type','id']) AND payload_->'resource'->>'type'='EVENT'
    AND jsonb_typeof(payload_->'resource'->'id')='string' AND public.audit_literal(payload_->'resource'->>'id')
    AND payload_->>'occurredAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{0,3}0*)?Z$'
    AND payload_->'actor'->>'actorKind'='USER' AND payload_->>'result'='SUCCESS' AND payload_->'sourceOccurredAt'='null'::jsonb
    AND ((payload_->'event'->'redactedMetadata'->'evidenceReference'->'binding')-ARRAY['connectionId','externalStoreId'])=payload_->'scope'
    AND (payload_->'links')-ARRAY['requestId','occurrenceId']=jsonb_build_object('runId',null,'evidenceId',null,'actionId',null,'revisionId',null,'approvalId',null,'executionId',null)
    ELSE payload_->'resource'='null'::jsonb OR (public.audit_keys(payload_->'resource',ARRAY['type','id'])
      AND public.audit_enum(payload_->'resource'->'type',ARRAY['ORGANIZATION','WORKSPACE','STORE','PRODUCT','SKU','ORDER','PROPOSAL','EXECUTION','NOTIFICATION','RUN','CONNECTION','EXPORT','SESSION'])
      AND jsonb_typeof(payload_->'resource'->'id')='string' AND public.audit_id(payload_->'resource'->>'id')) END) IS TRUE
$$;
CREATE FUNCTION public.audit_payload_valid(row_ public.audit_logs) RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT (public.audit_keys(row_.payload,ARRAY['scopeKind','scope','actor','resource','result','occurredAt','sourceOccurredAt','links','event'])
    AND row_.payload->'scopeKind'='"TENANT"'::jsonb
    AND row_.payload->'scope'=jsonb_build_object('organizationId',row_."organizationId",'workspaceId',row_."workspaceId",'storeId',row_."storeId")
    AND public.audit_id(row_."organizationId") AND public.audit_id(row_."workspaceId") AND public.audit_id(row_."storeId")
    AND row_.payload->'actor'=jsonb_build_object('actorId',row_."actorId",'actorKind',row_."actorKind",'identitySource','SERVER')
    AND public.audit_enum(row_.payload->'result',ARRAY['SUCCESS','REJECTED','FAILED','UNKNOWN'])
    AND public.audit_timestamp(row_.payload->'occurredAt')
    AND (row_.payload->'sourceOccurredAt'='null'::jsonb OR public.audit_timestamp(row_.payload->'sourceOccurredAt'))
    AND public.audit_keys(row_.payload->'links',ARRAY['requestId','occurrenceId','runId','evidenceId','actionId','revisionId','approvalId','executionId'])
    AND row_.payload->'links'->>'requestId'=row_."requestId" AND row_.payload->'links'->>'occurrenceId'=row_."occurrenceId"
    AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['requestId','occurrenceId','runId','evidenceId','actionId','revisionId','approvalId','executionId']) k
      WHERE NOT (row_.payload->'links'->k='null'::jsonb OR (jsonb_typeof(row_.payload->'links'->k)='string' AND public.audit_id(row_.payload->'links'->>k))))
    AND public.audit_detail_valid(row_.payload->'event') AND public.audit_resource_valid(row_.payload)) IS TRUE
$$;

CREATE FUNCTION public.audit_anonymous_valid(payload_ JSONB) RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT (public.audit_keys(payload_,ARRAY['scopeKind','scope','actor','requestId','occurredAt','result','reason','redactedMetadata'])
    AND payload_->'scopeKind'='"ANONYMOUS_AUTH_SECURITY"'::jsonb AND payload_->'scope'='null'::jsonb AND payload_->'actor'='null'::jsonb
    AND jsonb_typeof(payload_->'requestId')='string' AND public.audit_id(payload_->>'requestId') AND public.audit_timestamp(payload_->'occurredAt')
    AND public.audit_enum(payload_->'result',ARRAY['REJECTED','FAILED'])
    AND public.audit_enum(payload_->'reason',ARRAY['UNKNOWN_IDENTITY','INVALID_CREDENTIALS','EXPIRED_SESSION','RATE_LIMITED','UNAUTHORIZED'])
    AND public.audit_keys(payload_->'redactedMetadata',ARRAY['attemptClass','rateLimited'])
    AND public.audit_enum(payload_->'redactedMetadata'->'attemptClass',ARRAY['LOGIN','SESSION','TOKEN'])
    AND jsonb_typeof(payload_->'redactedMetadata'->'rateLimited')='boolean') IS TRUE
$$;
ALTER TABLE public.audit_logs ADD CONSTRAINT audit_logs_payload_check CHECK (public.audit_payload_valid(audit_logs));
ALTER TABLE public.auth_security_events ADD CONSTRAINT auth_security_payload_check CHECK (public.audit_anonymous_valid(payload));

-- Private to the chain role. The login and complete current binding select at most one provisioned authorizer.
CREATE FUNCTION public.audit_service_authorizer() RETURNS TEXT LANGUAGE SQL STABLE SET search_path=pg_catalog AS $$
  SELECT g."authorizedByUserId" FROM public.audit_service_grants g
    WHERE pg_has_role(session_user,'shopmate_audit_service_writer','MEMBER') AND g."loginRole"=session_user
      AND g."organizationId"=current_setting('app.organization_id',true) AND g."workspaceId"=current_setting('app.workspace_id',true)
      AND g."storeId"=current_setting('app.store_id',true)
$$;
CREATE FUNCTION public.audit_member_access(org_ TEXT, workspace_ TEXT, store_ TEXT, user_ TEXT) RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM public."Store" s JOIN public."Organization" o ON o.id=s."organizationId"
    JOIN public."Workspace" w ON w.id=s."workspaceId" AND w."organizationId"=o.id
    JOIN public."OrganizationMember" m ON m."organizationId"=o.id AND m."userId"=user_
    WHERE s.id=store_ AND o.id=org_ AND w.id=workspace_ AND m.status='ACTIVE' AND o.status='ACTIVE' AND w.status='ACTIVE'
      AND (m.role IN ('OWNER','ADMIN') OR EXISTS (SELECT 1 FROM public."WorkspaceMember" wm
        WHERE wm."organizationId"=o.id AND wm."workspaceId"=w.id AND wm."userId"=user_ AND wm.status='ACTIVE')))
$$;
CREATE FUNCTION public.audit_scope_access(org_ TEXT, workspace_ TEXT, store_ TEXT, service_ BOOLEAN DEFAULT false) RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT (current_setting('transaction_isolation')='read committed'
    AND org_=current_setting('app.organization_id',true) AND workspace_=current_setting('app.workspace_id',true) AND store_=current_setting('app.store_id',true)
    AND CASE WHEN service_ THEN public.audit_member_access(org_,workspace_,store_,public.audit_service_authorizer())
    ELSE (pg_has_role(session_user,'shopmate_audit_reader','MEMBER') OR pg_has_role(session_user,'shopmate_audit_writer','MEMBER'))
      AND public.audit_member_access(org_,workspace_,store_,nullif(current_setting('app.user_id',true),'')) END) IS TRUE
$$;
CREATE FUNCTION public.audit_actor_access(row_ public.audit_logs) RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT (CASE WHEN row_."actorKind"='USER' THEN pg_has_role(session_user,'shopmate_audit_writer','MEMBER')
    AND row_."actorId"=current_setting('app.user_id',true) AND public.audit_scope_access(row_."organizationId",row_."workspaceId",row_."storeId",false)
    ELSE public.audit_scope_access(row_."organizationId",row_."workspaceId",row_."storeId",true) AND EXISTS (
      SELECT 1 FROM public.audit_service_grants g WHERE g."loginRole"=session_user AND g."organizationId"=row_."organizationId" AND g."workspaceId"=row_."workspaceId" AND g."storeId"=row_."storeId"
        AND g."actorKind"=row_."actorKind" AND g."actorId"=row_."actorId") END) IS TRUE
$$;
-- Only scalar chain state escapes the privileged role; payload is never granted to it.
CREATE FUNCTION public.audit_chain_head(org_ TEXT, workspace_ TEXT, store_ TEXT)
RETURNS TABLE(sequence BIGINT,"entryHash" TEXT) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NOT (public.audit_scope_access(org_,workspace_,store_,false) AND pg_has_role(session_user,'shopmate_audit_writer','MEMBER'))
    AND NOT public.audit_scope_access(org_,workspace_,store_,true) THEN
    RAISE EXCEPTION 'Audit scope denied' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('shopmate.audit.chain.v1:'||org_,0));
  -- Recheck authorization after waiting; READ COMMITTED is mandatory for the new head.
  IF NOT (public.audit_scope_access(org_,workspace_,store_,false) AND pg_has_role(session_user,'shopmate_audit_writer','MEMBER'))
    AND NOT public.audit_scope_access(org_,workspace_,store_,true) THEN
    RAISE EXCEPTION 'Audit scope denied' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT l.sequence,l."entryHash" FROM public.audit_logs l WHERE l."organizationId"=org_ ORDER BY l.sequence DESC LIMIT 1;
  IF NOT FOUND THEN RETURN QUERY SELECT 0::bigint,NULL::text; END IF;
END $$;
CREATE FUNCTION public.audit_append_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tail_ RECORD;
BEGIN
  IF NOT public.audit_actor_access(NEW) THEN RAISE EXCEPTION 'Audit actor denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO tail_ FROM public.audit_chain_head(NEW."organizationId",NEW."workspaceId",NEW."storeId");
  -- A grant can rotate actors without revoking scope while the head waits for the lock.
  IF NOT public.audit_actor_access(NEW) THEN RAISE EXCEPTION 'Audit actor denied' USING ERRCODE='42501'; END IF;
  IF NEW.sequence IS DISTINCT FROM tail_.sequence+1 OR NEW."prevHash" IS DISTINCT FROM tail_."entryHash" THEN
    RAISE EXCEPTION 'Audit chain position invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION public.audit_immutable() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Audit history is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER audit_logs_append BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.audit_append_guard();
DO $$
DECLARE table_ TEXT;
BEGIN
  FOREACH table_ IN ARRAY ARRAY['audit_logs','audit_checkpoints','auth_security_events'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.audit_immutable()',table_||'_immutable',table_);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.audit_immutable()',table_||'_no_truncate',table_);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,shopmate_audit_reader,shopmate_audit_writer,shopmate_audit_service_writer,shopmate_auth_security_writer,shopmate_audit_chain',table_);
  END LOOP;
END $$;
REVOKE ALL ON public.audit_service_grants FROM PUBLIC,shopmate_audit_reader,shopmate_audit_writer,shopmate_audit_service_writer,shopmate_auth_security_writer;
GRANT USAGE ON SCHEMA public TO shopmate_audit_reader,shopmate_audit_writer,shopmate_audit_service_writer,shopmate_auth_security_writer,shopmate_audit_chain;
GRANT SELECT ON public.audit_logs,public.audit_checkpoints TO shopmate_audit_reader,shopmate_audit_writer,shopmate_audit_service_writer;
GRANT INSERT ON public.audit_logs,public.audit_checkpoints TO shopmate_audit_writer,shopmate_audit_service_writer;
GRANT INSERT ON public.auth_security_events TO shopmate_auth_security_writer;
GRANT SELECT ("organizationId",sequence,"entryHash") ON public.audit_logs TO shopmate_audit_chain;
GRANT SELECT (id,status) ON public."Organization" TO shopmate_audit_chain;
GRANT SELECT (id,"organizationId",status) ON public."Workspace" TO shopmate_audit_chain;
GRANT SELECT (id,"organizationId","workspaceId") ON public."Store" TO shopmate_audit_chain;
GRANT SELECT ("organizationId","userId",status,role) ON public."OrganizationMember" TO shopmate_audit_chain;
GRANT SELECT ("organizationId","workspaceId","userId",status) ON public."WorkspaceMember" TO shopmate_audit_chain;
GRANT SELECT ON public.audit_service_grants TO shopmate_audit_chain;
-- Forced tenant RLS normally follows the bound human. Only this NOLOGIN role can resolve
-- active rows for the mapped authorizer, while the service keeps its own principal binding.
CREATE POLICY audit_service_org ON public."Organization" FOR SELECT TO shopmate_audit_chain
  USING (status='ACTIVE' AND id=current_setting('app.organization_id',true) AND public.audit_service_authorizer() IS NOT NULL);
CREATE POLICY audit_service_workspace ON public."Workspace" FOR SELECT TO shopmate_audit_chain
  USING (status='ACTIVE' AND "organizationId"=current_setting('app.organization_id',true)
    AND id=current_setting('app.workspace_id',true) AND public.audit_service_authorizer() IS NOT NULL);
CREATE POLICY audit_service_member ON public."OrganizationMember" FOR SELECT TO shopmate_audit_chain
  USING (status='ACTIVE' AND "organizationId"=current_setting('app.organization_id',true) AND "userId"=public.audit_service_authorizer());
CREATE POLICY audit_service_workspace_member ON public."WorkspaceMember" FOR SELECT TO shopmate_audit_chain
  USING (status='ACTIVE' AND "organizationId"=current_setting('app.organization_id',true)
    AND "workspaceId"=current_setting('app.workspace_id',true) AND "userId"=public.audit_service_authorizer());
CREATE POLICY audit_chain_internal ON public.audit_logs FOR SELECT TO shopmate_audit_chain USING (true);
DO $$
DECLARE table_ TEXT;
BEGIN
  FOREACH table_ IN ARRAY ARRAY['audit_logs','audit_checkpoints'] LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO shopmate_audit_reader,shopmate_audit_writer USING (public.audit_scope_access("organizationId","workspaceId","storeId",false))',table_||'_read',table_);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO shopmate_audit_service_writer USING (public.audit_scope_access("organizationId","workspaceId","storeId",true))',table_||'_service_read',table_);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO shopmate_audit_writer WITH CHECK (public.audit_scope_access("organizationId","workspaceId","storeId",false))',table_||'_append',table_);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO shopmate_audit_service_writer WITH CHECK (public.audit_scope_access("organizationId","workspaceId","storeId",true))',table_||'_service_append',table_);
  END LOOP;
END $$;
CREATE POLICY auth_security_append ON public.auth_security_events FOR INSERT TO shopmate_auth_security_writer WITH CHECK (true);
-- No LOGIN or membership in internal owner role is provisioned by this migration.
ALTER FUNCTION public.audit_service_authorizer() OWNER TO shopmate_audit_chain;
ALTER FUNCTION public.audit_member_access(TEXT,TEXT,TEXT,TEXT) OWNER TO shopmate_audit_chain;
ALTER FUNCTION public.audit_scope_access(TEXT,TEXT,TEXT,BOOLEAN) OWNER TO shopmate_audit_chain;
ALTER FUNCTION public.audit_actor_access(public.audit_logs) OWNER TO shopmate_audit_chain;
ALTER FUNCTION public.audit_chain_head(TEXT,TEXT,TEXT) OWNER TO shopmate_audit_chain;
DO $$
DECLARE function_ REGPROCEDURE;
BEGIN
  FOR function_ IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'audit\_%' ESCAPE '\' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',function_);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.audit_id(TEXT),public.audit_keys(JSONB,TEXT[]),public.audit_enum(JSONB,TEXT[],BOOLEAN),public.audit_timestamp(JSONB),public.audit_anonymous_valid(JSONB) TO shopmate_auth_security_writer;
GRANT EXECUTE ON FUNCTION public.audit_id(TEXT),public.audit_keys(JSONB,TEXT[]),public.audit_enum(JSONB,TEXT[],BOOLEAN),public.audit_number(JSONB,BIGINT),public.audit_timestamp(JSONB),public.audit_reason(JSONB),
  public.audit_entity_valid(JSONB),public.audit_reference_valid(JSONB),public.audit_lifecycle_valid(JSONB),public.audit_detail_valid(JSONB),public.audit_resource_valid(JSONB),public.audit_payload_valid(public.audit_logs),public.audit_actor_access(public.audit_logs) TO shopmate_audit_writer,shopmate_audit_service_writer;
GRANT EXECUTE ON FUNCTION public.audit_scope_access(TEXT,TEXT,TEXT,BOOLEAN) TO shopmate_audit_reader,shopmate_audit_writer,shopmate_audit_service_writer;
GRANT EXECUTE ON FUNCTION public.audit_chain_head(TEXT,TEXT,TEXT) TO shopmate_audit_writer,shopmate_audit_service_writer;
GRANT EXECUTE ON FUNCTION public.audit_literal(TEXT) TO shopmate_audit_writer,shopmate_audit_service_writer;
COMMIT;

BEGIN;
DO $$
DECLARE name_ TEXT;
BEGIN
  FOREACH name_ IN ARRAY ARRAY['shopmate_notification_enqueuer','shopmate_notification_worker','shopmate_notification_recipient','shopmate_notification_guard'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=name_) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION',name_);
    ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=name_ AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
      RAISE EXCEPTION 'Unsafe notification capability role' USING ERRCODE='42501';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid='shopmate_notification_guard'::regrole
    OR member IN ('shopmate_notification_enqueuer'::regrole,'shopmate_notification_worker'::regrole,'shopmate_notification_recipient'::regrole,'shopmate_notification_guard'::regrole)) THEN
    RAISE EXCEPTION 'Private notification guard has members' USING ERRCODE='42501';
  END IF;
END $$;

CREATE FUNCTION public.notification_id(value_ TEXT) RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT value_ ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
$$;
CREATE FUNCTION public.notification_literal(value_ TEXT) RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT length(value_)+length(regexp_replace(value_,U&'[\0001-\FFFF]','','g')) BETWEEN 1 AND 256
    AND octet_length(value_)<=768
    AND value_=btrim(value_,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
    AND value_ !~ U&'[\0001-\001F\007F-\009F\200B-\200F\202A-\202E\2066-\2069]'
$$;
CREATE FUNCTION public.notification_time(value_ TIMESTAMPTZ) RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT isfinite(value_) AND value_>='0001-01-01 00:00:00+00 BC'::timestamptz
    AND value_<='9999-12-31 23:59:59.999+00'::timestamptz
$$;

CREATE TABLE public.notification_outbox (
  "rowId" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "intentId" TEXT COLLATE "C" NOT NULL,
  "organizationId" TEXT COLLATE "C" NOT NULL,
  "workspaceId" TEXT COLLATE "C" NOT NULL,
  "storeId" TEXT COLLATE "C" NOT NULL,
  "connectionId" TEXT COLLATE "C" NOT NULL,
  "externalStoreId" TEXT COLLATE "C" NOT NULL,
  "recipientUserId" TEXT COLLATE "C" NOT NULL,
  "eventId" TEXT COLLATE "C" NOT NULL,
  "eventState" TEXT COLLATE "C" NOT NULL,
  "eventRevision" BIGINT NOT NULL,
  "channel" TEXT COLLATE "C" NOT NULL,
  "decisionRunId" TEXT COLLATE "C" NOT NULL,
  "route" TEXT COLLATE "C" NOT NULL,
  "eventType" TEXT COLLATE "C" NOT NULL,
  "severity" TEXT COLLATE "C" NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "notBefore" TIMESTAMPTZ(3) NOT NULL,
  "evidenceId" TEXT COLLATE "C" NOT NULL,
  "evidenceVersion" TEXT COLLATE "C" NOT NULL,
  "evidenceHash" TEXT COLLATE "C" NOT NULL,
  "entityKind" TEXT COLLATE "C" NOT NULL,
  "entityId" TEXT COLLATE "C",
  "definitionVersion" TEXT COLLATE "C" NOT NULL,
  "baselineVersion" TEXT COLLATE "C",
  "connectionGeneration" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempt" BIGINT NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMPTZ(3),
  "leaseToken" TEXT COLLATE "C",
  "leaseUntil" TIMESTAMPTZ(3),
  "deliveredAt" TIMESTAMPTZ(3)
);

CREATE TABLE public.recipient_inbox (
  "outboxId" UUID NOT NULL PRIMARY KEY,
  "intentId" TEXT COLLATE "C" NOT NULL,
  "organizationId" TEXT COLLATE "C" NOT NULL,
  "workspaceId" TEXT COLLATE "C" NOT NULL,
  "storeId" TEXT COLLATE "C" NOT NULL,
  "connectionId" TEXT COLLATE "C" NOT NULL,
  "externalStoreId" TEXT COLLATE "C" NOT NULL,
  "recipientUserId" TEXT COLLATE "C" NOT NULL,
  "eventId" TEXT COLLATE "C" NOT NULL,
  "eventState" TEXT COLLATE "C" NOT NULL,
  "eventRevision" BIGINT NOT NULL,
  "channel" TEXT COLLATE "C" NOT NULL,
  "decisionRunId" TEXT COLLATE "C" NOT NULL,
  "route" TEXT COLLATE "C" NOT NULL,
  "eventType" TEXT COLLATE "C" NOT NULL,
  "severity" TEXT COLLATE "C" NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "notBefore" TIMESTAMPTZ(3) NOT NULL,
  "evidenceId" TEXT COLLATE "C" NOT NULL,
  "evidenceVersion" TEXT COLLATE "C" NOT NULL,
  "evidenceHash" TEXT COLLATE "C" NOT NULL,
  "entityKind" TEXT COLLATE "C" NOT NULL,
  "entityId" TEXT COLLATE "C",
  "definitionVersion" TEXT COLLATE "C" NOT NULL,
  "baselineVersion" TEXT COLLATE "C",
  "deliveredAt" TIMESTAMPTZ(3) NOT NULL,
  "readAt" TIMESTAMPTZ(3)
);

CREATE TABLE public.notification_worker_grants (
  "databaseRole" TEXT COLLATE "C" NOT NULL,
  "connectionId" TEXT COLLATE "C" NOT NULL,
  "organizationId" TEXT COLLATE "C" NOT NULL,
  "workspaceId" TEXT COLLATE "C" NOT NULL,
  "storeId" TEXT COLLATE "C" NOT NULL,
  "externalStoreId" TEXT COLLATE "C" NOT NULL,
  "principalUserId" TEXT COLLATE "C" NOT NULL,
  "connectionGeneration" INTEGER NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true
);

ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_connection_fkey FOREIGN KEY ("connectionId","organizationId","workspaceId","storeId","externalStoreId") REFERENCES public."PlatformConnection"(id,"organizationId","workspaceId","storeId","externalStoreId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_recipient_fkey FOREIGN KEY ("organizationId","recipientUserId") REFERENCES public."OrganizationMember"("organizationId","userId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_natural_key UNIQUE ("organizationId","workspaceId","storeId","connectionId","externalStoreId","eventId","eventState","eventRevision","recipientUserId","channel");
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_intent_key UNIQUE ("organizationId","workspaceId","storeId","connectionId","externalStoreId","recipientUserId","intentId");
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_organizationId_check CHECK (public.notification_id("organizationId") IS TRUE);
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_workspaceId_check CHECK (public.notification_id("workspaceId") IS TRUE);
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_storeId_check CHECK (public.notification_id("storeId") IS TRUE);
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_connectionId_check CHECK (public.notification_id("connectionId") IS TRUE);
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_recipientUserId_check CHECK (public.notification_id("recipientUserId") IS TRUE);
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_intentId_check CHECK (public.notification_literal("intentId") IS TRUE);
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_externalStoreId_check CHECK (public.notification_literal("externalStoreId") IS TRUE);
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_eventId_check CHECK (public.notification_literal("eventId") IS TRUE);
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_decisionRunId_check CHECK (public.notification_literal("decisionRunId") IS TRUE);
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_evidenceId_check CHECK (public.notification_literal("evidenceId") IS TRUE);
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_evidenceVersion_check CHECK (public.notification_literal("evidenceVersion") IS TRUE);
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_evidenceHash_check CHECK (public.notification_literal("evidenceHash") IS TRUE);
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_definitionVersion_check CHECK (public.notification_literal("definitionVersion") IS TRUE);
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_reference_check CHECK ((
  ("baselineVersion" IS NULL OR public.notification_literal("baselineVersion"))
  AND "eventRevision" BETWEEN 1 AND 9007199254740991
  AND "eventState" IN ('OPEN','ACKNOWLEDGED','RESOLVED','SUPPRESSED') AND channel='IN_APP'
  AND route IN ('DAILY_BRIEF','NOTIFY_NOW','ESCALATE') AND severity IN ('INFO','LOW','MEDIUM','HIGH','CRITICAL')
  AND "eventType" IN ('REVENUE_DROP','REFUND_SPIKE','CANCELLED_ORDER_SPIKE','PROFIT_MARGIN_DROP','UNUSUAL_DISCOUNT','CONVERSION_DROP','STOCKOUT_RISK','INVENTORY_STAGNATION','PRODUCT_BREAKOUT','ROAS_DROP','AD_SPEND_SPIKE','SYNC_FAILURE')
  AND CASE "entityKind"
    WHEN 'STORE' THEN "entityId" IS NULL AND "eventType" NOT IN ('STOCKOUT_RISK','INVENTORY_STAGNATION','PRODUCT_BREAKOUT','ROAS_DROP','AD_SPEND_SPIKE','SYNC_FAILURE')
    WHEN 'SKU' THEN "entityId" IS NOT NULL AND public.notification_literal("entityId") AND "eventType" NOT IN ('ROAS_DROP','AD_SPEND_SPIKE','SYNC_FAILURE')
    WHEN 'CAMPAIGN' THEN "entityId" IS NOT NULL AND public.notification_literal("entityId") AND "eventType" IN ('ROAS_DROP','AD_SPEND_SPIKE')
    WHEN 'CONNECTION' THEN "entityId" IS NOT NULL AND "entityId"="connectionId" AND "eventType"='SYNC_FAILURE'
    ELSE false END) IS TRUE);
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_time_check CHECK ((
  public.notification_time("createdAt") AND public.notification_time("notBefore") AND "notBefore">="createdAt") IS TRUE);

ALTER TABLE public.recipient_inbox ADD CONSTRAINT recipient_inbox_connection_fkey FOREIGN KEY ("connectionId","organizationId","workspaceId","storeId","externalStoreId") REFERENCES public."PlatformConnection"(id,"organizationId","workspaceId","storeId","externalStoreId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.recipient_inbox ADD CONSTRAINT recipient_inbox_recipient_fkey FOREIGN KEY ("organizationId","recipientUserId") REFERENCES public."OrganizationMember"("organizationId","userId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.recipient_inbox ADD CONSTRAINT recipient_inbox_natural_key UNIQUE ("organizationId","workspaceId","storeId","connectionId","externalStoreId","eventId","eventState","eventRevision","recipientUserId","channel");
ALTER TABLE public.recipient_inbox ADD CONSTRAINT recipient_inbox_intent_key UNIQUE ("organizationId","workspaceId","storeId","connectionId","externalStoreId","recipientUserId","intentId");
ALTER TABLE public.recipient_inbox ADD CONSTRAINT recipient_inbox_organizationId_check CHECK (public.notification_id("organizationId") IS TRUE);
ALTER TABLE public.recipient_inbox ADD CONSTRAINT recipient_inbox_workspaceId_check CHECK (public.notification_id("workspaceId") IS TRUE);
ALTER TABLE public.recipient_inbox ADD CONSTRAINT recipient_inbox_storeId_check CHECK (public.notification_id("storeId") IS TRUE);
ALTER TABLE public.recipient_inbox ADD CONSTRAINT recipient_inbox_connectionId_check CHECK (public.notification_id("connectionId") IS TRUE);
ALTER TABLE public.recipient_inbox ADD CONSTRAINT recipient_inbox_recipientUserId_check CHECK (public.notification_id("recipientUserId") IS TRUE);
ALTER TABLE public.recipient_inbox ADD CONSTRAINT recipient_inbox_intentId_check CHECK (public.notification_literal("intentId") IS TRUE);
ALTER TABLE public.recipient_inbox ADD CONSTRAINT recipient_inbox_externalStoreId_check CHECK (public.notification_literal("externalStoreId") IS TRUE);
ALTER TABLE public.recipient_inbox ADD CONSTRAINT recipient_inbox_eventId_check CHECK (public.notification_literal("eventId") IS TRUE);
ALTER TABLE public.recipient_inbox ADD CONSTRAINT recipient_inbox_decisionRunId_check CHECK (public.notification_literal("decisionRunId") IS TRUE);
ALTER TABLE public.recipient_inbox ADD CONSTRAINT recipient_inbox_evidenceId_check CHECK (public.notification_literal("evidenceId") IS TRUE);
ALTER TABLE public.recipient_inbox ADD CONSTRAINT recipient_inbox_evidenceVersion_check CHECK (public.notification_literal("evidenceVersion") IS TRUE);
ALTER TABLE public.recipient_inbox ADD CONSTRAINT recipient_inbox_evidenceHash_check CHECK (public.notification_literal("evidenceHash") IS TRUE);
ALTER TABLE public.recipient_inbox ADD CONSTRAINT recipient_inbox_definitionVersion_check CHECK (public.notification_literal("definitionVersion") IS TRUE);
ALTER TABLE public.recipient_inbox ADD CONSTRAINT recipient_inbox_reference_check CHECK ((
  ("baselineVersion" IS NULL OR public.notification_literal("baselineVersion"))
  AND "eventRevision" BETWEEN 1 AND 9007199254740991
  AND "eventState" IN ('OPEN','ACKNOWLEDGED','RESOLVED','SUPPRESSED') AND channel='IN_APP'
  AND route IN ('DAILY_BRIEF','NOTIFY_NOW','ESCALATE') AND severity IN ('INFO','LOW','MEDIUM','HIGH','CRITICAL')
  AND "eventType" IN ('REVENUE_DROP','REFUND_SPIKE','CANCELLED_ORDER_SPIKE','PROFIT_MARGIN_DROP','UNUSUAL_DISCOUNT','CONVERSION_DROP','STOCKOUT_RISK','INVENTORY_STAGNATION','PRODUCT_BREAKOUT','ROAS_DROP','AD_SPEND_SPIKE','SYNC_FAILURE')
  AND CASE "entityKind"
    WHEN 'STORE' THEN "entityId" IS NULL AND "eventType" NOT IN ('STOCKOUT_RISK','INVENTORY_STAGNATION','PRODUCT_BREAKOUT','ROAS_DROP','AD_SPEND_SPIKE','SYNC_FAILURE')
    WHEN 'SKU' THEN "entityId" IS NOT NULL AND public.notification_literal("entityId") AND "eventType" NOT IN ('ROAS_DROP','AD_SPEND_SPIKE','SYNC_FAILURE')
    WHEN 'CAMPAIGN' THEN "entityId" IS NOT NULL AND public.notification_literal("entityId") AND "eventType" IN ('ROAS_DROP','AD_SPEND_SPIKE')
    WHEN 'CONNECTION' THEN "entityId" IS NOT NULL AND "entityId"="connectionId" AND "eventType"='SYNC_FAILURE'
    ELSE false END) IS TRUE);
ALTER TABLE public.recipient_inbox ADD CONSTRAINT recipient_inbox_time_check CHECK ((
  public.notification_time("createdAt") AND public.notification_time("notBefore") AND "notBefore">="createdAt") IS TRUE);

ALTER TABLE public.recipient_inbox ADD CONSTRAINT recipient_inbox_outbox_fkey FOREIGN KEY ("outboxId") REFERENCES public.notification_outbox("rowId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.recipient_inbox ADD CONSTRAINT recipient_inbox_delivery_check CHECK ((
  public.notification_time("deliveredAt") AND "deliveredAt">="notBefore"
  AND ("readAt" IS NULL OR (public.notification_time("readAt") AND "readAt">="deliveredAt"))) IS TRUE);
ALTER TABLE public.notification_worker_grants ADD CONSTRAINT notification_worker_grants_organizationId_check CHECK (public.notification_id("organizationId") IS TRUE);
ALTER TABLE public.notification_worker_grants ADD CONSTRAINT notification_worker_grants_workspaceId_check CHECK (public.notification_id("workspaceId") IS TRUE);
ALTER TABLE public.notification_worker_grants ADD CONSTRAINT notification_worker_grants_storeId_check CHECK (public.notification_id("storeId") IS TRUE);
ALTER TABLE public.notification_worker_grants ADD CONSTRAINT notification_worker_grants_connectionId_check CHECK (public.notification_id("connectionId") IS TRUE);
ALTER TABLE public.notification_worker_grants ADD CONSTRAINT notification_worker_grants_principalUserId_check CHECK (public.notification_id("principalUserId") IS TRUE);
ALTER TABLE public.notification_worker_grants ADD CONSTRAINT notification_worker_grants_external_check CHECK (public.notification_literal("externalStoreId") IS TRUE);
ALTER TABLE public.notification_worker_grants ADD CONSTRAINT notification_worker_grants_pkey PRIMARY KEY ("databaseRole","connectionId");
ALTER TABLE public.notification_worker_grants ADD CONSTRAINT notification_worker_grants_role_check CHECK ("databaseRole" ~ '^[a-z_][a-z0-9_]{0,62}$');
ALTER TABLE public.notification_worker_grants ADD CONSTRAINT notification_worker_grants_generation_check CHECK ("connectionGeneration">=0);
ALTER TABLE public.notification_worker_grants ADD CONSTRAINT notification_worker_grants_connection_fkey FOREIGN KEY ("connectionId","organizationId","workspaceId","storeId","externalStoreId") REFERENCES public."PlatformConnection"(id,"organizationId","workspaceId","storeId","externalStoreId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.notification_worker_grants ADD CONSTRAINT notification_worker_grants_principal_fkey FOREIGN KEY ("organizationId","principalUserId") REFERENCES public."OrganizationMember"("organizationId","userId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_generation_check CHECK ("connectionGeneration">=0);
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_state_check CHECK ((
  attempt BETWEEN 0 AND 9007199254740991 AND CASE status
    WHEN 'PENDING' THEN "nextAttemptAt" IS NOT NULL AND "leaseToken" IS NULL AND "leaseUntil" IS NULL AND "deliveredAt" IS NULL
    WHEN 'LEASED' THEN attempt>=1 AND "nextAttemptAt" IS NULL AND "leaseToken" IS NOT NULL AND public.notification_literal("leaseToken") AND "leaseUntil" IS NOT NULL AND "deliveredAt" IS NULL
    WHEN 'DELIVERED' THEN attempt>=1 AND "nextAttemptAt" IS NULL AND "leaseToken" IS NULL AND "leaseUntil" IS NULL AND "deliveredAt" IS NOT NULL
    WHEN 'FAILED' THEN attempt>=1 AND "leaseToken" IS NULL AND "leaseUntil" IS NULL AND "deliveredAt" IS NULL
    WHEN 'UNKNOWN' THEN attempt>=1 AND "leaseToken" IS NULL AND "leaseUntil" IS NULL AND "deliveredAt" IS NULL
    ELSE false END) IS TRUE);
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_schedule_check CHECK ((
  ("nextAttemptAt" IS NULL OR (public.notification_time("nextAttemptAt") AND "nextAttemptAt">="notBefore"))
  AND ("leaseUntil" IS NULL OR (public.notification_time("leaseUntil") AND "leaseUntil">"notBefore"))
  AND ("deliveredAt" IS NULL OR (public.notification_time("deliveredAt") AND "deliveredAt">="notBefore"))) IS TRUE);
CREATE INDEX notification_outbox_due_idx ON public.notification_outbox("connectionId",status,"nextAttemptAt","rowId");
CREATE INDEX notification_outbox_lease_idx ON public.notification_outbox("connectionId",status,"leaseUntil","rowId");
CREATE INDEX recipient_inbox_page_idx ON public.recipient_inbox("connectionId","recipientUserId","deliveredAt","outboxId");

CREATE FUNCTION public.notification_outbox_immutable() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'PENDING' OR NEW.attempt<>0 OR NEW."nextAttemptAt" IS DISTINCT FROM NEW."notBefore"
      OR NEW."leaseToken" IS NOT NULL OR NEW."leaseUntil" IS NOT NULL OR NEW."deliveredAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid initial notification state' USING ERRCODE='23514';
    END IF;
  ELSIF ROW(NEW."rowId",NEW."intentId",NEW."organizationId",NEW."workspaceId",NEW."storeId",NEW."connectionId",NEW."externalStoreId",NEW."recipientUserId",NEW."eventId",NEW."eventState",NEW."eventRevision",NEW."channel",NEW."decisionRunId",NEW."route",NEW."eventType",NEW."severity",NEW."createdAt",NEW."notBefore",NEW."evidenceId",NEW."evidenceVersion",NEW."evidenceHash",NEW."entityKind",NEW."entityId",NEW."definitionVersion",NEW."baselineVersion",NEW."connectionGeneration")
    IS DISTINCT FROM ROW(OLD."rowId",OLD."intentId",OLD."organizationId",OLD."workspaceId",OLD."storeId",OLD."connectionId",OLD."externalStoreId",OLD."recipientUserId",OLD."eventId",OLD."eventState",OLD."eventRevision",OLD."channel",OLD."decisionRunId",OLD."route",OLD."eventType",OLD."severity",OLD."createdAt",OLD."notBefore",OLD."evidenceId",OLD."evidenceVersion",OLD."evidenceHash",OLD."entityKind",OLD."entityId",OLD."definitionVersion",OLD."baselineVersion",OLD."connectionGeneration")
    OR NEW.attempt<OLD.attempt OR (OLD.status='DELIVERED' AND NEW IS DISTINCT FROM OLD)
    OR (NEW.status='DELIVERED' AND OLD.status NOT IN ('LEASED','DELIVERED')) THEN
    RAISE EXCEPTION 'Immutable notification or invalid transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_outbox_immutable BEFORE INSERT OR UPDATE ON public.notification_outbox FOR EACH ROW EXECUTE FUNCTION public.notification_outbox_immutable();

CREATE FUNCTION public.recipient_inbox_immutable() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF ROW(NEW."outboxId",NEW."intentId",NEW."organizationId",NEW."workspaceId",NEW."storeId",NEW."connectionId",NEW."externalStoreId",NEW."recipientUserId",NEW."eventId",NEW."eventState",NEW."eventRevision",NEW."channel",NEW."decisionRunId",NEW."route",NEW."eventType",NEW."severity",NEW."createdAt",NEW."notBefore",NEW."evidenceId",NEW."evidenceVersion",NEW."evidenceHash",NEW."entityKind",NEW."entityId",NEW."definitionVersion",NEW."baselineVersion",NEW."deliveredAt")
    IS DISTINCT FROM ROW(OLD."outboxId",OLD."intentId",OLD."organizationId",OLD."workspaceId",OLD."storeId",OLD."connectionId",OLD."externalStoreId",OLD."recipientUserId",OLD."eventId",OLD."eventState",OLD."eventRevision",OLD."channel",OLD."decisionRunId",OLD."route",OLD."eventType",OLD."severity",OLD."createdAt",OLD."notBefore",OLD."evidenceId",OLD."evidenceVersion",OLD."evidenceHash",OLD."entityKind",OLD."entityId",OLD."definitionVersion",OLD."baselineVersion",OLD."deliveredAt")
    OR (OLD."readAt" IS NOT NULL AND NEW."readAt" IS DISTINCT FROM OLD."readAt") THEN
    RAISE EXCEPTION 'Immutable inbox projection or first read' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recipient_inbox_immutable BEFORE UPDATE ON public.recipient_inbox FOR EACH ROW EXECUTE FUNCTION public.recipient_inbox_immutable();

ALTER TABLE public.notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE public.recipient_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipient_inbox FORCE ROW LEVEL SECURITY;
ALTER TABLE public.notification_worker_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_worker_grants FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.notification_outbox,public.recipient_inbox,public.notification_worker_grants FROM PUBLIC;

CREATE FUNCTION public.notification_member_access(org_ TEXT, workspace_ TEXT, user_ TEXT, writer_ BOOLEAN) RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM public."OrganizationMember" m
    WHERE m."organizationId"=org_ AND m."userId"=user_ AND m.status='ACTIVE'
      AND (NOT writer_ OR m.role IN ('OWNER','ADMIN','OPERATOR'))
      AND (m.role IN ('OWNER','ADMIN') OR EXISTS (SELECT 1 FROM public."WorkspaceMember" wm
        WHERE wm."organizationId"=org_ AND wm."workspaceId"=workspace_ AND wm."userId"=user_ AND wm.status='ACTIVE')))
$$;
CREATE FUNCTION public.notification_connection_access(org_ TEXT, workspace_ TEXT, store_ TEXT, connection_ TEXT, external_ TEXT, generation_ INTEGER) RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM public."PlatformConnection" c JOIN public."Store" s
    ON (s.id,s."organizationId",s."workspaceId")=(c."storeId",c."organizationId",c."workspaceId")
    JOIN public."Organization" o ON o.id=s."organizationId" AND o."legacyMerchantId"=s."merchantId"
    JOIN public."Workspace" w ON w.id=s."workspaceId" AND w."organizationId"=o.id
    JOIN public."Merchant" m ON m.id=s."merchantId"
    WHERE (c.id,c."organizationId",c."workspaceId",c."storeId",c."externalStoreId")=(connection_,org_,workspace_,store_,external_)
      AND c.status='ACTIVE' AND o.status='ACTIVE' AND w.status='ACTIVE' AND m.status='ACTIVE'
      AND (generation_ IS NULL OR c.generation=generation_))
$$;
CREATE FUNCTION public.notification_scope_access(org_ TEXT, workspace_ TEXT, store_ TEXT, connection_ TEXT, external_ TEXT, recipient_ TEXT, generation_ INTEGER, mode_ TEXT) RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT (current_setting('transaction_isolation')='read committed'
    AND org_=nullif(current_setting('app.organization_id',true),'') AND workspace_=nullif(current_setting('app.workspace_id',true),'')
    AND store_=nullif(current_setting('app.store_id',true),'') AND connection_=nullif(current_setting('app.connection_id',true),'')
    AND external_=nullif(current_setting('app.external_store_id',true),'')
    AND public.notification_connection_access(org_,workspace_,store_,connection_,external_,generation_)
    AND public.notification_member_access(org_,workspace_,recipient_,false)
    AND CASE mode_
      WHEN 'ENQUEUE' THEN generation_ IS NOT NULL AND pg_has_role(SESSION_USER,'shopmate_notification_enqueuer','MEMBER')
        AND public.notification_member_access(org_,workspace_,nullif(current_setting('app.user_id',true),''),true)
      WHEN 'RECIPIENT' THEN generation_ IS NULL AND pg_has_role(SESSION_USER,'shopmate_notification_recipient','MEMBER')
        AND recipient_=nullif(current_setting('app.user_id',true),'')
      WHEN 'WORKER' THEN generation_ IS NOT NULL AND pg_has_role(SESSION_USER,'shopmate_notification_worker','MEMBER')
        AND EXISTS (SELECT 1 FROM public.notification_worker_grants g WHERE g."databaseRole"=SESSION_USER
          AND g.active AND (g."organizationId",g."workspaceId",g."storeId",g."connectionId",g."externalStoreId",g."connectionGeneration")
            =(org_,workspace_,store_,connection_,external_,generation_)
          AND g."principalUserId"=nullif(current_setting('app.user_id',true),'')
          AND public.notification_member_access(org_,workspace_,g."principalUserId",true))
      ELSE false END) IS TRUE
$$;
CREATE FUNCTION public.notification_project_delivery() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.status='DELIVERED' AND OLD.status='LEASED' THEN
    INSERT INTO public.recipient_inbox ("outboxId","intentId","organizationId","workspaceId","storeId","connectionId","externalStoreId","recipientUserId","eventId","eventState","eventRevision","channel","decisionRunId","route","eventType","severity","createdAt","notBefore","evidenceId","evidenceVersion","evidenceHash","entityKind","entityId","definitionVersion","baselineVersion","deliveredAt")
      VALUES (NEW."rowId",NEW."intentId",NEW."organizationId",NEW."workspaceId",NEW."storeId",NEW."connectionId",NEW."externalStoreId",NEW."recipientUserId",NEW."eventId",NEW."eventState",NEW."eventRevision",NEW."channel",NEW."decisionRunId",NEW."route",NEW."eventType",NEW."severity",NEW."createdAt",NEW."notBefore",NEW."evidenceId",NEW."evidenceVersion",NEW."evidenceHash",NEW."entityKind",NEW."entityId",NEW."definitionVersion",NEW."baselineVersion",NEW."deliveredAt")
      ON CONFLICT ("outboxId") DO NOTHING;
    IF NOT EXISTS (SELECT 1 FROM public.recipient_inbox i WHERE i."outboxId"=NEW."rowId"
      AND ROW(i."intentId",i."organizationId",i."workspaceId",i."storeId",i."connectionId",i."externalStoreId",i."recipientUserId",i."eventId",i."eventState",i."eventRevision",i."channel",i."decisionRunId",i."route",i."eventType",i."severity",i."createdAt",i."notBefore",i."evidenceId",i."evidenceVersion",i."evidenceHash",i."entityKind",i."entityId",i."definitionVersion",i."baselineVersion",i."deliveredAt")
        IS NOT DISTINCT FROM ROW(NEW."intentId",NEW."organizationId",NEW."workspaceId",NEW."storeId",NEW."connectionId",NEW."externalStoreId",NEW."recipientUserId",NEW."eventId",NEW."eventState",NEW."eventRevision",NEW."channel",NEW."decisionRunId",NEW."route",NEW."eventType",NEW."severity",NEW."createdAt",NEW."notBefore",NEW."evidenceId",NEW."evidenceVersion",NEW."evidenceHash",NEW."entityKind",NEW."entityId",NEW."definitionVersion",NEW."baselineVersion",NEW."deliveredAt")) THEN
      RAISE EXCEPTION 'Conflicting notification projection' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_project_delivery AFTER UPDATE ON public.notification_outbox FOR EACH ROW EXECUTE FUNCTION public.notification_project_delivery();

GRANT USAGE ON SCHEMA public TO shopmate_notification_enqueuer,shopmate_notification_worker,shopmate_notification_recipient,shopmate_notification_guard;
GRANT SELECT ON public.notification_outbox,public.recipient_inbox TO shopmate_notification_enqueuer,shopmate_notification_worker;
GRANT INSERT ("intentId","organizationId","workspaceId","storeId","connectionId","externalStoreId","recipientUserId","eventId","eventState","eventRevision","channel","decisionRunId","route","eventType","severity","createdAt","notBefore","evidenceId","evidenceVersion","evidenceHash","entityKind","entityId","definitionVersion","baselineVersion","connectionGeneration","nextAttemptAt") ON public.notification_outbox TO shopmate_notification_enqueuer;
GRANT UPDATE (status,attempt,"nextAttemptAt","leaseToken","leaseUntil","deliveredAt") ON public.notification_outbox TO shopmate_notification_worker;
GRANT SELECT ON public.recipient_inbox TO shopmate_notification_recipient;
GRANT UPDATE ("readAt") ON public.recipient_inbox TO shopmate_notification_recipient;
GRANT SELECT,INSERT ON public.recipient_inbox TO shopmate_notification_guard;
GRANT SELECT ON public.notification_worker_grants TO shopmate_notification_guard;
GRANT SELECT (id,status,"legacyMerchantId") ON public."Organization" TO shopmate_notification_guard;
GRANT SELECT (id,status,"organizationId") ON public."Workspace" TO shopmate_notification_guard;
GRANT SELECT (id,"organizationId","workspaceId","merchantId") ON public."Store" TO shopmate_notification_guard;
GRANT SELECT (id,status) ON public."Merchant" TO shopmate_notification_guard;
GRANT SELECT (id,"organizationId","workspaceId","storeId","externalStoreId",status,generation) ON public."PlatformConnection" TO shopmate_notification_guard;
GRANT SELECT ("organizationId","userId",status,role) ON public."OrganizationMember" TO shopmate_notification_guard;
GRANT SELECT ("organizationId","workspaceId","userId",status) ON public."WorkspaceMember" TO shopmate_notification_guard;
CREATE POLICY notification_guard_read ON public."Organization" FOR SELECT TO shopmate_notification_guard USING (true);
CREATE POLICY notification_guard_read ON public."Workspace" FOR SELECT TO shopmate_notification_guard USING (true);
CREATE POLICY notification_guard_read ON public."Store" FOR SELECT TO shopmate_notification_guard USING (true);
CREATE POLICY notification_guard_read ON public."Merchant" FOR SELECT TO shopmate_notification_guard USING (true);
CREATE POLICY notification_guard_read ON public."PlatformConnection" FOR SELECT TO shopmate_notification_guard USING (true);
CREATE POLICY notification_guard_read ON public."OrganizationMember" FOR SELECT TO shopmate_notification_guard USING (true);
CREATE POLICY notification_guard_read ON public."WorkspaceMember" FOR SELECT TO shopmate_notification_guard USING (true);
CREATE POLICY notification_guard_grants ON public.notification_worker_grants FOR SELECT TO shopmate_notification_guard USING (true);
CREATE POLICY notification_guard_inbox_read ON public.recipient_inbox FOR SELECT TO shopmate_notification_guard USING (true);
CREATE POLICY notification_guard_inbox_insert ON public.recipient_inbox FOR INSERT TO shopmate_notification_guard WITH CHECK (true);
CREATE POLICY notification_enqueuer_read ON public.notification_outbox FOR SELECT TO shopmate_notification_enqueuer USING (public.notification_scope_access("organizationId","workspaceId","storeId","connectionId","externalStoreId","recipientUserId","connectionGeneration",'ENQUEUE'));
CREATE POLICY notification_enqueuer_inbox ON public.recipient_inbox FOR SELECT TO shopmate_notification_enqueuer USING (EXISTS (SELECT 1 FROM public.notification_outbox o WHERE o."rowId"="outboxId"));
CREATE POLICY notification_worker_read ON public.notification_outbox FOR SELECT TO shopmate_notification_worker USING (public.notification_scope_access("organizationId","workspaceId","storeId","connectionId","externalStoreId","recipientUserId","connectionGeneration",'WORKER'));
CREATE POLICY notification_worker_inbox ON public.recipient_inbox FOR SELECT TO shopmate_notification_worker USING (EXISTS (SELECT 1 FROM public.notification_outbox o WHERE o."rowId"="outboxId"));
CREATE POLICY notification_enqueue ON public.notification_outbox FOR INSERT TO shopmate_notification_enqueuer
  WITH CHECK (public.notification_scope_access("organizationId","workspaceId","storeId","connectionId","externalStoreId","recipientUserId","connectionGeneration",'ENQUEUE')
    AND status='PENDING' AND attempt=0 AND "nextAttemptAt" IS NOT DISTINCT FROM "notBefore"
    AND "leaseToken" IS NULL AND "leaseUntil" IS NULL AND "deliveredAt" IS NULL);
CREATE POLICY notification_work ON public.notification_outbox FOR UPDATE TO shopmate_notification_worker
  USING (public.notification_scope_access("organizationId","workspaceId","storeId","connectionId","externalStoreId","recipientUserId","connectionGeneration",'WORKER'))
  WITH CHECK (public.notification_scope_access("organizationId","workspaceId","storeId","connectionId","externalStoreId","recipientUserId","connectionGeneration",'WORKER'));
CREATE POLICY notification_recipient_read ON public.recipient_inbox FOR SELECT TO shopmate_notification_recipient
  USING (public.notification_scope_access("organizationId","workspaceId","storeId","connectionId","externalStoreId","recipientUserId",NULL,'RECIPIENT'));
CREATE POLICY notification_recipient_mark ON public.recipient_inbox FOR UPDATE TO shopmate_notification_recipient
  USING (public.notification_scope_access("organizationId","workspaceId","storeId","connectionId","externalStoreId","recipientUserId",NULL,'RECIPIENT'))
  WITH CHECK (public.notification_scope_access("organizationId","workspaceId","storeId","connectionId","externalStoreId","recipientUserId",NULL,'RECIPIENT'));
REVOKE ALL ON FUNCTION public.notification_id(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notification_literal(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notification_time(TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notification_outbox_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recipient_inbox_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notification_member_access(TEXT,TEXT,TEXT,BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notification_connection_access(TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notification_scope_access(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notification_project_delivery() FROM PUBLIC;
ALTER FUNCTION public.notification_member_access(TEXT,TEXT,TEXT,BOOLEAN) OWNER TO shopmate_notification_guard;
ALTER FUNCTION public.notification_connection_access(TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER) OWNER TO shopmate_notification_guard;
ALTER FUNCTION public.notification_scope_access(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,TEXT) OWNER TO shopmate_notification_guard;
ALTER FUNCTION public.notification_project_delivery() OWNER TO shopmate_notification_guard;
GRANT EXECUTE ON FUNCTION public.notification_id(TEXT) TO shopmate_notification_enqueuer,shopmate_notification_worker,shopmate_notification_recipient,shopmate_notification_guard;
GRANT EXECUTE ON FUNCTION public.notification_literal(TEXT) TO shopmate_notification_enqueuer,shopmate_notification_worker,shopmate_notification_recipient,shopmate_notification_guard;
GRANT EXECUTE ON FUNCTION public.notification_time(TIMESTAMPTZ) TO shopmate_notification_enqueuer,shopmate_notification_worker,shopmate_notification_recipient,shopmate_notification_guard;
GRANT EXECUTE ON FUNCTION public.notification_scope_access(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,TEXT) TO shopmate_notification_enqueuer,shopmate_notification_worker,shopmate_notification_recipient,shopmate_notification_guard;
COMMIT;

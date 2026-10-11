BEGIN;
CREATE TABLE demo."DemoFailureRule" (
  id TEXT NOT NULL CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'),
  "organizationId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "storeId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL, "connectionId" TEXT NOT NULL, "externalStoreId" TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0), priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 1000),
  "startsAt" TIMESTAMP(3) NOT NULL, "endsAt" TIMESTAMP(3) NOT NULL,
  methods TEXT[] NOT NULL, "effectKind" TEXT NOT NULL, "effectCode" TEXT, "retryAfterMs" INTEGER, "delayMs" INTEGER,
  "createdRevision" INTEGER NOT NULL CHECK ("createdRevision" > 0), "removedRevision" INTEGER,
  PRIMARY KEY ("sessionId",generation,id),
  FOREIGN KEY ("sessionId","organizationId","workspaceId","storeId","connectionId","externalStoreId")
    REFERENCES demo."DemoCommerceSession" (id,"organizationId","workspaceId","storeId","connectionId","externalStoreId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CHECK ("startsAt" >= timestamp '0001-01-01' AND "endsAt" <= timestamp '9999-12-31 23:59:59.999'
    AND "endsAt">"startsAt" AND "endsAt"-"startsAt"<=interval '30 days'),
  CHECK (cardinality(methods) BETWEEN 1 AND 8 AND array_position(methods,NULL) IS NULL
    AND methods <@ ARRAY['getStore','listProducts','getProduct','listOrders','getOrder','listRefunds','getInventory','getMarketingMetrics']::text[]),
  CHECK ((("effectKind"='FAIL' AND "effectCode" IN ('TIMEOUT','RATE_LIMIT','AUTH_EXPIRED','TEMPORARY','INVALID_RESPONSE')
    AND "delayMs" IS NULL AND (("effectCode"='RATE_LIMIT' AND "retryAfterMs" BETWEEN 1 AND 86400000)
      OR ("effectCode"<>'RATE_LIMIT' AND "retryAfterMs" IS NULL)))
    OR ("effectKind"='DELAY' AND "effectCode" IS NULL AND "retryAfterMs" IS NULL AND "delayMs" BETWEEN 1 AND 30000)) IS TRUE),
  CHECK ("removedRevision" IS NULL OR "removedRevision">"createdRevision")
);
CREATE TABLE demo."DemoFailureRuleAudit" (
  id BIGSERIAL PRIMARY KEY, "organizationId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "storeId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL, "connectionId" TEXT NOT NULL, "externalStoreId" TEXT NOT NULL, generation INTEGER NOT NULL,
  "actorUserId" TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('CREATE','REMOVE')),
  "ruleId" TEXT NOT NULL, "beforeRevision" INTEGER NOT NULL, "afterRevision" INTEGER NOT NULL,
  "clockNow" TIMESTAMP(3) NOT NULL, snapshot JSONB NOT NULL,
  UNIQUE ("sessionId","afterRevision"),
  FOREIGN KEY ("sessionId",generation,"ruleId") REFERENCES demo."DemoFailureRule" ("sessionId",generation,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CHECK ("beforeRevision">=0 AND "afterRevision"="beforeRevision"+1)
);
CREATE INDEX "DemoFailureRule_scope_idx" ON demo."DemoFailureRule" ("organizationId","workspaceId","storeId","sessionId",generation);
CREATE INDEX "DemoFailureRuleAudit_scope_idx" ON demo."DemoFailureRuleAudit" ("organizationId","workspaceId","sessionId");

CREATE FUNCTION demo.has_failure_rule_access(org TEXT, workspace TEXT, store TEXT, session TEXT, connection TEXT, external TEXT, gen INTEGER, writable BOOLEAN)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT (NOT writable OR (NOT pg_has_role(session_user,'shopmate_mock_source_reader','member')
    AND NOT pg_has_role(session_user,'shopmate_mock_source_worker','member')))
    AND demo.has_store_access(org,workspace,store,writable)
    AND EXISTS (SELECT 1 FROM demo."DemoCommerceSession" s JOIN public."PlatformConnection" c ON c.id=s."connectionId"
      WHERE s.id=session AND s."organizationId"=org AND s."workspaceId"=workspace AND s."storeId"=store
        AND s."connectionId"=connection AND s."externalStoreId"=external AND c.generation=gen AND c.status='ACTIVE')
$$;
ALTER TABLE demo."DemoFailureRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo."DemoFailureRule" FORCE ROW LEVEL SECURITY;
CREATE POLICY failure_rule_read ON demo."DemoFailureRule" FOR SELECT USING (
  demo.has_failure_rule_access("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,false));
CREATE POLICY failure_rule_create ON demo."DemoFailureRule" FOR INSERT WITH CHECK (
  demo.has_failure_rule_access("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,true));
CREATE POLICY failure_rule_remove ON demo."DemoFailureRule" FOR UPDATE USING (
  demo.has_failure_rule_access("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,true)) WITH CHECK (
  demo.has_failure_rule_access("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,true));
ALTER TABLE demo."DemoFailureRuleAudit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo."DemoFailureRuleAudit" FORCE ROW LEVEL SECURITY;
CREATE POLICY failure_audit_read ON demo."DemoFailureRuleAudit" FOR SELECT USING (
  demo.has_store_access("organizationId","workspaceId","storeId",false));
CREATE POLICY failure_audit_insert ON demo."DemoFailureRuleAudit" FOR INSERT WITH CHECK (
  "actorUserId"=current_setting('app.user_id',true) AND
  demo.has_failure_rule_access("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,true));

CREATE FUNCTION demo.validate_failure_rule_control() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE current_revision INTEGER; clock_now TIMESTAMP; method_count INTEGER;
BEGIN
  IF NEW."sessionId" IS DISTINCT FROM current_setting('demo.control_session_id',true) THEN
    RAISE EXCEPTION 'Invalid failure control protocol' USING ERRCODE='SM002';
  END IF;
  PERFORM demo.lock_source_control(NEW."sessionId");
  IF demo.has_failure_rule_access(NEW."organizationId",NEW."workspaceId",NEW."storeId",NEW."sessionId",NEW."connectionId",NEW."externalStoreId",NEW.generation,true) IS NOT TRUE THEN
    RAISE EXCEPTION 'Failure control denied' USING ERRCODE='SM001';
  END IF;
  SELECT s.revision,s."clockNow" INTO current_revision,clock_now FROM demo."DemoCommerceSession" s WHERE s.id=NEW."sessionId" FOR UPDATE;
  PERFORM c.id FROM public."PlatformConnection" c WHERE c.id=NEW."connectionId" FOR UPDATE;
  SELECT count(DISTINCT method) INTO method_count FROM unnest(NEW.methods) method;
  IF method_count<>cardinality(NEW.methods) THEN RAISE EXCEPTION 'Duplicate methods' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW."createdRevision"<>current_revision OR NEW."removedRevision" IS NOT NULL OR NEW."endsAt"<=clock_now
      OR (SELECT count(*) FROM demo."DemoFailureRule" r WHERE r."sessionId"=NEW."sessionId" AND r.generation=NEW.generation AND r."removedRevision" IS NULL AND r."endsAt">clock_now)>=32 THEN
      RAISE EXCEPTION 'Failure rule capacity or revision conflict' USING ERRCODE='23514';
    END IF;
  ELSE
    IF (to_jsonb(NEW)-'removedRevision') IS DISTINCT FROM (to_jsonb(OLD)-'removedRevision')
      OR OLD."removedRevision" IS NOT NULL OR NEW."removedRevision" IS DISTINCT FROM current_revision THEN
      RAISE EXCEPTION 'Failure rule is immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION demo.audit_failure_rule_control() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE changed INTEGER; current_revision INTEGER; clock_now TIMESTAMP;
BEGIN
  SELECT s.revision,s."clockNow" INTO current_revision,clock_now FROM demo."DemoCommerceSession" s WHERE s.id=NEW."sessionId";
  INSERT INTO demo."DemoFailureRuleAudit" ("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,"actorUserId",kind,"ruleId","beforeRevision","afterRevision","clockNow",snapshot)
    VALUES (NEW."organizationId",NEW."workspaceId",NEW."storeId",NEW."sessionId",NEW."connectionId",NEW."externalStoreId",NEW.generation,current_setting('app.user_id',true),
      CASE WHEN TG_OP='INSERT' THEN 'CREATE' ELSE 'REMOVE' END,NEW.id,current_revision-1,current_revision,clock_now,to_jsonb(NEW));
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 THEN RAISE EXCEPTION 'Failure audit was not written' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION demo.require_failure_rule_audit() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF pg_trigger_depth()<>2 THEN
    RAISE EXCEPTION 'Failure audit requires a rule mutation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER failure_control_statement BEFORE INSERT OR UPDATE ON demo."DemoFailureRule" FOR EACH STATEMENT EXECUTE FUNCTION demo.require_source_control();
CREATE TRIGGER failure_control_row BEFORE INSERT OR UPDATE ON demo."DemoFailureRule" FOR EACH ROW EXECUTE FUNCTION demo.validate_failure_rule_control();
CREATE TRIGGER failure_control_audit AFTER INSERT OR UPDATE ON demo."DemoFailureRule" FOR EACH ROW EXECUTE FUNCTION demo.audit_failure_rule_control();
CREATE TRIGGER failure_audit_mutation BEFORE INSERT ON demo."DemoFailureRuleAudit" FOR EACH ROW EXECUTE FUNCTION demo.require_failure_rule_audit();
REVOKE ALL ON demo."DemoFailureRule",demo."DemoFailureRuleAudit",demo."DemoFailureRuleAudit_id_seq" FROM PUBLIC,shopmate_mock_source_worker,shopmate_mock_source_reader;
REVOKE ALL ON FUNCTION demo.has_failure_rule_access(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,BOOLEAN),demo.validate_failure_rule_control(),demo.audit_failure_rule_control(),demo.require_failure_rule_audit() FROM PUBLIC;
COMMIT;

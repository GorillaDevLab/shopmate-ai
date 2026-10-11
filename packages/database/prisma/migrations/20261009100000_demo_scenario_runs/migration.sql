BEGIN;
CREATE TABLE demo."DemoScenarioRun" (
  id TEXT PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'),
  "organizationId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "storeId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL, "connectionId" TEXT NOT NULL, "externalStoreId" TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0), "loadedRevision" INTEGER NOT NULL CHECK ("loadedRevision" > 0),
  "configHash" TEXT NOT NULL CHECK ("configHash" ~ '^[a-f0-9]{64}$'), config JSONB NOT NULL,
  "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'),
  "businessClock" TIMESTAMP(3) NOT NULL, "actorUserId" TEXT NOT NULL,
  UNIQUE ("sessionId",generation),
  FOREIGN KEY ("sessionId","organizationId","workspaceId","storeId","connectionId","externalStoreId")
    REFERENCES demo."DemoCommerceSession" (id,"organizationId","workspaceId","storeId","connectionId","externalStoreId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CHECK ((jsonb_typeof(config)='object' AND jsonb_typeof(config->'scenarioPlan')='object'
    AND config->'scenarioPlan'->>'version'='mock-scenario-v1'
    AND config->'scenarioPlan'->>'scenarioId' ~ '^SCENARIO_(00[1-9]|01[0-5])$'
    AND config->'scenarioPlan'->>'externalStoreId'="externalStoreId") IS TRUE),
  CHECK ("loadedAt">=timestamp '0001-01-01' AND "loadedAt"<=timestamp '9999-12-31 23:59:59.999')
);
CREATE TABLE demo."DemoScenarioRunAudit" (
  "runId" TEXT PRIMARY KEY REFERENCES demo."DemoScenarioRun" (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  "organizationId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "storeId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL, "actorUserId" TEXT NOT NULL, snapshot JSONB NOT NULL
);
CREATE INDEX "DemoScenarioRun_scope_idx" ON demo."DemoScenarioRun" ("organizationId","workspaceId","storeId","sessionId",generation DESC);
CREATE FUNCTION demo.has_scenario_access(org TEXT, workspace TEXT, store TEXT, session TEXT, connection TEXT, external TEXT, gen INTEGER, writable BOOLEAN)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT (NOT writable OR (NOT pg_has_role(session_user,'shopmate_mock_source_reader','member')
    AND NOT pg_has_role(session_user,'shopmate_mock_source_worker','member')))
    AND demo.has_store_access(org,workspace,store,writable)
    AND EXISTS (SELECT 1 FROM demo."DemoCommerceSession" s JOIN public."PlatformConnection" c ON c.id=s."connectionId"
      WHERE s.id=session AND s."organizationId"=org AND s."workspaceId"=workspace AND s."storeId"=store
        AND s."connectionId"=connection AND s."externalStoreId"=external
        AND (NOT writable OR (c.generation=gen AND c.status='ACTIVE')))
$$;
ALTER TABLE demo."DemoScenarioRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo."DemoScenarioRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY scenario_read ON demo."DemoScenarioRun" FOR SELECT USING (
  demo.has_scenario_access("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,false));
CREATE POLICY scenario_load ON demo."DemoScenarioRun" FOR INSERT WITH CHECK (
  "actorUserId"=current_setting('app.user_id',true) AND
  demo.has_scenario_access("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,true));
ALTER TABLE demo."DemoScenarioRunAudit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo."DemoScenarioRunAudit" FORCE ROW LEVEL SECURITY;
CREATE POLICY scenario_audit_read ON demo."DemoScenarioRunAudit" FOR SELECT USING (
  demo.has_store_access("organizationId","workspaceId","storeId",false));
CREATE POLICY scenario_audit_insert ON demo."DemoScenarioRunAudit" FOR INSERT WITH CHECK (
  "actorUserId"=current_setting('app.user_id',true) AND demo.has_store_access("organizationId","workspaceId","storeId",true));
CREATE FUNCTION demo.validate_scenario_load() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  NEW."loadedAt":=clock_timestamp() AT TIME ZONE 'UTC';
  IF NEW."sessionId" IS DISTINCT FROM current_setting('demo.control_session_id',true) THEN
    RAISE EXCEPTION 'Invalid scenario control protocol' USING ERRCODE='SM002';
  END IF;
  PERFORM demo.lock_source_control(NEW."sessionId");
  IF demo.has_scenario_access(NEW."organizationId",NEW."workspaceId",NEW."storeId",NEW."sessionId",NEW."connectionId",NEW."externalStoreId",NEW.generation,true) IS NOT TRUE THEN
    RAISE EXCEPTION 'Scenario control denied' USING ERRCODE='SM001';
  END IF;
  PERFORM s.id FROM demo."DemoCommerceSession" s WHERE s.id=NEW."sessionId" FOR UPDATE;
  PERFORM c.id FROM public."PlatformConnection" c WHERE c.id=NEW."connectionId" FOR UPDATE;
  IF NEW."actorUserId" IS DISTINCT FROM current_setting('app.user_id',true) OR octet_length(NEW.config::text)>1000000 OR NOT EXISTS (
    SELECT 1 FROM demo."DemoCommerceSession" s WHERE s.id=NEW."sessionId" AND s.config=NEW.config
      AND s."configHash"=NEW."configHash" AND s."generatorVersion"='mock-source-v2'
      AND s.revision=NEW."loadedRevision" AND s."clockNow"=NEW."businessClock") THEN
    RAISE EXCEPTION 'Scenario snapshot or revision conflict' USING ERRCODE='23514';
  END IF;
  IF (NEW."businessClock" BETWEEN (NEW.config->>'historyStart')::timestamp AND
    (NEW.config->>'historyStart')::timestamp+((NEW.config->>'days')::integer+5)*interval '1 day') IS NOT TRUE THEN
    RAISE EXCEPTION 'Scenario business clock exceeds configured budget' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION demo.audit_scenario_load() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE changed INTEGER;
BEGIN
  INSERT INTO demo."DemoScenarioRunAudit" ("runId","organizationId","workspaceId","storeId","sessionId","actorUserId",snapshot)
    VALUES (NEW.id,NEW."organizationId",NEW."workspaceId",NEW."storeId",NEW."sessionId",NEW."actorUserId",to_jsonb(NEW));
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 THEN RAISE EXCEPTION 'Scenario audit was not written' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION demo.require_scenario_audit() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF pg_trigger_depth()<>2 THEN RAISE EXCEPTION 'Scenario audit requires a run load' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scenario_control_statement BEFORE INSERT ON demo."DemoScenarioRun" FOR EACH STATEMENT EXECUTE FUNCTION demo.require_source_control();
CREATE TRIGGER scenario_control_row BEFORE INSERT ON demo."DemoScenarioRun" FOR EACH ROW EXECUTE FUNCTION demo.validate_scenario_load();
CREATE TRIGGER scenario_control_audit AFTER INSERT ON demo."DemoScenarioRun" FOR EACH ROW EXECUTE FUNCTION demo.audit_scenario_load();
CREATE TRIGGER scenario_audit_mutation BEFORE INSERT ON demo."DemoScenarioRunAudit" FOR EACH ROW EXECUTE FUNCTION demo.require_scenario_audit();
CREATE FUNCTION demo.preserve_scenario_history() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Scenario history is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER scenario_history_immutable BEFORE UPDATE OR DELETE ON demo."DemoScenarioRun" FOR EACH ROW EXECUTE FUNCTION demo.preserve_scenario_history();
CREATE TRIGGER scenario_audit_immutable BEFORE UPDATE OR DELETE ON demo."DemoScenarioRunAudit" FOR EACH ROW EXECUTE FUNCTION demo.preserve_scenario_history();
REVOKE ALL ON demo."DemoScenarioRun",demo."DemoScenarioRunAudit" FROM PUBLIC,shopmate_mock_source_worker,shopmate_mock_source_reader;
REVOKE ALL ON FUNCTION demo.has_scenario_access(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,BOOLEAN),demo.validate_scenario_load(),demo.audit_scenario_load(),demo.require_scenario_audit() FROM PUBLIC;
REVOKE ALL ON FUNCTION demo.preserve_scenario_history() FROM PUBLIC;
COMMIT;

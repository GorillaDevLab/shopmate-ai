BEGIN;
-- The full session is row scope; advisory hashes only determine serialization.
CREATE FUNCTION demo.lock_source_control(session_id TEXT) RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE lock_key INTEGER;
BEGIN
  IF session_id IS NULL OR session_id !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
    OR pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Invalid source control protocol' USING ERRCODE='SM002';
  END IF;
  lock_key:=pg_catalog.hashtext(session_id);
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_locks l
    WHERE l.pid=pg_catalog.pg_backend_pid() AND l.locktype='advisory' AND l.granted
      AND l.classid=1397575508::oid AND l.objsubid=2
      AND (l.objid::bigint <> (lock_key::bigint & 4294967295::bigint) OR l.mode <> 'ExclusiveLock')) THEN
    RAISE EXCEPTION 'Invalid source control protocol' USING ERRCODE='SM002';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(1397575508,lock_key);
  PERFORM pg_catalog.set_config('demo.control_session_id',session_id,true);
END $$;
REVOKE ALL ON FUNCTION demo.lock_source_control(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION demo.lock_source_control(TEXT) TO shopmate_mock_source_reader,shopmate_mock_source_worker;

CREATE FUNCTION demo.require_source_control() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM demo.lock_source_control(pg_catalog.current_setting('demo.control_session_id',true));
  RETURN NULL;
END $$;
CREATE TRIGGER source_control_insert BEFORE INSERT ON mock_platform."Runtime"
  FOR EACH STATEMENT EXECUTE FUNCTION demo.require_source_control();
CREATE TRIGGER source_control_session_update BEFORE UPDATE ON demo."DemoCommerceSession"
  FOR EACH STATEMENT EXECUTE FUNCTION demo.require_source_control();
CREATE TRIGGER source_control_connection_update BEFORE UPDATE ON public."PlatformConnection"
  FOR EACH STATEMENT EXECUTE FUNCTION demo.require_source_control();

-- A VOLATILE function's separate SQL command observes commits after the lock wait,
-- including when the outer raw VALUES INSERT still holds its pre-wait snapshot.
CREATE OR REPLACE FUNCTION mock_platform.validate_runtime_insert() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE config JSONB; start_at TIMESTAMP; days INTEGER; offset_days INTEGER; allowed BOOLEAN;
BEGIN
  IF NEW."sessionId" IS DISTINCT FROM pg_catalog.current_setting('demo.control_session_id',true) THEN
    RAISE EXCEPTION 'Invalid source control protocol' USING ERRCODE='SM002';
  END IF;
  PERFORM demo.lock_source_control(NEW."sessionId");
  SELECT mock_platform.has_worker_access(NEW."organizationId",NEW."workspaceId",NEW."storeId",NEW."sessionId",NEW."connectionId",NEW."externalStoreId",NEW.generation) INTO allowed;
  IF allowed IS NOT TRUE THEN
    RAISE EXCEPTION 'Source control access denied' USING ERRCODE='SM001';
  END IF;
  SELECT d.config INTO config FROM demo."DemoCommerceSession" d
    WHERE d.id=NEW."sessionId" AND d.config=NEW."sourceConfig" AND d."configHash"=NEW."configHash" AND d."generatorVersion"=NEW."generatorVersion";
  IF config IS NULL OR pg_catalog.octet_length(config::text)>1000000 OR
    (config->>'profile' IN ('mature','growing','problematic','new') AND pg_catalog.jsonb_typeof(config->'days')='number'
      AND config->>'days' ~ '^[0-9]{1,3}$' AND config->>'historyStart' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T16:00:00.000Z$') IS NOT TRUE THEN
    RAISE EXCEPTION 'Invalid source snapshot' USING ERRCODE='23514';
  END IF;
  days:=(config->>'days')::integer; start_at:=(config->>'historyStart')::timestamp;
  offset_days:=CASE WHEN config->>'profile'='new' THEN greatest(0,days-14) ELSE 0 END;
  IF days NOT BETWEEN 1 AND 365 OR start_at<timestamp '0001-01-01' OR start_at+(days+5)*interval '1 day'>timestamp '9999-12-31 23:59:59.999'
    OR NEW."openingAt" IS DISTINCT FROM start_at+offset_days*interval '1 day'
    OR NEW."baselineEnd" IS DISTINCT FROM start_at+days*interval '1 day' THEN
    RAISE EXCEPTION 'Invalid source calendar' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION demo.validate_session_control() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE allowed BOOLEAN;
BEGIN
  IF OLD.id IS DISTINCT FROM pg_catalog.current_setting('demo.control_session_id',true) THEN
    RAISE EXCEPTION 'Invalid source control protocol' USING ERRCODE='SM002';
  END IF;
  PERFORM demo.lock_source_control(OLD.id);
  SELECT demo.has_store_access(OLD."organizationId",OLD."workspaceId",OLD."storeId",true) INTO allowed;
  IF allowed IS NOT TRUE THEN
    RAISE EXCEPTION 'Source control access denied' USING ERRCODE='SM001';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION demo.validate_connection_control() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE session_id TEXT; matching BOOLEAN; allowed BOOLEAN;
BEGIN
  session_id:=pg_catalog.current_setting('demo.control_session_id',true);
  PERFORM demo.lock_source_control(session_id);
  SELECT demo.has_store_access(OLD."organizationId",OLD."workspaceId",OLD."storeId",true) INTO allowed;
  IF allowed IS NOT TRUE THEN
    RAISE EXCEPTION 'Source control access denied' USING ERRCODE='SM001';
  END IF;
  SELECT EXISTS (SELECT 1 FROM demo."DemoCommerceSession" d WHERE d.id=session_id
    AND d."connectionId"=OLD.id AND d."organizationId"=OLD."organizationId" AND d."workspaceId"=OLD."workspaceId"
    AND d."storeId"=OLD."storeId" AND d."externalStoreId"=OLD."externalStoreId") INTO matching;
  IF matching IS NOT TRUE THEN
    RAISE EXCEPTION 'Invalid source control protocol' USING ERRCODE='SM002';
  END IF;
  RETURN NEW;
END $$;
-- Existing immutable binding triggers run first and retain their constraint semantics.
CREATE TRIGGER source_control_session_row BEFORE UPDATE ON demo."DemoCommerceSession"
  FOR EACH ROW EXECUTE FUNCTION demo.validate_session_control();
CREATE TRIGGER source_control_connection_row BEFORE UPDATE ON public."PlatformConnection"
  FOR EACH ROW EXECUTE FUNCTION demo.validate_connection_control();
REVOKE ALL ON FUNCTION demo.require_source_control(),demo.validate_session_control(),demo.validate_connection_control() FROM PUBLIC;
COMMIT;

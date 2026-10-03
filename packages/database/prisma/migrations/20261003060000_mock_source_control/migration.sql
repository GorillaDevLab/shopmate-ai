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
COMMIT;

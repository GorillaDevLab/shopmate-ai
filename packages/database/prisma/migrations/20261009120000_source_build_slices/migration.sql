BEGIN;
-- Consecutive immutable prefixes can share one business-clock revision.
ALTER TABLE mock_platform."BuildJob" DROP CONSTRAINT "BuildJob_target_key";
ALTER TABLE mock_platform."BuildJob" ADD CONSTRAINT "BuildJob_target_key" UNIQUE ("sessionId",generation,"targetClockRevision","targetTime");
CREATE OR REPLACE FUNCTION mock_platform.initial_job(candidate mock_platform."BuildJob",runtime mock_platform."Runtime",head mock_platform."BuildJob") RETURNS mock_platform."BuildJob"
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE wall TIMESTAMPTZ(3):=clock_timestamp();
BEGIN
  candidate.revision:=mock_platform.source_uint(mock_platform.increment_uint(coalesce(head.revision,0)::text));
  SELECT d."clockNow",d."clockRevision" INTO candidate."targetTime",candidate."targetClockRevision"
    FROM demo."DemoCommerceSession" d WHERE d.id=candidate."sessionId";
  candidate."baseRevision":=coalesce(head.revision,0); candidate."baseHighEventSeq":=coalesce(head."highEventSeq",0);
  candidate."baseProcessedThrough":=coalesce(head."processedThrough",runtime."openingAt");
  IF current_setting('mock.source_slice',true)='6h' THEN
    candidate."targetTime":=least(candidate."targetTime",candidate."baseProcessedThrough"+interval '6 hours');
  END IF;
  candidate."processedThrough":=candidate."baseProcessedThrough"; candidate."highEventSeq":=candidate."baseHighEventSeq";
  candidate."eventCount":=0; candidate."versionCount":=0; candidate.state:='BUILDING'; candidate.fence:=1;
  candidate."leaseGrantId":=current_setting('mock.grant_id',true); candidate."createdAt":=wall; candidate."leaseUntil":=wall+interval '30 seconds';
  candidate."failureCode":=NULL; candidate."publishedAt":=NULL; candidate."certificateHash":=NULL;
  candidate."lastAppendExpectedHash":=NULL; candidate."lastAppendStartSeq":=NULL; candidate."lastAppendEventCount":=NULL; candidate."lastAppendHash":=NULL;
  candidate."generatorVersion":=runtime."generatorVersion"; candidate."runtimeVersion":=runtime."runtimeVersion"; candidate.codec:='source-snapshot-v1';
  candidate.checkpoint:=jsonb_build_object('codec','source-checkpoint-v1','chunkIndex','0','highEventSeq',candidate."highEventSeq"::text,
    'processedThrough',mock_platform.canonical_utc(candidate."processedThrough"),'lastEvent',coalesce(head.checkpoint->'lastEvent','null'::jsonb),'sealed',false);
  candidate."checkpointHash":=mock_platform.hash_jsonb(jsonb_build_object('codec','source-checkpoint-hash-v1',
    'scope',mock_platform.source_scope(to_jsonb(candidate)),'revision',candidate.revision::text,'checkpoint',candidate.checkpoint));
  candidate."mutationXid":=pg_current_xact_id();
  RETURN candidate;
END $$;
COMMIT;

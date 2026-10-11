BEGIN;
ALTER TABLE mock_platform."Runtime" DROP CONSTRAINT "Runtime_generatorVersion_check";
ALTER TABLE mock_platform."Runtime" ADD CONSTRAINT "Runtime_generatorVersion_check" CHECK ((
  ("generatorVersion"='mock-source-v1' AND NOT ("sourceConfig" ? 'scenarioPlan')) OR
  ("generatorVersion"='mock-source-v2' AND jsonb_typeof("sourceConfig"->'scenarioPlan')='object'
    AND "sourceConfig"->'scenarioPlan'->>'version'='mock-scenario-v1'
    AND "sourceConfig"->'scenarioPlan'->>'externalStoreId'="externalStoreId")
) IS TRUE);
ALTER TABLE mock_platform."BuildJob" DROP CONSTRAINT "BuildJob_generatorVersion_check";
ALTER TABLE mock_platform."BuildJob" ADD CONSTRAINT "BuildJob_generatorVersion_check"
  CHECK ("generatorVersion" IN ('mock-source-v1','mock-source-v2'));
COMMIT;

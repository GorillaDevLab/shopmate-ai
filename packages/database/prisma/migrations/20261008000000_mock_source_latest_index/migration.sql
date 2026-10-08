CREATE INDEX "EntityVersion_entity_time_idx" ON mock_platform."EntityVersion"
  ("sessionId", generation, kind COLLATE "C", "entityKey" COLLATE "C", "occurredAt" DESC, "eventSeq" DESC);

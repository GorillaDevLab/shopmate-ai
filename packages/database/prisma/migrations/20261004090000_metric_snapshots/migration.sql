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
COMMIT;

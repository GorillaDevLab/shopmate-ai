BEGIN;
CREATE TABLE commerce."RefundListing" (
 "scopeId" UUID NOT NULL, "organizationId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "storeId" TEXT NOT NULL,
 "externalRefundId" TEXT COLLATE "C" NOT NULL, "externalOrderId" TEXT COLLATE "C" NOT NULL,
 "externalSkuId" TEXT COLLATE "C", status TEXT NOT NULL, currency TEXT NOT NULL,
 "requestedMinor" BIGINT NOT NULL, "succeededMinor" BIGINT,
 "requestedAt" TIMESTAMPTZ(3) NOT NULL, "succeededAt" TIMESTAMPTZ(3),
 "sourceVersion" TEXT, "sourceUpdatedAt" TIMESTAMPTZ(3), "sourcePayloadHash" TEXT NOT NULL,
 "qualityState" TEXT NOT NULL, "qualityIssues" TEXT[] NOT NULL,
 "ingestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY ("scopeId","externalRefundId"),
 CONSTRAINT "RefundListing_scope_fkey" FOREIGN KEY ("scopeId","organizationId","workspaceId","storeId")
 REFERENCES commerce."SourceScope"(id,"organizationId","workspaceId","storeId") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CHECK (("sourceVersion" IS NULL OR commerce.valid_string("sourceVersion",256,false))
  AND "sourcePayloadHash" ~ '^[a-f0-9]{64}$' AND commerce.valid_quality("qualityState","qualityIssues")
  AND ("sourceUpdatedAt" IS NOT NULL OR 'SOURCE_TIME_MISSING'=ANY("qualityIssues"))
  AND ("sourceUpdatedAt" IS NULL OR (isfinite("sourceUpdatedAt") AND "sourceUpdatedAt" BETWEEN timestamptz '0001-01-01 00:00:00+00' AND timestamptz '9999-12-31 23:59:59.999+00'))),
 CHECK (commerce.valid_string("externalRefundId",256,false) AND commerce.valid_string("externalOrderId",256,false)
  AND ("externalSkuId" IS NULL OR commerce.valid_string("externalSkuId",256,false))),
 CHECK (status IN ('REQUESTED','APPROVED','PROCESSING','SUCCEEDED','FAILED','REJECTED','CANCELLED') AND currency='CNY'),
 CHECK ("requestedMinor" BETWEEN 0 AND 9007199254740991 AND ("succeededMinor" IS NULL OR "succeededMinor" BETWEEN 0 AND "requestedMinor")),
 CHECK (isfinite("requestedAt") AND "requestedAt" BETWEEN timestamptz '0001-01-01 00:00:00+00' AND timestamptz '9999-12-31 23:59:59.999+00'
  AND ("succeededAt" IS NULL OR (isfinite("succeededAt") AND "succeededAt" BETWEEN "requestedAt" AND timestamptz '9999-12-31 23:59:59.999+00'))),
 CHECK ((status<>'SUCCEEDED' OR ("succeededMinor" IS NOT NULL AND "succeededAt" IS NOT NULL) OR 'REFUND_UNKNOWN'=ANY("qualityIssues"))
  AND (status='SUCCEEDED' OR (("succeededMinor" IS NULL OR "succeededMinor"=0) AND "succeededAt" IS NULL) OR 'SOURCE_INCONSISTENT'=ANY("qualityIssues")))
);
CREATE INDEX "RefundListing_store_idx" ON commerce."RefundListing"("organizationId","workspaceId","storeId");
ALTER TABLE commerce."RefundListing" ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce."RefundListing" FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_refundlisting_read ON commerce."RefundListing" FOR SELECT TO shopmate_commerce_reader
 USING (session_user=current_user AND commerce.can_read("scopeId"));
REVOKE ALL ON commerce."RefundListing" FROM PUBLIC;
GRANT SELECT ON commerce."RefundListing" TO shopmate_commerce_reader;
CREATE TABLE commerce."InventoryListing" (
 "scopeId" UUID NOT NULL, "organizationId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "storeId" TEXT NOT NULL,
 "externalSkuId" TEXT COLLATE "C" NOT NULL, "externalLocationId" TEXT COLLATE "C" NOT NULL,
 available BIGINT, reserved BIGINT, "onHand" BIGINT, "safetyStock" BIGINT, "leadTimeDays" INTEGER,
 "sourceVersion" TEXT, "sourceUpdatedAt" TIMESTAMPTZ(3), "sourcePayloadHash" TEXT NOT NULL,
 "qualityState" TEXT NOT NULL, "qualityIssues" TEXT[] NOT NULL,
 "ingestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY ("scopeId","externalSkuId","externalLocationId"),
 CONSTRAINT "InventoryListing_scope_fkey" FOREIGN KEY ("scopeId","organizationId","workspaceId","storeId")
 REFERENCES commerce."SourceScope"(id,"organizationId","workspaceId","storeId") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CHECK (("sourceVersion" IS NULL OR commerce.valid_string("sourceVersion",256,false))
  AND "sourcePayloadHash" ~ '^[a-f0-9]{64}$' AND commerce.valid_quality("qualityState","qualityIssues")
  AND ("sourceUpdatedAt" IS NOT NULL OR 'SOURCE_TIME_MISSING'=ANY("qualityIssues"))
  AND ("sourceUpdatedAt" IS NULL OR (isfinite("sourceUpdatedAt") AND "sourceUpdatedAt" BETWEEN timestamptz '0001-01-01 00:00:00+00' AND timestamptz '9999-12-31 23:59:59.999+00'))),
 CHECK (commerce.valid_string("externalSkuId",256,false) AND commerce.valid_string("externalLocationId",256,false)),
 CHECK ((available IS NULL OR available BETWEEN 0 AND 9007199254740991)
  AND (reserved IS NULL OR reserved BETWEEN 0 AND 9007199254740991)
  AND ("onHand" IS NULL OR "onHand" BETWEEN 0 AND 9007199254740991)
  AND ("safetyStock" IS NULL OR "safetyStock" BETWEEN 0 AND 9007199254740991)
  AND ("leadTimeDays" IS NULL OR "leadTimeDays" BETWEEN 0 AND 365)),
 CHECK ((available IS NOT NULL AND reserved IS NOT NULL AND "onHand" IS NOT NULL) OR 'INVENTORY_UNKNOWN'=ANY("qualityIssues")),
 -- Numeric addition cannot overflow before the safe-integer conservation check.
 CHECK (available IS NULL OR reserved IS NULL OR "onHand" IS NULL OR available::numeric+reserved::numeric<="onHand")
);
CREATE INDEX "InventoryListing_store_idx" ON commerce."InventoryListing"("organizationId","workspaceId","storeId");
ALTER TABLE commerce."InventoryListing" ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce."InventoryListing" FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_inventorylisting_read ON commerce."InventoryListing" FOR SELECT TO shopmate_commerce_reader
 USING (session_user=current_user AND commerce.can_read("scopeId"));
REVOKE ALL ON commerce."InventoryListing" FROM PUBLIC;
GRANT SELECT ON commerce."InventoryListing" TO shopmate_commerce_reader;
CREATE TABLE commerce."CampaignMetricListing" (
 "scopeId" UUID NOT NULL, "organizationId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "storeId" TEXT NOT NULL,
 "externalCampaignId" TEXT COLLATE "C" NOT NULL, date DATE NOT NULL, currency TEXT NOT NULL,
 impressions BIGINT, clicks BIGINT, "attributedOrders" BIGINT, "spendMinor" BIGINT, "attributedRevenueMinor" BIGINT,
 "sourceVersion" TEXT, "sourceUpdatedAt" TIMESTAMPTZ(3), "sourcePayloadHash" TEXT NOT NULL,
 "qualityState" TEXT NOT NULL, "qualityIssues" TEXT[] NOT NULL,
 "ingestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY ("scopeId","externalCampaignId","date"),
 CONSTRAINT "CampaignMetricListing_scope_fkey" FOREIGN KEY ("scopeId","organizationId","workspaceId","storeId")
 REFERENCES commerce."SourceScope"(id,"organizationId","workspaceId","storeId") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CHECK (("sourceVersion" IS NULL OR commerce.valid_string("sourceVersion",256,false))
  AND "sourcePayloadHash" ~ '^[a-f0-9]{64}$' AND commerce.valid_quality("qualityState","qualityIssues")
  AND ("sourceUpdatedAt" IS NOT NULL OR 'SOURCE_TIME_MISSING'=ANY("qualityIssues"))
  AND ("sourceUpdatedAt" IS NULL OR (isfinite("sourceUpdatedAt") AND "sourceUpdatedAt" BETWEEN timestamptz '0001-01-01 00:00:00+00' AND timestamptz '9999-12-31 23:59:59.999+00'))),
 CHECK (commerce.valid_string("externalCampaignId",256,false) AND currency='CNY'),
 CHECK (isfinite(date) AND date BETWEEN date '0001-01-01' AND date '9999-12-31'),
 CHECK ((impressions IS NULL OR impressions BETWEEN 0 AND 9007199254740991)
  AND (clicks IS NULL OR clicks BETWEEN 0 AND 9007199254740991)
  AND ("attributedOrders" IS NULL OR "attributedOrders" BETWEEN 0 AND 9007199254740991)
  AND ("spendMinor" IS NULL OR "spendMinor" BETWEEN 0 AND 9007199254740991)
  AND ("attributedRevenueMinor" IS NULL OR "attributedRevenueMinor" BETWEEN 0 AND 9007199254740991)),
 CHECK ((impressions IS NOT NULL AND clicks IS NOT NULL AND "attributedOrders" IS NOT NULL AND "spendMinor" IS NOT NULL AND "attributedRevenueMinor" IS NOT NULL) OR 'MARKETING_UNKNOWN'=ANY("qualityIssues"))
);
CREATE INDEX "CampaignMetricListing_store_idx" ON commerce."CampaignMetricListing"("organizationId","workspaceId","storeId");
ALTER TABLE commerce."CampaignMetricListing" ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce."CampaignMetricListing" FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_campaignmetriclisting_read ON commerce."CampaignMetricListing" FOR SELECT TO shopmate_commerce_reader
 USING (session_user=current_user AND commerce.can_read("scopeId"));
REVOKE ALL ON commerce."CampaignMetricListing" FROM PUBLIC;
GRANT SELECT ON commerce."CampaignMetricListing" TO shopmate_commerce_reader;
COMMIT;

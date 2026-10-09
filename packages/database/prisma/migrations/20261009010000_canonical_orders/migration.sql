BEGIN;
CREATE TABLE commerce."OrderListing" (
 "scopeId" UUID NOT NULL, "organizationId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "storeId" TEXT NOT NULL,
 "externalOrderId" TEXT COLLATE "C" NOT NULL, status TEXT NOT NULL,
 "orderedAt" TIMESTAMPTZ(3) NOT NULL, "paidAt" TIMESTAMPTZ(3), currency TEXT NOT NULL,
 "grossMinor" BIGINT NOT NULL, "discountMinor" BIGINT NOT NULL, "shippingMinor" BIGINT NOT NULL,
 "payableMinor" BIGINT NOT NULL, "paidMinor" BIGINT, "refundedMinor" BIGINT,
 "sourceVersion" TEXT, "sourceUpdatedAt" TIMESTAMPTZ(3), "sourcePayloadHash" TEXT NOT NULL,
 "qualityState" TEXT NOT NULL, "qualityIssues" TEXT[] NOT NULL,
 "ingestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY ("scopeId","externalOrderId"),
 CONSTRAINT "OrderListing_tenant_key" UNIQUE ("scopeId","organizationId","workspaceId","storeId","externalOrderId"),
 CONSTRAINT "OrderListing_scope_fkey" FOREIGN KEY ("scopeId","organizationId","workspaceId","storeId")
 REFERENCES commerce."SourceScope"(id,"organizationId","workspaceId","storeId") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CHECK (status IN ('PENDING_PAYMENT','PAID','FULFILLED','COMPLETED','CANCELLED','CLOSED') AND currency='CNY'),
 CHECK (commerce.valid_string("externalOrderId",256,false)
  AND ("sourceVersion" IS NULL OR commerce.valid_string("sourceVersion",256,false)) AND "sourcePayloadHash" ~ '^[a-f0-9]{64}$'),
 CHECK (commerce.valid_quality("qualityState","qualityIssues")
  AND ("sourceUpdatedAt" IS NOT NULL OR 'SOURCE_TIME_MISSING'=ANY("qualityIssues"))
  AND ("paidMinor" IS NOT NULL OR 'PAYMENT_UNKNOWN'=ANY("qualityIssues"))
  AND ("refundedMinor" IS NOT NULL OR 'REFUND_UNKNOWN'=ANY("qualityIssues"))),
 CHECK (isfinite("orderedAt") AND "orderedAt" BETWEEN timestamptz '0001-01-01 00:00:00+00' AND timestamptz '9999-12-31 23:59:59.999+00'
  AND ("paidAt" IS NULL OR (isfinite("paidAt") AND "paidAt" BETWEEN "orderedAt" AND timestamptz '9999-12-31 23:59:59.999+00'))
  AND ("sourceUpdatedAt" IS NULL OR (isfinite("sourceUpdatedAt") AND "sourceUpdatedAt" BETWEEN timestamptz '0001-01-01 00:00:00+00' AND timestamptz '9999-12-31 23:59:59.999+00'))),
 CHECK ("grossMinor" BETWEEN 0 AND 9007199254740991 AND "discountMinor" BETWEEN 0 AND "grossMinor"
  AND "shippingMinor" BETWEEN 0 AND 9007199254740991 AND "payableMinor" BETWEEN 0 AND 9007199254740991
  AND "payableMinor"::numeric="grossMinor"::numeric-"discountMinor"+"shippingMinor"
  AND ("paidMinor" IS NULL OR "paidMinor" BETWEEN 0 AND "payableMinor")
  AND ("refundedMinor" IS NULL OR "refundedMinor" BETWEEN 0 AND "payableMinor")
  AND ("refundedMinor" IS NULL OR "paidMinor" IS NULL OR "refundedMinor"<="paidMinor")),
 CHECK ((('SOURCE_INCONSISTENT'=ANY("qualityIssues")) OR
  ((status NOT IN ('PAID','FULFILLED','COMPLETED') OR "paidMinor" IS NULL OR "paidMinor"="payableMinor")
  AND (status<>'PENDING_PAYMENT' OR (("paidMinor" IS NULL OR "paidMinor"=0) AND "paidAt" IS NULL))))
  AND ("paidAt" IS NOT NULL OR (status NOT IN ('PAID','FULFILLED','COMPLETED') AND ("paidMinor" IS NULL OR "paidMinor"=0)) OR 'PAYMENT_UNKNOWN'=ANY("qualityIssues")))
);
CREATE TABLE commerce."OrderLineListing" (
 "scopeId" UUID NOT NULL, "organizationId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "storeId" TEXT NOT NULL,
 "externalOrderId" TEXT COLLATE "C" NOT NULL, "externalLineId" TEXT COLLATE "C" NOT NULL,
 "externalProductId" TEXT COLLATE "C" NOT NULL, "externalSkuId" TEXT COLLATE "C" NOT NULL,
 quantity BIGINT NOT NULL, "unitPriceMinor" BIGINT NOT NULL, "grossMinor" BIGINT NOT NULL, "discountMinor" BIGINT NOT NULL, "netMinor" BIGINT NOT NULL,
 PRIMARY KEY ("scopeId","externalOrderId","externalLineId"),
 CONSTRAINT "OrderLineListing_order_fkey" FOREIGN KEY ("scopeId","organizationId","workspaceId","storeId","externalOrderId")
 REFERENCES commerce."OrderListing"("scopeId","organizationId","workspaceId","storeId","externalOrderId") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CHECK (commerce.valid_string("externalOrderId",256,false) AND commerce.valid_string("externalLineId",256,false)
  AND commerce.valid_string("externalProductId",256,false) AND commerce.valid_string("externalSkuId",256,false)),
 CHECK (quantity BETWEEN 1 AND 9007199254740991 AND "unitPriceMinor" BETWEEN 0 AND 9007199254740991
  AND "grossMinor" BETWEEN 0 AND 9007199254740991 AND "grossMinor"::numeric=quantity::numeric*"unitPriceMinor"
  AND "discountMinor" BETWEEN 0 AND "grossMinor" AND "netMinor" BETWEEN 0 AND 9007199254740991 AND "netMinor"="grossMinor"-"discountMinor")
);
CREATE INDEX "OrderListing_store_idx" ON commerce."OrderListing"("organizationId","workspaceId","storeId");
-- Numeric aggregation avoids overflow before enforcing the JavaScript safe-integer ceiling.
-- Lock the parent before taking a fresh READ COMMITTED aggregate snapshot.
CREATE FUNCTION commerce.check_order(scope UUID, order_id TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE parent commerce."OrderListing"; children INTEGER; gross NUMERIC; discount NUMERIC;
BEGIN
 SELECT * INTO parent FROM commerce."OrderListing" WHERE "scopeId"=scope AND "externalOrderId"=order_id FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT count(*)::integer,sum("grossMinor"),sum("discountMinor") INTO children,gross,discount
 FROM commerce."OrderLineListing" WHERE "scopeId"=scope AND "externalOrderId"=order_id;
 IF children NOT BETWEEN 1 AND 500 OR gross<>parent."grossMinor" OR discount<>parent."discountMinor" THEN
  RAISE EXCEPTION 'Invalid complete order listing snapshot' USING ERRCODE='23514'; END IF;
END $$;
CREATE FUNCTION commerce.check_order_snapshot() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'Order snapshots require read committed isolation' USING ERRCODE='23514'; END IF;
 IF TG_OP<>'INSERT' THEN PERFORM commerce.check_order(OLD."scopeId",OLD."externalOrderId"); END IF;
 IF TG_OP<>'DELETE' THEN PERFORM commerce.check_order(NEW."scopeId",NEW."externalOrderId"); END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER check_order_snapshot AFTER INSERT OR UPDATE OR DELETE ON commerce."OrderListing"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.check_order_snapshot();
CREATE CONSTRAINT TRIGGER check_order_line_snapshot AFTER INSERT OR UPDATE OR DELETE ON commerce."OrderLineListing"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.check_order_snapshot();
ALTER TABLE commerce."OrderListing" ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce."OrderListing" FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce."OrderLineListing" ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce."OrderLineListing" FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_order_read ON commerce."OrderListing" FOR SELECT TO shopmate_commerce_reader USING (session_user=current_user AND commerce.can_read("scopeId"));
CREATE POLICY commerce_order_line_read ON commerce."OrderLineListing" FOR SELECT TO shopmate_commerce_reader USING (session_user=current_user AND commerce.can_read("scopeId"));
REVOKE ALL ON commerce."OrderListing",commerce."OrderLineListing" FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce.check_order(UUID,TEXT),commerce.check_order_snapshot() FROM PUBLIC;
GRANT SELECT ON commerce."OrderListing",commerce."OrderLineListing" TO shopmate_commerce_reader;
COMMIT;

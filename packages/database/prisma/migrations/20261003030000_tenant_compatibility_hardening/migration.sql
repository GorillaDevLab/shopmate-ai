BEGIN;
-- Definer triggers must be owned by the isolated migration/provisioning identity.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = CURRENT_USER AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Tenant compatibility migration requires an RLS-bypass provisioning identity';
  END IF;
END $$;

ALTER TABLE "OrderItem" ALTER COLUMN "merchantId" SET DEFAULT '';
ALTER TABLE "Store" ALTER COLUMN "organizationId" SET DEFAULT '', ALTER COLUMN "workspaceId" SET DEFAULT '';
CREATE UNIQUE INDEX "Organization_legacyMerchantId_id_key" ON "Organization"("legacyMerchantId",id);
ALTER TABLE "Store" DROP CONSTRAINT "Store_organizationId_fkey";
ALTER TABLE "Store" ADD CONSTRAINT "Store_merchantId_organizationId_fkey"
  FOREIGN KEY ("merchantId","organizationId") REFERENCES "Organization"("legacyMerchantId",id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION inherit_order_item_merchant() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE expected_merchant TEXT;
BEGIN
  SELECT "merchantId" INTO expected_merchant FROM public."Order" WHERE id=NEW."orderId";
  IF NEW."merchantId" IS NULL OR NEW."merchantId"='' THEN NEW."merchantId":=expected_merchant; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION inherit_store_tenant() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE expected_organization TEXT;
BEGIN
  SELECT id INTO expected_organization FROM public."Organization" WHERE "legacyMerchantId"=NEW."merchantId";
  IF NEW."organizationId" IS NULL OR NEW."organizationId"='' THEN NEW."organizationId":=expected_organization; END IF;
  IF NEW."organizationId" IS DISTINCT FROM expected_organization THEN
    RAISE EXCEPTION 'Store ownership conflict' USING ERRCODE='23514';
  END IF;
  IF NEW."workspaceId" IS NULL OR NEW."workspaceId"='' THEN
    SELECT id INTO NEW."workspaceId" FROM public."Workspace" WHERE "organizationId"=expected_organization AND slug='default';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION inherit_store_tenant() OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION inherit_store_tenant() FROM PUBLIC;
COMMIT;

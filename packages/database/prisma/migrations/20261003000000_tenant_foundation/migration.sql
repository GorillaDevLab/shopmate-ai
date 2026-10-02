BEGIN;

-- Do not silently reassign legacy data across tenants to make a constraint pass.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Sku" s JOIN "Product" p ON p.id=s."productId" WHERE s."merchantId"<>p."merchantId")
    OR EXISTS (SELECT 1 FROM "OrderItem" i JOIN "Order" o ON o.id=i."orderId" JOIN "Sku" s ON s.id=i."skuId" WHERE o."merchantId"<>s."merchantId")
  THEN RAISE EXCEPTION 'Legacy ownership conflict; tenant migration stopped' USING ERRCODE='23514';
  END IF;
END $$;

CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE','SUSPENDED');
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE','INACTIVE');
CREATE TYPE "TenantRole" AS ENUM ('OWNER','ADMIN','OPERATOR','ANALYST','VIEWER');

CREATE TABLE "Organization" (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  status "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
  "legacyMerchantId" TEXT UNIQUE REFERENCES "Merchant"(id) ON DELETE RESTRICT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "OrganizationMember" (
  id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL REFERENCES "Organization"(id) ON DELETE CASCADE,
  "userId" TEXT NOT NULL, role "TenantRole" NOT NULL,
  status "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "OrganizationMember_organizationId_userId_key" ON "OrganizationMember"("organizationId","userId");
CREATE INDEX "OrganizationMember_userId_status_idx" ON "OrganizationMember"("userId",status);
CREATE TABLE "Workspace" (
  id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL REFERENCES "Organization"(id) ON DELETE CASCADE,
  name TEXT NOT NULL, slug TEXT NOT NULL, status "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "Workspace_organizationId_id_key" ON "Workspace"("organizationId",id);
CREATE UNIQUE INDEX "Workspace_organizationId_slug_key" ON "Workspace"("organizationId",slug);
CREATE TABLE "WorkspaceMember" (
  id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL, status "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceMember_workspace_fkey" FOREIGN KEY ("organizationId","workspaceId") REFERENCES "Workspace"("organizationId",id) ON DELETE CASCADE,
  CONSTRAINT "WorkspaceMember_membership_fkey" FOREIGN KEY ("organizationId","userId") REFERENCES "OrganizationMember"("organizationId","userId") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "WorkspaceMember_organizationId_workspaceId_userId_key" ON "WorkspaceMember"("organizationId","workspaceId","userId");
CREATE INDEX "WorkspaceMember_userId_status_idx" ON "WorkspaceMember"("userId",status);

-- Preserve readable legacy IDs where possible; bound derived IDs for long business keys.
CREATE FUNCTION legacy_organization_id(merchant_id TEXT) RETURNS TEXT LANGUAGE SQL IMMUTABLE STRICT
  SET search_path=pg_catalog AS $$
  SELECT CASE WHEN length('legacy-org-'||merchant_id)<=128 THEN 'legacy-org-'||merchant_id
    ELSE 'legacy-org-'||encode(sha256(convert_to(merchant_id,'UTF8')),'hex') END
$$;
CREATE FUNCTION legacy_workspace_id(merchant_id TEXT) RETURNS TEXT LANGUAGE SQL IMMUTABLE STRICT
  SET search_path=pg_catalog AS $$
  SELECT CASE WHEN length('legacy-workspace-'||merchant_id)<=128 THEN 'legacy-workspace-'||merchant_id
    ELSE 'legacy-workspace-'||encode(sha256(convert_to(merchant_id,'UTF8')),'hex') END
$$;
CREATE FUNCTION initialize_legacy_tenant() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "Organization" (id,name,"legacyMerchantId","updatedAt")
    VALUES (public.legacy_organization_id(NEW.id),NEW.name,NEW.id,CURRENT_TIMESTAMP);
  INSERT INTO "Workspace" (id,"organizationId",name,slug,"updatedAt")
    VALUES (public.legacy_workspace_id(NEW.id),public.legacy_organization_id(NEW.id),'默认工作区','default',CURRENT_TIMESTAMP);
  RETURN NEW;
END $$;
CREATE TRIGGER "Merchant_initialize_tenant" AFTER INSERT ON "Merchant" FOR EACH ROW EXECUTE FUNCTION initialize_legacy_tenant();
INSERT INTO "Organization" (id,name,"legacyMerchantId","createdAt","updatedAt")
  SELECT public.legacy_organization_id(id),name,id,"createdAt","updatedAt" FROM "Merchant";
INSERT INTO "Workspace" (id,"organizationId",name,slug,"updatedAt")
  SELECT public.legacy_workspace_id(id),public.legacy_organization_id(id),'默认工作区','default',CURRENT_TIMESTAMP FROM "Merchant";

CREATE UNIQUE INDEX "Product_merchantId_id_key" ON "Product"("merchantId",id);
CREATE UNIQUE INDEX "Sku_merchantId_id_key" ON "Sku"("merchantId",id);
CREATE UNIQUE INDEX "Order_merchantId_id_key" ON "Order"("merchantId",id);
ALTER TABLE "Sku" DROP CONSTRAINT "Sku_productId_fkey";
ALTER TABLE "Sku" ADD CONSTRAINT "Sku_merchantId_productId_fkey"
  FOREIGN KEY ("merchantId","productId") REFERENCES "Product"("merchantId",id) ON DELETE CASCADE;
ALTER TABLE "OrderItem" ADD COLUMN "merchantId" TEXT DEFAULT NULL::text;
UPDATE "OrderItem" i SET "merchantId"=o."merchantId" FROM "Order" o WHERE o.id=i."orderId";
ALTER TABLE "OrderItem" ALTER COLUMN "merchantId" SET NOT NULL;
ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_orderId_fkey", DROP CONSTRAINT "OrderItem_skuId_fkey";
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_merchantId_orderId_fkey"
  FOREIGN KEY ("merchantId","orderId") REFERENCES "Order"("merchantId",id) ON DELETE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_merchantId_skuId_fkey"
  FOREIGN KEY ("merchantId","skuId") REFERENCES "Sku"("merchantId",id) ON DELETE RESTRICT;

CREATE FUNCTION inherit_order_item_merchant() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE expected_merchant TEXT;
BEGIN
  SELECT "merchantId" INTO expected_merchant FROM "Order" WHERE id=NEW."orderId";
  IF NEW."merchantId" IS NULL THEN NEW."merchantId":=expected_merchant; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "OrderItem_inherit_merchant" BEFORE INSERT OR UPDATE ON "OrderItem"
  FOR EACH ROW EXECUTE FUNCTION inherit_order_item_merchant();

ALTER TABLE "Store" ADD COLUMN "organizationId" TEXT DEFAULT NULL::text, ADD COLUMN "workspaceId" TEXT DEFAULT NULL::text;
UPDATE "Store" s SET "organizationId"=o.id,"workspaceId"=w.id
  FROM "Organization" o JOIN "Workspace" w ON w."organizationId"=o.id AND w.slug='default'
  WHERE o."legacyMerchantId"=s."merchantId";
ALTER TABLE "Store" ALTER COLUMN "organizationId" SET NOT NULL, ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "Store" ADD CONSTRAINT "Store_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON DELETE RESTRICT;
ALTER TABLE "Store" ADD CONSTRAINT "Store_organizationId_workspaceId_fkey" FOREIGN KEY ("organizationId","workspaceId") REFERENCES "Workspace"("organizationId",id) ON DELETE RESTRICT;

CREATE FUNCTION inherit_store_tenant() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE expected_organization TEXT;
BEGIN
  SELECT id INTO expected_organization FROM "Organization" WHERE "legacyMerchantId"=NEW."merchantId";
  IF NEW."organizationId" IS NULL THEN NEW."organizationId":=expected_organization; END IF;
  IF NEW."organizationId" IS DISTINCT FROM expected_organization THEN
    RAISE EXCEPTION 'Store ownership conflict' USING ERRCODE='23514';
  END IF;
  IF NEW."workspaceId" IS NULL THEN
    SELECT id INTO NEW."workspaceId" FROM "Workspace" WHERE "organizationId"=expected_organization AND slug='default';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Store_inherit_tenant" BEFORE INSERT OR UPDATE ON "Store"
  FOR EACH ROW EXECUTE FUNCTION inherit_store_tenant();

COMMIT;

BEGIN;
CREATE SCHEMA commerce;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shopmate_commerce_reader') THEN
  CREATE ROLE shopmate_commerce_reader NOLOGIN NOSUPERUSER NOBYPASSRLS;
 END IF;
END $$;

-- Match JavaScript/Zod character budgets, including supplementary Unicode pairs.
CREATE FUNCTION commerce.utf16_length(value TEXT) RETURNS INTEGER
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
 SELECT coalesce(sum(CASE WHEN ascii(substr(value,n,1))>65535 THEN 2 ELSE 1 END),0)::integer
 FROM generate_series(1,length(value)) n
$$;
CREATE FUNCTION commerce.valid_string(value TEXT, maximum INTEGER, normalized BOOLEAN)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
 SELECT commerce.utf16_length(value) BETWEEN 1 AND maximum
 AND value !~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]|[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]$'
 AND CASE WHEN normalized THEN
   value=normalize(value,NFC) AND value !~ U&'[\0001-\0008\000B-\001F\007F-\009F\200B-\200F\202A-\202E\2066-\2069]'
 ELSE value !~ U&'[\0001-\001F\007F-\009F\200B-\200F\202A-\202E\2066-\2069]' END
$$;
CREATE FUNCTION commerce.valid_quality(state TEXT, issues TEXT[]) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT (state IN ('COMPLETE','PARTIAL') AND issues IS NOT NULL
 AND (state='COMPLETE')=(cardinality(issues)=0)
 AND cardinality(issues)<=9 AND array_position(issues,NULL) IS NULL
 AND (cardinality(issues)=0 OR (array_ndims(issues)=1 AND array_lower(issues,1)=1))
 AND issues<@ARRAY['COST_MISSING','CATEGORY_MISSING','PAYMENT_UNKNOWN','REFUND_UNKNOWN','INVENTORY_UNKNOWN','INVENTORY_STALE','MARKETING_UNKNOWN','SOURCE_TIME_MISSING','SOURCE_INCONSISTENT']::text[]
 AND cardinality(issues)=(SELECT count(DISTINCT issue) FROM unnest(issues) issue)) IS TRUE
$$;
CREATE FUNCTION commerce.valid_attributes(value JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE attribute JSONB; names TEXT[]:=ARRAY[]::text[];
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(value)>30 THEN RETURN false; END IF;
 FOR attribute IN SELECT * FROM jsonb_array_elements(value) LOOP
  IF jsonb_typeof(attribute) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF attribute-ARRAY['name','value']<>'{}'::jsonb
   OR jsonb_typeof(attribute->'name') IS DISTINCT FROM 'string'
   OR jsonb_typeof(attribute->'value') IS DISTINCT FROM 'string'
   OR NOT commerce.valid_string(attribute->>'name',100,true)
   OR NOT commerce.valid_string(attribute->>'value',200,true)
   OR attribute->>'name'=ANY(names) THEN RETURN false; END IF;
  names:=array_append(names,attribute->>'name');
 END LOOP;
 RETURN true;
END $$;

CREATE TABLE commerce."SourceScope" (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 "organizationId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "storeId" TEXT NOT NULL,
 "connectionId" TEXT NOT NULL, "externalStoreId" TEXT NOT NULL, provider TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK (generation>=0),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT "SourceScope_namespace_key" UNIQUE ("organizationId","workspaceId","storeId","connectionId","externalStoreId",provider,generation),
 CONSTRAINT "SourceScope_tenant_key" UNIQUE (id,"organizationId","workspaceId","storeId"),
 CONSTRAINT "SourceScope_connection_fkey" FOREIGN KEY ("connectionId","organizationId","workspaceId","storeId","externalStoreId")
 REFERENCES public."PlatformConnection"(id,"organizationId","workspaceId","storeId","externalStoreId") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CHECK (commerce.valid_string("externalStoreId",256,false) AND provider ~ '^[A-Z][A-Z0-9_]{0,31}$')
);
CREATE FUNCTION commerce.guard_scope() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='UPDATE' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
  RAISE EXCEPTION 'Immutable commerce namespace' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' AND NOT EXISTS (SELECT 1 FROM public."PlatformConnection" c
  WHERE c.id=NEW."connectionId" AND c.provider=NEW.provider
   AND c.generation=NEW.generation AND c.status='ACTIVE') THEN
  RAISE EXCEPTION 'Invalid current commerce namespace' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_scope BEFORE INSERT OR UPDATE ON commerce."SourceScope" FOR EACH ROW EXECUTE FUNCTION commerce.guard_scope();

CREATE TABLE commerce."ProductListing" (
 "scopeId" UUID NOT NULL, "organizationId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "storeId" TEXT NOT NULL,
 "externalProductId" TEXT COLLATE "C" NOT NULL,
 title TEXT NOT NULL, description TEXT, category TEXT, brand TEXT,
 status TEXT NOT NULL CHECK (status IN ('DRAFT','ACTIVE','INACTIVE','DELETED')),
 "sourceVersion" TEXT, "sourceUpdatedAt" TIMESTAMPTZ(3), "sourcePayloadHash" TEXT NOT NULL,
 "qualityState" TEXT NOT NULL, "qualityIssues" TEXT[] NOT NULL,
 "ingestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY ("scopeId","externalProductId"),
 CONSTRAINT "ProductListing_tenant_key" UNIQUE ("scopeId","organizationId","workspaceId","storeId","externalProductId"),
 CONSTRAINT "ProductListing_scope_fkey" FOREIGN KEY ("scopeId","organizationId","workspaceId","storeId")
 REFERENCES commerce."SourceScope"(id,"organizationId","workspaceId","storeId") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CHECK (commerce.valid_string("externalProductId",256,false) AND commerce.valid_string(title,200,true)
  AND (description IS NULL OR commerce.valid_string(description,5000,true))
  AND (category IS NULL OR commerce.valid_string(category,200,true))
  AND (brand IS NULL OR commerce.valid_string(brand,200,true))
  AND ("sourceVersion" IS NULL OR commerce.valid_string("sourceVersion",256,false))
  AND "sourcePayloadHash" ~ '^[a-f0-9]{64}$'),
 CHECK (commerce.valid_quality("qualityState","qualityIssues")
  AND ("sourceUpdatedAt" IS NOT NULL OR 'SOURCE_TIME_MISSING'=ANY("qualityIssues"))
  AND (category IS NOT NULL OR 'CATEGORY_MISSING'=ANY("qualityIssues"))),
 CHECK ("sourceUpdatedAt" IS NULL OR (isfinite("sourceUpdatedAt") AND "sourceUpdatedAt" BETWEEN timestamptz '0001-01-01 00:00:00+00' AND timestamptz '9999-12-31 23:59:59.999+00'))
);
CREATE TABLE commerce."SkuListing" (
 "scopeId" UUID NOT NULL, "organizationId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "storeId" TEXT NOT NULL,
 "externalSkuId" TEXT COLLATE "C" NOT NULL, "externalProductId" TEXT COLLATE "C" NOT NULL,
 attributes JSONB NOT NULL, "salePriceMinor" BIGINT NOT NULL, "costPriceMinor" BIGINT, "originalPriceMinor" BIGINT,
 status TEXT NOT NULL CHECK (status IN ('ACTIVE','INACTIVE')),
 PRIMARY KEY ("scopeId","externalSkuId"),
 CONSTRAINT "SkuListing_product_fkey" FOREIGN KEY ("scopeId","organizationId","workspaceId","storeId","externalProductId")
 REFERENCES commerce."ProductListing"("scopeId","organizationId","workspaceId","storeId","externalProductId") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CHECK (commerce.valid_string("externalSkuId",256,false) AND commerce.valid_string("externalProductId",256,false) AND commerce.valid_attributes(attributes)),
 CHECK ("salePriceMinor" BETWEEN 0 AND 9007199254740991 AND ("costPriceMinor" IS NULL OR "costPriceMinor" BETWEEN 0 AND 9007199254740991)
  AND ("originalPriceMinor" IS NULL OR "originalPriceMinor" BETWEEN 0 AND 9007199254740991))
);
CREATE INDEX "ProductListing_store_idx" ON commerce."ProductListing"("organizationId","workspaceId","storeId");
CREATE INDEX "SkuListing_product_idx" ON commerce."SkuListing"("scopeId","externalProductId");

-- Child presence and missing cost are whole-snapshot properties checked at COMMIT.
CREATE FUNCTION commerce.check_product(scope UUID, product TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE parent commerce."ProductListing"; children INTEGER; missing_cost BOOLEAN;
BEGIN
 SELECT * INTO parent FROM commerce."ProductListing" WHERE "scopeId"=scope AND "externalProductId"=product FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT count(*)::integer,bool_or("costPriceMinor" IS NULL) INTO children,missing_cost
 FROM commerce."SkuListing" WHERE "scopeId"=scope AND "externalProductId"=product;
 IF children NOT BETWEEN 1 AND 500 OR (missing_cost AND NOT 'COST_MISSING'=ANY(parent."qualityIssues")) THEN
  RAISE EXCEPTION 'Invalid complete product listing snapshot' USING ERRCODE='23514'; END IF;
END $$;
CREATE FUNCTION commerce.check_snapshot() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'Listing snapshots require read committed isolation' USING ERRCODE='23514'; END IF;
 IF TG_OP<>'INSERT' THEN PERFORM commerce.check_product(OLD."scopeId",OLD."externalProductId"); END IF;
 IF TG_OP<>'DELETE' THEN PERFORM commerce.check_product(NEW."scopeId",NEW."externalProductId"); END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER check_product_snapshot AFTER INSERT OR UPDATE OR DELETE ON commerce."ProductListing"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.check_snapshot();
CREATE CONSTRAINT TRIGGER check_sku_snapshot AFTER INSERT OR UPDATE OR DELETE ON commerce."SkuListing"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.check_snapshot();

CREATE FUNCTION commerce.can_read(scope UUID) RETURNS BOOLEAN LANGUAGE SQL STABLE
SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS (SELECT 1 FROM commerce."SourceScope" n
 JOIN public."PlatformConnection" c ON (c.id,c."organizationId",c."workspaceId",c."storeId",c."externalStoreId",c.provider,c.generation)
  =(n."connectionId",n."organizationId",n."workspaceId",n."storeId",n."externalStoreId",n.provider,n.generation)
 JOIN public."Store" s ON (s.id,s."organizationId",s."workspaceId")=(n."storeId",n."organizationId",n."workspaceId")
 JOIN public."Merchant" merchant ON merchant.id=s."merchantId"
 JOIN public."Organization" o ON o.id=n."organizationId" AND o."legacyMerchantId"=merchant.id
 JOIN public."Workspace" w ON (w.id,w."organizationId")=(n."workspaceId",n."organizationId")
 JOIN public."OrganizationMember" m ON m."organizationId"=n."organizationId"
 WHERE n.id=scope AND m."userId"=current_setting('app.user_id',true)
  AND s."merchantId"=current_setting('app.merchant_id',true)
  AND c.status='ACTIVE' AND merchant.status='ACTIVE' AND o.status='ACTIVE' AND w.status='ACTIVE' AND m.status='ACTIVE'
  AND (m.role IN ('OWNER','ADMIN') OR EXISTS (SELECT 1 FROM public."WorkspaceMember" a
   WHERE (a."organizationId",a."workspaceId",a."userId")=(n."organizationId",n."workspaceId",m."userId") AND a.status='ACTIVE')))
$$;
ALTER TABLE commerce."SourceScope" ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce."SourceScope" FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce."ProductListing" ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce."ProductListing" FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce."SkuListing" ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce."SkuListing" FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_scope_read ON commerce."SourceScope" FOR SELECT TO shopmate_commerce_reader USING (session_user=current_user AND commerce.can_read(id));
CREATE POLICY commerce_product_read ON commerce."ProductListing" FOR SELECT TO shopmate_commerce_reader USING (session_user=current_user AND commerce.can_read("scopeId"));
CREATE POLICY commerce_sku_read ON commerce."SkuListing" FOR SELECT TO shopmate_commerce_reader USING (session_user=current_user AND commerce.can_read("scopeId"));
REVOKE ALL ON ALL TABLES IN SCHEMA commerce FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA commerce FROM PUBLIC;
GRANT USAGE ON SCHEMA commerce TO shopmate_commerce_reader;
GRANT SELECT ON commerce."SourceScope",commerce."ProductListing",commerce."SkuListing" TO shopmate_commerce_reader;
GRANT EXECUTE ON FUNCTION commerce.can_read(UUID) TO shopmate_commerce_reader;
CREATE OR REPLACE FUNCTION sync_host.safe_login(login TEXT) RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=login AND rolcanlogin)
 AND pg_has_role(login,'shopmate_sync_worker','MEMBER') AND NOT EXISTS (
  SELECT 1 FROM pg_roles r WHERE pg_has_role(login,r.oid,'MEMBER') AND
   (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
    OR r.rolname IN ('pg_read_all_data','pg_write_all_data','pg_read_server_files','pg_write_server_files','pg_execute_server_program')
    OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE c.relowner=r.oid AND n.nspname IN ('public','demo','mock_platform','sync_host','commerce'))
    OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspowner=r.oid AND n.nspname IN ('public','demo','mock_platform','sync_host','commerce'))
    OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE p.proowner=r.oid AND n.nspname IN ('public','demo','mock_platform','sync_host','commerce'))
    OR EXISTS (SELECT 1 FROM pg_database d WHERE d.datdba=r.oid AND d.datname=current_database()))
 )
$$;

COMMIT;

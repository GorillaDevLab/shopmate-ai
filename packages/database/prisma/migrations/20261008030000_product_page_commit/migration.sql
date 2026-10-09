BEGIN;
ALTER TABLE sync_host."Job" ADD CONSTRAINT "Job_tenant_key" UNIQUE (id,"organizationId","workspaceId","storeId");
CREATE TABLE sync_host."ProductPageCommit" (
 "jobId" TEXT NOT NULL, "pageId" TEXT NOT NULL, "scopeId" UUID NOT NULL,
 "organizationId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "storeId" TEXT NOT NULL,
 codec TEXT NOT NULL DEFAULT 'product-page-v1' CHECK (codec='product-page-v1'),
 "pageHash" TEXT NOT NULL CHECK ("pageHash" ~ '^[a-f0-9]{64}$'),
 "observedAt" TIMESTAMPTZ(3) NOT NULL, "sourceWatermark" TIMESTAMPTZ(3), terminal BOOLEAN NOT NULL,
 "acceptedFence" INTEGER NOT NULL CHECK ("acceptedFence">=1),
 "inputCount" INTEGER NOT NULL CHECK ("inputCount" BETWEEN 0 AND 200),
 "appliedCount" INTEGER NOT NULL CHECK ("appliedCount" BETWEEN 0 AND 200),
 "duplicateCount" INTEGER NOT NULL CHECK ("duplicateCount" BETWEEN 0 AND 200),
 "staleCount" INTEGER NOT NULL CHECK ("staleCount" BETWEEN 0 AND 200),
 "quarantinedCount" INTEGER NOT NULL CHECK ("quarantinedCount" BETWEEN 0 AND 200),
 "skuInsertedCount" INTEGER NOT NULL CHECK ("skuInsertedCount" BETWEEN 0 AND 5000),
 "skuDeletedCount" INTEGER NOT NULL CHECK ("skuDeletedCount" BETWEEN 0 AND 100000),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY ("jobId","pageId"),
 CONSTRAINT "ProductPageCommit_tenant_key" UNIQUE ("jobId","pageId","organizationId","workspaceId","storeId"),
 CONSTRAINT "ProductPageCommit_receipt_fkey" FOREIGN KEY ("jobId","pageId") REFERENCES sync_host."PageReceipt"("jobId","pageId") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ProductPageCommit_job_fkey" FOREIGN KEY ("jobId","organizationId","workspaceId","storeId") REFERENCES sync_host."Job"(id,"organizationId","workspaceId","storeId") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ProductPageCommit_scope_fkey" FOREIGN KEY ("scopeId","organizationId","workspaceId","storeId") REFERENCES commerce."SourceScope"(id,"organizationId","workspaceId","storeId") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CHECK ("inputCount"="appliedCount"+"duplicateCount"+"staleCount"+"quarantinedCount")
);
CREATE TABLE sync_host."ProductPageDecision" (
 "jobId" TEXT NOT NULL, "pageId" TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 199),
 "organizationId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "storeId" TEXT NOT NULL,
 "externalProductId" TEXT, "candidateHash" TEXT NOT NULL CHECK ("candidateHash" ~ '^[a-f0-9]{64}$'),
 decision TEXT NOT NULL CHECK (decision IN ('APPLY','DUPLICATE','STALE','QUARANTINED')),
 "previousVersion" TEXT, "previousUpdatedAt" TIMESTAMPTZ(3), "previousPayloadHash" TEXT,
 PRIMARY KEY ("jobId","pageId",ordinal),
 CONSTRAINT "ProductPageDecision_tenant_key" UNIQUE ("jobId","pageId",ordinal,"organizationId","workspaceId","storeId"),
 CONSTRAINT "ProductPageDecision_commit_fkey" FOREIGN KEY ("jobId","pageId","organizationId","workspaceId","storeId") REFERENCES sync_host."ProductPageCommit"("jobId","pageId","organizationId","workspaceId","storeId") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE TABLE sync_host."ProductQuarantine" (
 "jobId" TEXT NOT NULL, "pageId" TEXT NOT NULL, ordinal INTEGER NOT NULL,
 "organizationId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "storeId" TEXT NOT NULL,
 reason TEXT NOT NULL CHECK (reason IN ('INVALID_PRODUCT','INVALID_SOURCE_TIME','SOURCE_TIME_STORAGE_RANGE','SOURCE_TIME_OUTSIDE_WINDOW','SOURCE_CONFLICT','SKU_OWNERSHIP_CONFLICT')),
 PRIMARY KEY ("jobId","pageId",ordinal),
 CONSTRAINT "ProductQuarantine_tenant_key" UNIQUE ("jobId","pageId",ordinal,"organizationId","workspaceId","storeId"),
 CONSTRAINT "ProductQuarantine_decision_fkey" FOREIGN KEY ("jobId","pageId",ordinal,"organizationId","workspaceId","storeId") REFERENCES sync_host."ProductPageDecision"("jobId","pageId",ordinal,"organizationId","workspaceId","storeId") ON DELETE RESTRICT ON UPDATE NO ACTION
);
ALTER TABLE sync_host."ProductPageCommit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_host."ProductPageCommit" FORCE ROW LEVEL SECURITY;
ALTER TABLE sync_host."ProductPageDecision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_host."ProductPageDecision" FORCE ROW LEVEL SECURITY;
ALTER TABLE sync_host."ProductQuarantine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_host."ProductQuarantine" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON sync_host."ProductPageCommit",sync_host."ProductPageDecision",sync_host."ProductQuarantine" FROM PUBLIC;

CREATE FUNCTION sync_host.product_open_job(job_id TEXT, expected_fence INTEGER) RETURNS sync_host."Job"
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE job sync_host."Job";
BEGIN
 IF NOT sync_host.safe_login(session_user) THEN RAISE EXCEPTION 'Invalid sync login' USING ERRCODE='42501'; END IF;
 SELECT * INTO job FROM sync_host."Job" WHERE id=job_id;
 PERFORM sync_host.require_page_lease(job,expected_fence);
 IF job.stream<>'PRODUCTS' THEN RAISE EXCEPTION 'INVALID_PRODUCT_STREAM' USING ERRCODE='23514'; END IF;
 SELECT * INTO job FROM sync_host."Job" WHERE id=job_id FOR UPDATE;
 PERFORM sync_host.require_page_lease(job,expected_fence);
 PERFORM g.id FROM sync_host."WorkerGrant" g WHERE g.id=job."grantId" FOR SHARE;
 -- Keep authority stable through COMMIT; revocation linearizes after this transaction.
 PERFORM m.id FROM public."OrganizationMember" m
 JOIN public."Organization" o ON o.id=m."organizationId"
 JOIN public."WorkspaceMember" a ON a."organizationId"=m."organizationId" AND a."userId"=m."userId"
 JOIN public."Workspace" w ON w.id=a."workspaceId" AND w."organizationId"=a."organizationId"
 JOIN public."Store" s ON s."organizationId"=w."organizationId" AND s."workspaceId"=w.id
 JOIN public."Merchant" merchant ON merchant.id=s."merchantId"
 JOIN public."PlatformConnection" c ON c."storeId"=s.id
 WHERE m."userId"=current_setting('app.user_id',true) AND m."organizationId"=job."organizationId"
  AND w.id=job."workspaceId" AND s.id=job."storeId" AND c.id=job."connectionId"
 FOR SHARE OF m,o,a,w,s,merchant,c;
 PERFORM sync_host.require_page_lease(job,expected_fence);
 RETURN job;
END $$;

CREATE FUNCTION sync_host.product_scope(job sync_host."Job") RETURNS commerce."SourceScope"
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE scope commerce."SourceScope";
BEGIN
 INSERT INTO commerce."SourceScope" ("organizationId","workspaceId","storeId","connectionId","externalStoreId",provider,generation)
 VALUES (job."organizationId",job."workspaceId",job."storeId",job."connectionId",job."externalStoreId",job.provider,job.generation)
 ON CONFLICT ON CONSTRAINT "SourceScope_namespace_key" DO NOTHING;
 SELECT * INTO scope FROM commerce."SourceScope" s
 WHERE (s."organizationId",s."workspaceId",s."storeId",s."connectionId",s."externalStoreId",s.provider,s.generation)
 =(job."organizationId",job."workspaceId",job."storeId",job."connectionId",job."externalStoreId",job.provider,job.generation) FOR UPDATE;
 RETURN scope;
END $$;

CREATE FUNCTION sync_host.product_candidates(page JSONB, job sync_host."Job", scope_id UUID) RETURNS JSONB
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE item JSONB; normalized JSONB; reason TEXT; result JSONB:='[]'; annotated JSONB:='[]'; candidate JSONB; product_id TEXT;
BEGIN
 FOR item IN SELECT * FROM jsonb_array_elements(page->'items') LOOP
  normalized:=NULL; reason:=NULL; product_id:=NULL;
  IF jsonb_typeof(item->'externalProductId')='string' AND commerce.valid_string(item->>'externalProductId',256,false) THEN product_id:=item->>'externalProductId'; END IF;
  BEGIN
   normalized:=sync_host.normalize_product(item,job."externalStoreId");
   IF normalized->'source'->'updatedAt'<>'null'::jsonb
    AND sync_host.product_time(normalized->'source'->>'updatedAt')>least(job.until AT TIME ZONE 'UTC',sync_host.product_time(page->>'observedAt')) THEN
    reason:='SOURCE_TIME_OUTSIDE_WINDOW'; END IF;
  EXCEPTION WHEN check_violation THEN
   IF SQLERRM NOT IN ('INVALID_PRODUCT','INVALID_SOURCE_TIME','SOURCE_TIME_STORAGE_RANGE') THEN RAISE; END IF;
   reason:=SQLERRM;
  END;
  result:=result||jsonb_build_array(jsonb_build_object('product',normalized,'reason',reason,'externalProductId',product_id,
   'candidateHash',encode(sha256(convert_to(item::text,'UTF8')),'hex')));
 END LOOP;
 -- Capture ownership before any APPLY, including every valid cross-product claimant.
 FOR candidate IN SELECT * FROM jsonb_array_elements(result) LOOP
  IF candidate->'reason'='null'::jsonb AND sync_host.product_ownership_conflict(candidate->'product',result,scope_id) THEN
   candidate:=jsonb_set(candidate,'{reason}','"SKU_OWNERSHIP_CONFLICT"'); END IF;
  annotated:=annotated||jsonb_build_array(candidate);
 END LOOP;
 RETURN annotated;
END $$;

CREATE FUNCTION sync_host.product_ownership_conflict(product JSONB, candidates JSONB, scope_id UUID) RETURNS BOOLEAN
LANGUAGE SQL SET search_path=pg_catalog AS $$
 SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(product->'skus') sku
  JOIN commerce."SkuListing" existing ON existing."scopeId"=scope_id AND existing."externalSkuId"=sku->>'externalSkuId'
  WHERE existing."externalProductId"<>product->>'externalProductId')
 OR EXISTS (SELECT 1 FROM jsonb_array_elements(product->'skus') sku,
  jsonb_array_elements(candidates) other, jsonb_array_elements(other->'product'->'skus') other_sku
  WHERE other->'reason'='null'::jsonb AND other->'product'->>'externalProductId'<>product->>'externalProductId'
   AND other_sku->>'externalSkuId'=sku->>'externalSkuId')
$$;

CREATE FUNCTION sync_host.product_apply(product JSONB, scope commerce."SourceScope", payload_hash TEXT) RETURNS JSONB
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE changed INTEGER; deleted INTEGER; inserted INTEGER; expected_deleted INTEGER;
BEGIN
 INSERT INTO commerce."ProductListing" ("scopeId","organizationId","workspaceId","storeId","externalProductId",title,description,category,brand,status,"sourceVersion","sourceUpdatedAt","sourcePayloadHash","qualityState","qualityIssues")
 VALUES (scope.id,scope."organizationId",scope."workspaceId",scope."storeId",product->>'externalProductId',product->>'title',product->>'description',product->>'category',product->>'brand',product->>'status',
  product->'source'->>'version',CASE WHEN product->'source'->'updatedAt'<>'null'::jsonb THEN sync_host.product_time(product->'source'->>'updatedAt') END,payload_hash,
  product->'source'->'quality'->>'state',ARRAY(SELECT jsonb_array_elements_text(product->'source'->'quality'->'issues')))
 ON CONFLICT ("scopeId","externalProductId") DO UPDATE SET title=excluded.title,description=excluded.description,category=excluded.category,brand=excluded.brand,status=excluded.status,
  "sourceVersion"=excluded."sourceVersion","sourceUpdatedAt"=excluded."sourceUpdatedAt","sourcePayloadHash"=excluded."sourcePayloadHash","qualityState"=excluded."qualityState","qualityIssues"=excluded."qualityIssues","ingestedAt"=clock_timestamp();
 GET DIAGNOSTICS changed=ROW_COUNT;
 SELECT count(*) INTO expected_deleted FROM commerce."SkuListing" WHERE "scopeId"=scope.id AND "externalProductId"=product->>'externalProductId';
 DELETE FROM commerce."SkuListing" WHERE "scopeId"=scope.id AND "externalProductId"=product->>'externalProductId';
 GET DIAGNOSTICS deleted=ROW_COUNT;
 INSERT INTO commerce."SkuListing" ("scopeId","organizationId","workspaceId","storeId","externalSkuId","externalProductId",attributes,"salePriceMinor","costPriceMinor","originalPriceMinor",status)
 SELECT scope.id,scope."organizationId",scope."workspaceId",scope."storeId",sku->>'externalSkuId',sku->>'externalProductId',sku->'attributes',
  (sku->>'salePriceMinor')::bigint,(sku->>'costPriceMinor')::bigint,(sku->>'originalPriceMinor')::bigint,sku->>'status' FROM jsonb_array_elements(product->'skus') sku;
 GET DIAGNOSTICS inserted=ROW_COUNT;
 IF changed<>1 OR deleted<>expected_deleted OR inserted<>jsonb_array_length(product->'skus') THEN
  RAISE EXCEPTION 'PRODUCT_WRITE_COUNT_MISMATCH' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('skuInsertedCount',inserted,'skuDeletedCount',deleted);
END $$;

CREATE FUNCTION sync_host.product_decisions(candidates JSONB, scope commerce."SourceScope") RETURNS JSONB
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE candidate JSONB; product JSONB; previous commerce."ProductListing"; evidence JSONB; incoming JSONB; decision TEXT;
 reason TEXT; payload_hash TEXT; effects JSONB; result JSONB:='[]'; ordinal INTEGER:=0;
BEGIN
 FOR candidate IN SELECT * FROM jsonb_array_elements(candidates) LOOP
  product:=candidate->'product'; reason:=candidate->>'reason'; decision:='QUARANTINED'; effects:='{}'; evidence:=NULL;
  IF reason IS NULL THEN
   SELECT * INTO previous FROM commerce."ProductListing" p WHERE p."scopeId"=scope.id AND p."externalProductId"=product->>'externalProductId' FOR UPDATE;
   IF FOUND THEN evidence:=jsonb_build_object('version',previous."sourceVersion",'updatedAt',
    CASE WHEN previous."sourceUpdatedAt" IS NOT NULL THEN to_char(previous."sourceUpdatedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,'payloadHash',previous."sourcePayloadHash"); END IF;
   payload_hash:=sync_host.product_payload_hash(product);
   incoming:=(product->'source')-'quality'||jsonb_build_object('payloadHash',payload_hash);
   decision:=sync_host.product_source_order(evidence,incoming);
   IF decision='CONFLICT' THEN decision:='QUARANTINED'; reason:='SOURCE_CONFLICT'; END IF;
   IF decision='APPLY' THEN effects:=sync_host.product_apply(product,scope,payload_hash); END IF;
  END IF;
  result:=result||jsonb_build_array(candidate-'product'||jsonb_build_object('ordinal',ordinal,'decision',decision,
   'reason',reason,'previous',evidence)||effects);
  ordinal:=ordinal+1;
 END LOOP;
 RETURN result;
END $$;

CREATE FUNCTION sync_host.product_counts(decisions JSONB) RETURNS JSONB LANGUAGE SQL SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('inputCount',count(*),'appliedCount',count(*) FILTER (WHERE item->>'decision'='APPLY'),
  'duplicateCount',count(*) FILTER (WHERE item->>'decision'='DUPLICATE'),'staleCount',count(*) FILTER (WHERE item->>'decision'='STALE'),
  'quarantinedCount',count(*) FILTER (WHERE item->>'decision'='QUARANTINED'),
  'skuInsertedCount',coalesce(sum((item->>'skuInsertedCount')::integer),0),'skuDeletedCount',coalesce(sum((item->>'skuDeletedCount')::integer),0))
 FROM jsonb_array_elements(decisions) item
$$;

CREATE FUNCTION sync_host.product_save_commit(job sync_host."Job", scope_id UUID, page_id TEXT, page JSONB,
 page_hash TEXT, decisions JSONB) RETURNS sync_host."ProductPageCommit"
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE totals JSONB:=sync_host.product_counts(decisions); receipt sync_host."ProductPageCommit"; changed INTEGER;
BEGIN
 INSERT INTO sync_host."ProductPageCommit" ("jobId","pageId","scopeId","organizationId","workspaceId","storeId","pageHash","observedAt","sourceWatermark",terminal,"acceptedFence",
  "inputCount","appliedCount","duplicateCount","staleCount","quarantinedCount","skuInsertedCount","skuDeletedCount")
 VALUES (job.id,page_id,scope_id,job."organizationId",job."workspaceId",job."storeId",page_hash,sync_host.product_time(page->>'observedAt'),
  CASE WHEN page->'sourceWatermark'<>'null'::jsonb THEN sync_host.product_time(page->>'sourceWatermark') END,page->'nextCursor'='null'::jsonb,job.fence,
  (totals->>'inputCount')::integer,(totals->>'appliedCount')::integer,(totals->>'duplicateCount')::integer,(totals->>'staleCount')::integer,
  (totals->>'quarantinedCount')::integer,(totals->>'skuInsertedCount')::integer,(totals->>'skuDeletedCount')::integer) RETURNING * INTO receipt;
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>1 THEN RAISE EXCEPTION 'PRODUCT_RECEIPT_WRITE_COUNT_MISMATCH' USING ERRCODE='23514'; END IF;
 INSERT INTO sync_host."ProductPageDecision" ("jobId","pageId",ordinal,"organizationId","workspaceId","storeId","externalProductId","candidateHash",decision,"previousVersion","previousUpdatedAt","previousPayloadHash")
 SELECT job.id,page_id,(item->>'ordinal')::integer,job."organizationId",job."workspaceId",job."storeId",item->>'externalProductId',item->>'candidateHash',item->>'decision',
  item->'previous'->>'version',CASE WHEN item->'previous'->>'updatedAt' IS NOT NULL THEN sync_host.product_time(item->'previous'->>'updatedAt') END,item->'previous'->>'payloadHash'
 FROM jsonb_array_elements(decisions) item;
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>jsonb_array_length(decisions) THEN RAISE EXCEPTION 'PRODUCT_RECEIPT_WRITE_COUNT_MISMATCH' USING ERRCODE='23514'; END IF;
 INSERT INTO sync_host."ProductQuarantine" ("jobId","pageId",ordinal,"organizationId","workspaceId","storeId",reason)
 SELECT job.id,page_id,(item->>'ordinal')::integer,job."organizationId",job."workspaceId",job."storeId",item->>'reason'
 FROM jsonb_array_elements(decisions) item WHERE item->>'decision'='QUARANTINED';
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>(totals->>'quarantinedCount')::integer THEN RAISE EXCEPTION 'PRODUCT_RECEIPT_WRITE_COUNT_MISMATCH' USING ERRCODE='23514'; END IF;
 RETURN receipt;
END $$;

CREATE FUNCTION sync_host.product_commit_result(receipt sync_host."ProductPageCommit", status TEXT) RETURNS JSONB
LANGUAGE SQL SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('status',status,'inputCount',receipt."inputCount",'appliedCount',receipt."appliedCount",
  'duplicateCount',receipt."duplicateCount",'staleCount',receipt."staleCount",'quarantinedCount',receipt."quarantinedCount",
  'skuInsertedCount',receipt."skuInsertedCount",'skuDeletedCount',receipt."skuDeletedCount")
$$;

CREATE FUNCTION sync_host.commit_product_page(job_id TEXT, expected_fence INTEGER, page_id TEXT, expected_cursor TEXT, page JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job sync_host."Job"; scope commerce."SourceScope"; receipt sync_host."ProductPageCommit";
 page_hash TEXT; decisions JSONB; staged_through TIMESTAMP; staged_job sync_host."Job";
BEGIN
 job:=sync_host.product_open_job(job_id,expected_fence);
 IF page_id IS NULL OR page_id !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$' THEN RAISE EXCEPTION 'INVALID_PAGE' USING ERRCODE='23514'; END IF;
 PERFORM sync_host.product_string(coalesce(to_jsonb(expected_cursor),'null'::jsonb),1024,false,true);
 PERFORM sync_host.product_page_input(page,job."externalStoreId",job.until AT TIME ZONE 'UTC');
 page_hash:=sync_host.product_page_hash(to_jsonb(job),expected_cursor,page);
 SELECT * INTO receipt FROM sync_host."ProductPageCommit" c WHERE c."jobId"=job_id AND c."pageId"=page_id;
 IF FOUND THEN
  IF receipt."pageHash"<>page_hash THEN RAISE EXCEPTION 'Conflicting product page' USING ERRCODE='23505'; END IF;
  RETURN sync_host.product_commit_result(receipt,'REPLAYED');
 END IF;
 IF job."receiptCursor" #>> '{}' IS DISTINCT FROM expected_cursor THEN RAISE EXCEPTION 'Non-contiguous product page' USING ERRCODE='23514'; END IF;
 IF EXISTS (SELECT 1 FROM sync_host."PageReceipt" r WHERE r."jobId"=job_id AND NOT EXISTS
  (SELECT 1 FROM sync_host."ProductPageCommit" c WHERE c."jobId"=r."jobId" AND c."pageId"=r."pageId")) THEN
  RAISE EXCEPTION 'UNCOMMITTED_PRODUCT_RECEIPT' USING ERRCODE='23514'; END IF;
 scope:=sync_host.product_scope(job);
 decisions:=sync_host.product_decisions(sync_host.product_candidates(page,job,scope.id),scope);
 -- Terminal staging records the requested boundary, never a business success or actual watermark.
 staged_through:=CASE WHEN page->'nextCursor'='null'::jsonb THEN job.until ELSE coalesce(job."receivedThrough",job.since) END;
 PERFORM sync_host.stage_page(job_id,expected_fence,page_id,expected_cursor,page->>'nextCursor',staged_through,page_hash);
 SELECT * INTO staged_job FROM sync_host."Job" WHERE id=job_id;
 IF (staged_job."receiptCursor" #>> '{}',staged_job."receivedThrough") IS DISTINCT FROM (page->>'nextCursor',staged_through)
  OR NOT EXISTS (SELECT 1 FROM sync_host."PageReceipt" r WHERE r."jobId"=job_id AND r."pageId"=page_id
   AND (r."expectedCursor",r."nextCursor",r."receivedThrough",r."pageHash") IS NOT DISTINCT FROM (expected_cursor,page->>'nextCursor',staged_through,page_hash)) THEN
  RAISE EXCEPTION 'PRODUCT_STAGE_MISMATCH' USING ERRCODE='23514'; END IF;
 receipt:=sync_host.product_save_commit(job,scope.id,page_id,page,page_hash,decisions);
 PERFORM sync_host.require_page_lease(job,expected_fence);
 RETURN sync_host.product_commit_result(receipt,'APPLIED');
END $$;

CREATE FUNCTION sync_host.guard_product_commit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job sync_host."Job"; counts JSONB;
BEGIN
 SELECT * INTO job FROM sync_host."Job" WHERE id=NEW."jobId";
 PERFORM sync_host.require_page_lease(job,NEW."acceptedFence");
 SELECT sync_host.product_counts(coalesce(jsonb_agg(jsonb_build_object('decision',decision)),'[]'::jsonb)) INTO counts
 FROM sync_host."ProductPageDecision" WHERE "jobId"=NEW."jobId" AND "pageId"=NEW."pageId";
 IF ((counts->>'inputCount')::integer,(counts->>'appliedCount')::integer,(counts->>'duplicateCount')::integer,(counts->>'staleCount')::integer,(counts->>'quarantinedCount')::integer)
  IS DISTINCT FROM (NEW."inputCount",NEW."appliedCount",NEW."duplicateCount",NEW."staleCount",NEW."quarantinedCount")
  OR (SELECT count(*) FROM sync_host."ProductQuarantine" WHERE "jobId"=NEW."jobId" AND "pageId"=NEW."pageId")<>NEW."quarantinedCount" THEN
  RAISE EXCEPTION 'PRODUCT_RECEIPT_COUNT_MISMATCH' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER guard_product_commit AFTER INSERT ON sync_host."ProductPageCommit"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sync_host.guard_product_commit();
CREATE FUNCTION sync_host.immutable_product_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Immutable product receipt' USING ERRCODE='23514'; END $$;
CREATE TRIGGER immutable_product_commit BEFORE UPDATE OR DELETE ON sync_host."ProductPageCommit" FOR EACH ROW EXECUTE FUNCTION sync_host.immutable_product_receipt();
CREATE TRIGGER immutable_product_decision BEFORE UPDATE OR DELETE ON sync_host."ProductPageDecision" FOR EACH ROW EXECUTE FUNCTION sync_host.immutable_product_receipt();
CREATE TRIGGER immutable_product_quarantine BEFORE UPDATE OR DELETE ON sync_host."ProductQuarantine" FOR EACH ROW EXECUTE FUNCTION sync_host.immutable_product_receipt();
REVOKE ALL ON FUNCTION sync_host.product_open_job(TEXT,INTEGER),sync_host.product_scope(sync_host."Job"),
 sync_host.product_candidates(JSONB,sync_host."Job",UUID),sync_host.product_ownership_conflict(JSONB,JSONB,UUID),
 sync_host.product_apply(JSONB,commerce."SourceScope",TEXT),sync_host.product_decisions(JSONB,commerce."SourceScope"),
 sync_host.product_counts(JSONB),sync_host.product_save_commit(sync_host."Job",UUID,TEXT,JSONB,TEXT,JSONB),
 sync_host.product_commit_result(sync_host."ProductPageCommit",TEXT),sync_host.commit_product_page(TEXT,INTEGER,TEXT,TEXT,JSONB),
 sync_host.guard_product_commit(),sync_host.immutable_product_receipt() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sync_host.commit_product_page(TEXT,INTEGER,TEXT,TEXT,JSONB) TO shopmate_sync_worker;
COMMIT;

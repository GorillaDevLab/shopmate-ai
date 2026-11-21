BEGIN;

CREATE FUNCTION public.observed_opaque_text(value_ TEXT, maximum_ INTEGER) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  -- The wire contract bounds strings in UTF-16 code units and preserves their spelling.
  SELECT length(value_)+length(regexp_replace(value_,U&'[\0001-\FFFF]','','g')) BETWEEN 1 AND maximum_
    AND value_=btrim(value_,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
    AND value_ !~ U&'[\0001-\001F\007F-\009F\200B-\200F\202A-\202E\2066-\2069]'
$$;

CREATE FUNCTION public.observed_time(value_ TIMESTAMPTZ) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT value_ BETWEEN '0001-01-01 00:00:00+00'::timestamptz AND '9999-12-31 23:59:59.999+00'::timestamptz
    AND value_ AT TIME ZONE 'UTC'=date_trunc('milliseconds',value_ AT TIME ZONE 'UTC')
$$;

CREATE FUNCTION public.observed_subject_valid(domain_ TEXT, kind_ TEXT, subject_ TEXT) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT (CASE domain_
    WHEN 'FEE' THEN kind_='STORE'
    WHEN 'TRAFFIC' THEN kind_ IN ('STORE','SKU')
    WHEN 'CAMPAIGN_MEASUREMENT' THEN kind_='CAMPAIGN'
    WHEN 'SYNC_TRANSITION' THEN kind_='CONNECTION'
    ELSE domain_ IN ('FROZEN_COST','REFUND_ALLOCATION','RETURN_RECEIPT','LISTING','PRICE',
      'INVENTORY_LOT','SUPPLIER_NOTICE','INVENTORY_POSITION') AND kind_='SKU'
  END) AND CASE kind_ WHEN 'STORE' THEN subject_='' ELSE public.observed_opaque_text(subject_,256) END
$$;

CREATE TABLE public.observed_scopes (
  "scopeId" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "organizationId" TEXT COLLATE "C" NOT NULL,
  "workspaceId" TEXT COLLATE "C" NOT NULL,
  "storeId" TEXT COLLATE "C" NOT NULL,
  "connectionId" TEXT COLLATE "C" NOT NULL,
  "externalStoreId" TEXT COLLATE "C" NOT NULL,
  generation INTEGER NOT NULL,
  CONSTRAINT observed_scopes_binding_valid CHECK ((
    "organizationId" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
    AND "workspaceId" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
    AND "storeId" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
    AND "connectionId" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
    AND public.observed_opaque_text("externalStoreId",256) AND generation >= 0
  ) IS TRUE),
  CONSTRAINT observed_scopes_connection_fkey
    FOREIGN KEY ("connectionId","organizationId","workspaceId","storeId","externalStoreId")
    REFERENCES public."PlatformConnection"(id,"organizationId","workspaceId","storeId","externalStoreId")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT observed_scopes_connection_generation_key UNIQUE ("connectionId",generation)
);

CREATE TABLE public.observed_page_receipts (
  "receiptKey" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "scopeId" UUID NOT NULL,
  "receiptId" TEXT COLLATE "C" NOT NULL,
  domain TEXT COLLATE "C" NOT NULL,
  "subjectKind" TEXT COLLATE "C" NOT NULL,
  "subjectId" TEXT COLLATE "C" NOT NULL,
  "periodStart" TIMESTAMPTZ(6) NOT NULL,
  "periodEnd" TIMESTAMPTZ(6) NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  currency TEXT NOT NULL DEFAULT 'CNY',
  through TIMESTAMPTZ(6) NOT NULL,
  "modelVersion" TEXT COLLATE "C" NOT NULL,
  "configHash" TEXT COLLATE "C" NOT NULL,
  "publicationId" TEXT COLLATE "C" NOT NULL,
  "publicationHash" TEXT COLLATE "C" NOT NULL,
  "pageId" TEXT COLLATE "C" NOT NULL,
  "pageIndex" INTEGER NOT NULL,
  "pageHash" TEXT COLLATE "C" NOT NULL,
  "priorPageHash" TEXT COLLATE "C",
  "expectedCursor" TEXT COLLATE "C",
  "nextCursor" TEXT COLLATE "C",
  "terminalCoverageBps" INTEGER,
  "recordCount" INTEGER NOT NULL,
  "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT observed_receipts_scope_fkey FOREIGN KEY ("scopeId")
    REFERENCES public.observed_scopes("scopeId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT observed_receipts_identity_key UNIQUE ("scopeId","receiptId"),
  CONSTRAINT observed_receipts_page_id_key UNIQUE ("scopeId","publicationId","pageId"),
  CONSTRAINT observed_receipts_page_index_key UNIQUE ("scopeId","publicationId","pageIndex"),
  CONSTRAINT observed_receipts_partition_key UNIQUE ("receiptKey","scopeId",domain,"subjectKind","subjectId"),
  CONSTRAINT observed_receipts_identity_valid CHECK ((
    public.observed_opaque_text("receiptId",256) AND public.observed_opaque_text("publicationId",256)
    AND public.observed_opaque_text("pageId",256) AND public.observed_subject_valid(domain,"subjectKind","subjectId")
  ) IS TRUE),
  CONSTRAINT observed_receipts_window_valid CHECK ((
    "periodStart" < "periodEnd" AND "periodEnd" <= through
    AND public.observed_time("periodStart") AND public.observed_time("periodEnd") AND public.observed_time(through)
    AND timezone='Asia/Shanghai' AND currency='CNY'
  ) IS TRUE),
  CONSTRAINT observed_receipts_hashes_valid CHECK ((
    "modelVersion"='mock-business-observed-v1' AND "configHash" ~ '^[a-f0-9]{64}$'
    AND "publicationHash" ~ '^[a-f0-9]{64}$' AND "pageHash" ~ '^[a-f0-9]{64}$'
    AND ("priorPageHash" IS NULL OR "priorPageHash" ~ '^[a-f0-9]{64}$')
  ) IS TRUE),
  CONSTRAINT observed_receipts_page_valid CHECK ((
    "pageIndex" BETWEEN 0 AND 4095 AND "recordCount" BETWEEN 0 AND 200
    AND ("priorPageHash" IS NULL)=("pageIndex"=0) AND ("expectedCursor" IS NULL)=("pageIndex"=0)
    AND ("nextCursor" IS NULL)=("terminalCoverageBps" IS NOT NULL)
    AND ("terminalCoverageBps" IS NULL OR "terminalCoverageBps" BETWEEN 0 AND 10000)
    AND ("expectedCursor" IS NULL OR public.observed_opaque_text("expectedCursor",1024))
    AND ("nextCursor" IS NULL OR public.observed_opaque_text("nextCursor",1024))
  ) IS TRUE)
);

CREATE TABLE public.observed_facts (
  "factKey" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "scopeId" UUID NOT NULL,
  domain TEXT COLLATE "C" NOT NULL,
  "subjectKind" TEXT COLLATE "C" NOT NULL,
  "subjectId" TEXT COLLATE "C" NOT NULL,
  "factId" TEXT COLLATE "C" NOT NULL,
  sequence BIGINT NOT NULL,
  "priorSequence" BIGINT,
  "producerVersion" TEXT COLLATE "C" NOT NULL,
  "modelVersion" TEXT COLLATE "C" NOT NULL,
  "occurredAt" TIMESTAMPTZ(6) NOT NULL,
  "observedAt" TIMESTAMPTZ(6) NOT NULL,
  "payloadHash" TEXT COLLATE "C" NOT NULL,
  payload JSONB NOT NULL,
  "originReceiptKey" UUID NOT NULL,
  "factBytes" BYTEA NOT NULL,
  CONSTRAINT observed_facts_scope_fkey FOREIGN KEY ("scopeId")
    REFERENCES public.observed_scopes("scopeId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT observed_facts_partition_key UNIQUE ("factKey","scopeId",domain,"subjectKind","subjectId"),
  CONSTRAINT observed_facts_sequence_key UNIQUE ("scopeId",domain,sequence),
  CONSTRAINT observed_facts_predecessor_key UNIQUE ("scopeId",domain,"subjectKind","subjectId","factId",sequence),
  -- A NULL prior denotes a chain root. It must be unique as well.
  CONSTRAINT observed_facts_chain_key UNIQUE NULLS NOT DISTINCT ("scopeId",domain,"factId","priorSequence"),
  CONSTRAINT observed_facts_predecessor_fkey
    FOREIGN KEY ("scopeId",domain,"subjectKind","subjectId","factId","priorSequence")
    REFERENCES public.observed_facts("scopeId",domain,"subjectKind","subjectId","factId",sequence)
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT observed_facts_sequence_valid CHECK ((
    sequence BETWEEN 1 AND 9007199254740991
    AND ("priorSequence" IS NULL OR "priorSequence" BETWEEN 1 AND sequence-1)
  ) IS TRUE),
  CONSTRAINT observed_facts_identity_valid CHECK ((
    public.observed_subject_valid(domain,"subjectKind","subjectId")
    AND public.observed_opaque_text("factId",256) AND public.observed_opaque_text("producerVersion",256)
  ) IS TRUE),
  CONSTRAINT observed_facts_payload_valid CHECK ((
    "modelVersion"='mock-business-observed-v1' AND "payloadHash" ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(payload)='object'
  ) IS TRUE),
  CONSTRAINT observed_facts_time_valid CHECK ((
    public.observed_time("occurredAt") AND public.observed_time("observedAt") AND "occurredAt" <= "observedAt"
  ) IS TRUE)
);

CREATE TABLE public.observed_receipt_members (
  "receiptKey" UUID NOT NULL,
  ordinal INTEGER NOT NULL,
  "factKey" UUID NOT NULL,
  "scopeId" UUID NOT NULL,
  domain TEXT COLLATE "C" NOT NULL,
  "subjectKind" TEXT COLLATE "C" NOT NULL,
  "subjectId" TEXT COLLATE "C" NOT NULL,
  PRIMARY KEY ("receiptKey",ordinal),
  CONSTRAINT observed_members_fact_key UNIQUE ("receiptKey","factKey"),
  CONSTRAINT observed_members_receipt_fkey FOREIGN KEY ("receiptKey","scopeId",domain,"subjectKind","subjectId")
    REFERENCES public.observed_page_receipts("receiptKey","scopeId",domain,"subjectKind","subjectId")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT observed_members_fact_fkey FOREIGN KEY ("factKey","scopeId",domain,"subjectKind","subjectId")
    REFERENCES public.observed_facts("factKey","scopeId",domain,"subjectKind","subjectId")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT observed_members_ordinal_valid CHECK (ordinal BETWEEN 0 AND 199)
);
-- New facts and original memberships can only enter committed history together.
ALTER TABLE public.observed_facts ADD CONSTRAINT observed_facts_origin_member_fkey
  FOREIGN KEY ("originReceiptKey","factKey") REFERENCES public.observed_receipt_members("receiptKey","factKey")
  ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION public.observed_stamp_receipt() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  connection_ TEXT;
BEGIN
  SELECT s."connectionId" INTO connection_ FROM public.observed_scopes AS s WHERE s."scopeId"=NEW."scopeId";
  IF NOT FOUND THEN
    -- Foreign key integrity checks can see a parent hidden from this trigger by RLS.
    RAISE EXCEPTION 'Observed receipt scope is unavailable'
      USING ERRCODE='23503', SCHEMA='public', TABLE='observed_page_receipts',
        CONSTRAINT='observed_receipts_scope_fkey';
  END IF;
  IF NEW."subjectKind"='CONNECTION' AND NEW."subjectId"<>connection_ THEN
    RAISE EXCEPTION 'Observed receipt subject does not match its connection'
      USING ERRCODE='23514', CONSTRAINT='observed_receipts_connection_subject';
  END IF;
  NEW."recordedAt" := date_trunc('milliseconds',clock_timestamp());
  RETURN NEW;
END
$$;
CREATE TRIGGER observed_receipts_stamp BEFORE INSERT ON public.observed_page_receipts
  FOR EACH ROW EXECUTE FUNCTION public.observed_stamp_receipt();

CREATE FUNCTION public.observed_fact_envelope(f_ public.observed_facts, s_ public.observed_scopes) RETURNS JSONB
LANGUAGE SQL STABLE STRICT SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object(
    'schemaVersion',1,'ledgerVersion','observed-facts-v1',
    'binding',jsonb_build_object(
      'organizationId',s_."organizationId",'workspaceId',s_."workspaceId",'storeId',s_."storeId",
      'connectionId',s_."connectionId",'externalStoreId',s_."externalStoreId"),
    'generation',s_.generation,'domain',f_.domain,'factId',f_."factId",'sequence',f_.sequence,
    'subject',jsonb_build_object('kind',f_."subjectKind") || CASE f_."subjectKind"
      WHEN 'SKU' THEN jsonb_build_object('externalSkuId',f_."subjectId")
      WHEN 'CAMPAIGN' THEN jsonb_build_object('externalCampaignId',f_."subjectId")
      WHEN 'CONNECTION' THEN jsonb_build_object('connectionId',s_."connectionId")
      ELSE '{}'::jsonb END,
    'sourceVersion','observed-v1:g:'||s_.generation||':e:'||f_.sequence,
    'priorVersion','observed-v1:g:'||s_.generation||':e:'||f_."priorSequence",
    'producerVersion',f_."producerVersion",'modelVersion',f_."modelVersion",
    'occurredAt',to_char(f_."occurredAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'observedAt',to_char(f_."observedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'payloadHash',f_."payloadHash",'payload',f_.payload)
$$;

-- Keep the source fact JSON bytes unchanged. The typed representation must decode to the same
-- envelope and payload. Source certification owns the authoritative byte and hash checks.
CREATE FUNCTION public.observed_check_fact_bytes() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  scope_ public.observed_scopes;
  bytes_ TEXT;
BEGIN
  SELECT * INTO scope_ FROM public.observed_scopes AS s WHERE s."scopeId"=NEW."scopeId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Observed fact scope is unavailable'
      USING ERRCODE='23503', SCHEMA='public', TABLE='observed_facts',
        CONSTRAINT='observed_facts_scope_fkey';
  END IF;
  IF NEW."subjectKind"='CONNECTION' AND NEW."subjectId"<>scope_."connectionId" THEN
    RAISE EXCEPTION 'Observed fact subject does not match its connection'
      USING ERRCODE='23514', CONSTRAINT='observed_facts_connection_subject';
  END IF;
  bytes_ := convert_from(NEW."factBytes",'UTF8');
  IF (bytes_ IS JSON OBJECT WITH UNIQUE KEYS) IS TRUE THEN
    IF bytes_::jsonb=public.observed_fact_envelope(NEW,scope_) THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Observed fact bytes do not match the stored fact'
    USING ERRCODE='23514', CONSTRAINT='observed_facts_exact_bytes';
END
$$;
CREATE TRIGGER observed_facts_exact_bytes BEFORE INSERT ON public.observed_facts
  FOR EACH ROW EXECUTE FUNCTION public.observed_check_fact_bytes();

-- Both inserts schedule the check so even an empty receipt or an attempted late edge is validated.
CREATE FUNCTION public.observed_check_members() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.observed_page_receipts AS r
    CROSS JOIN LATERAL (
      SELECT count(*) AS members, count(DISTINCT "factId") AS identities,
        bool_and(ordinal=position-1 AND (previous IS NULL OR previous<sequence)
          AND "observedAt"<=r.through) AS ordered
      FROM (
        SELECT m.ordinal, f."factId", f.sequence, f."observedAt",
          row_number() OVER member_order AS position, lag(f.sequence) OVER member_order AS previous
        FROM public.observed_receipt_members AS m
        JOIN public.observed_facts AS f ON f."factKey"=m."factKey"
        WHERE m."receiptKey"=r."receiptKey"
        WINDOW member_order AS (ORDER BY m.ordinal)
      ) AS page_members
    ) AS page
    WHERE r."receiptKey"=NEW."receiptKey" AND page.members=r."recordCount"
      AND page.members=page.identities AND coalesce(page.ordered,TRUE)
  ) THEN
    RAISE EXCEPTION 'Observed receipt membership is invalid'
      USING ERRCODE='23514', CONSTRAINT='observed_receipt_members_valid';
  END IF;
  RETURN NEW;
END
$$;
CREATE CONSTRAINT TRIGGER observed_receipts_members_valid AFTER INSERT ON public.observed_page_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.observed_check_members();
CREATE CONSTRAINT TRIGGER observed_members_receipt_valid AFTER INSERT ON public.observed_receipt_members
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.observed_check_members();

CREATE FUNCTION public.observed_reject_history_mutation() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Observed history is immutable'
    USING ERRCODE='23514', CONSTRAINT='observed_history_immutable';
END
$$;
CREATE TRIGGER observed_scopes_immutable BEFORE UPDATE OR DELETE ON public.observed_scopes
  FOR EACH STATEMENT EXECUTE FUNCTION public.observed_reject_history_mutation();
CREATE TRIGGER observed_receipts_immutable BEFORE UPDATE OR DELETE ON public.observed_page_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION public.observed_reject_history_mutation();
CREATE TRIGGER observed_facts_immutable BEFORE UPDATE OR DELETE ON public.observed_facts
  FOR EACH STATEMENT EXECUTE FUNCTION public.observed_reject_history_mutation();
CREATE TRIGGER observed_members_immutable BEFORE UPDATE OR DELETE ON public.observed_receipt_members
  FOR EACH STATEMENT EXECUTE FUNCTION public.observed_reject_history_mutation();
CREATE TRIGGER observed_scopes_no_truncate BEFORE TRUNCATE ON public.observed_scopes
  FOR EACH STATEMENT EXECUTE FUNCTION public.observed_reject_history_mutation();
CREATE TRIGGER observed_receipts_no_truncate BEFORE TRUNCATE ON public.observed_page_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION public.observed_reject_history_mutation();
CREATE TRIGGER observed_facts_no_truncate BEFORE TRUNCATE ON public.observed_facts
  FOR EACH STATEMENT EXECUTE FUNCTION public.observed_reject_history_mutation();
CREATE TRIGGER observed_members_no_truncate BEFORE TRUNCATE ON public.observed_receipt_members
  FOR EACH STATEMENT EXECUTE FUNCTION public.observed_reject_history_mutation();

REVOKE ALL ON public.observed_scopes,public.observed_page_receipts,public.observed_facts,
  public.observed_receipt_members FROM PUBLIC;
REVOKE ALL ON FUNCTION public.observed_opaque_text(TEXT,INTEGER),public.observed_time(TIMESTAMPTZ),
  public.observed_subject_valid(TEXT,TEXT,TEXT),public.observed_stamp_receipt(),
  public.observed_fact_envelope(public.observed_facts,public.observed_scopes),public.observed_check_fact_bytes(),
  public.observed_check_members(),public.observed_reject_history_mutation() FROM PUBLIC;

COMMIT;

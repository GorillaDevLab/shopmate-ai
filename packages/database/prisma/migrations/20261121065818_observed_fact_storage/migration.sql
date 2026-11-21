BEGIN;

DO $$
DECLARE
  roles_ TEXT[] := ARRAY['shopmate_observed_publisher','shopmate_observed_consumer',
    'shopmate_observed_reader','shopmate_observed_definition_provisioner','shopmate_observed_guard'];
  role_ TEXT;
BEGIN
  FOREACH role_ IN ARRAY roles_ LOOP
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname=role_) THEN
      EXECUTE pg_catalog.format(
        'CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION',role_);
    ELSIF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname=role_ AND
      (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
      RAISE EXCEPTION 'Unsafe observed capability role' USING ERRCODE='42501';
    END IF;
  END LOOP;
  -- PostgreSQL 16 records admin-only membership for a non-superuser role creator.
  IF EXISTS (SELECT FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.member
    WHERE r.rolname=ANY(roles_) OR (m.roleid='shopmate_observed_guard'::regrole AND
      (m.set_option OR m.inherit_option OR NOT m.admin_option OR
        NOT (r.rolsuper OR (r.rolcreaterole AND r.rolbypassrls))))) THEN
    RAISE EXCEPTION 'Unsafe observed capability role membership' USING ERRCODE='42501';
  END IF;
END
$$;

DO $$
DECLARE
  database_ OID := (SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database());
  guard_ OID := 'shopmate_observed_guard'::regrole;
BEGIN
  -- Roles are cluster-wide. Reject pre-existing authority over objects in this database.
  IF EXISTS (SELECT FROM pg_catalog.pg_shdepend d WHERE d.refclassid='pg_catalog.pg_authid'::regclass
    AND d.refobjid=guard_ AND d.deptype='o' AND d.dbid=database_)
    OR EXISTS (SELECT FROM pg_catalog.pg_database d WHERE d.oid=database_ AND d.datdba=guard_) THEN
    RAISE EXCEPTION 'Unsafe observed guard ownership' USING ERRCODE='42501';
  END IF;
END
$$;

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

CREATE FUNCTION public.observed_json_keys(value_ JSONB, keys_ TEXT[]) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT CASE WHEN jsonb_typeof(value_)='object'
    THEN value_ ?& keys_ AND value_-keys_='{}'::jsonb
    ELSE FALSE END
$$;

CREATE FUNCTION public.observed_json_id(value_ JSONB) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT jsonb_typeof(value_)='string' AND public.observed_opaque_text(value_#>>'{}',256)
$$;

CREATE FUNCTION public.observed_json_number(value_ JSONB) RETURNS NUMERIC
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT CASE WHEN jsonb_typeof(value_)='number' THEN value_::numeric END
$$;

CREATE FUNCTION public.observed_json_integer(
  value_ JSONB, minimum_ BIGINT DEFAULT 0, maximum_ BIGINT DEFAULT 9007199254740991
) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT number_ BETWEEN minimum_ AND maximum_ AND trunc(number_)=number_
  FROM public.observed_json_number(value_) AS number_
$$;

CREATE FUNCTION public.observed_json_time(value_ JSONB) RETURNS TIMESTAMPTZ
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT CASE WHEN jsonb_typeof(value_)='string' AND left(text_,4)<>'0000'
    AND text_ ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$'
    AND pg_input_is_valid(text_,'timestamp with time zone') THEN text_::timestamptz END
  FROM (SELECT value_#>>'{}' AS text_) AS scalar
$$;

CREATE FUNCTION public.observed_payload_sku(p_ JSONB, subject_ TEXT) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT public.observed_json_id(p_->'externalSkuId')
    AND p_->>'externalSkuId'=subject_ COLLATE "C"
$$;

CREATE FUNCTION public.observed_finance_line(p_ JSONB, subject_ TEXT) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT public.observed_payload_sku(p_,subject_)
    AND public.observed_json_id(p_->'externalOrderId')
    AND public.observed_json_id(p_->'externalLineId')
$$;

CREATE FUNCTION public.observed_frozen_cost(p_ JSONB, subject_ TEXT, seen_ TIMESTAMPTZ) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT public.observed_json_keys(p_,ARRAY['externalSkuId','externalOrderId','externalLineId',
      'quantity','frozenAt','skuCostVersion','unitCostMinor','basis','currency','reason'])
    AND public.observed_finance_line(p_,subject_)
    AND public.observed_json_integer(p_->'quantity',1)
    AND public.observed_json_time(p_->'frozenAt')<=seen_
    AND p_->>'currency'='CNY'
    AND (p_->'skuCostVersion'='null'::jsonb OR public.observed_json_id(p_->'skuCostVersion'))
    AND CASE p_->>'basis'
      WHEN 'UNAVAILABLE' THEN p_->'unitCostMinor'='null'::jsonb AND p_->>'reason'='COST_MISSING'
      WHEN 'ESTIMATED' THEN p_->'skuCostVersion'<>'null'::jsonb
        AND public.observed_json_integer(p_->'unitCostMinor') AND p_->>'reason'='COST_ESTIMATED'
      WHEN 'CONFIRMED' THEN p_->'skuCostVersion'<>'null'::jsonb
        AND public.observed_json_integer(p_->'unitCostMinor') AND p_->'reason'='null'::jsonb
      ELSE FALSE END
$$;

CREATE FUNCTION public.observed_refund_allocation(p_ JSONB, subject_ TEXT, seen_ TIMESTAMPTZ) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT public.observed_json_keys(p_,ARRAY['externalSkuId','externalOrderId','externalLineId',
      'externalRefundId','quantity','merchandiseMinor','buyerShippingMinor','settledAt','currency','reason'])
    AND public.observed_finance_line(p_,subject_)
    AND public.observed_json_id(p_->'externalRefundId')
    AND (p_->'quantity'='null'::jsonb OR public.observed_json_integer(p_->'quantity'))
    AND (p_->'merchandiseMinor'='null'::jsonb OR public.observed_json_integer(p_->'merchandiseMinor'))
    AND (p_->'buyerShippingMinor'='null'::jsonb OR public.observed_json_integer(p_->'buyerShippingMinor'))
    AND public.observed_json_time(p_->'settledAt')<=seen_
    AND p_->>'currency'='CNY'
    AND CASE WHEN 'null'::jsonb IN (p_->'quantity',p_->'merchandiseMinor',p_->'buyerShippingMinor')
      THEN p_->>'reason'='REFUND_UNKNOWN' ELSE p_->'reason'='null'::jsonb END
$$;

CREATE FUNCTION public.observed_return_receipt(p_ JSONB, subject_ TEXT, seen_ TIMESTAMPTZ) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT public.observed_json_keys(p_,ARRAY['externalSkuId','externalOrderId','externalLineId',
      'externalRefundId','externalReceiptId','acceptedAt','resellableQuantity','reason'])
    AND public.observed_finance_line(p_,subject_)
    AND public.observed_json_id(p_->'externalRefundId')
    AND public.observed_json_id(p_->'externalReceiptId')
    AND (p_->'acceptedAt'='null'::jsonb OR public.observed_json_time(p_->'acceptedAt')<=seen_)
    AND CASE WHEN p_->'resellableQuantity'='null'::jsonb THEN p_->>'reason'='RETURN_UNKNOWN'
      ELSE p_->'acceptedAt'<>'null'::jsonb AND public.observed_json_integer(p_->'resellableQuantity')
        AND p_->'reason'='null'::jsonb END
$$;

CREATE FUNCTION public.observed_closed_window(w_ JSONB, seen_ TIMESTAMPTZ) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT public.observed_json_keys(w_,ARRAY['periodStart','periodEnd','timezone','currency'])
    AND w_->>'timezone'='Asia/Shanghai' AND w_->>'currency'='CNY'
    AND starts_<ends_ AND ends_<=seen_
  FROM (SELECT public.observed_json_time(w_->'periodStart') AS starts_,
    public.observed_json_time(w_->'periodEnd') AS ends_) AS limits
$$;

CREATE FUNCTION public.observed_measurement_quality(
  reason_ JSONB, missing_ BOOLEAN, missing_reason_ TEXT, complete_ BOOLEAN
) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT reason_=CASE WHEN missing_ THEN to_jsonb(missing_reason_)
    WHEN NOT complete_ THEN '"PARTIAL_COVERAGE"'::jsonb ELSE 'null'::jsonb END
$$;

CREATE FUNCTION public.observed_fee(p_ JSONB, seen_ TIMESTAMPTZ) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT public.observed_json_keys(p_,ARRAY['chargeId','kind','externalOrderId','externalCampaignId',
      'window','amountMinor','basis','coverageBasisPoints','reason'])
    AND public.observed_json_id(p_->'chargeId')
    AND p_->>'kind' IN ('FULFILLMENT','PLATFORM','PAYMENT','ADVERTISING_PROMOTION','OTHER_OPERATING')
    AND (p_->'externalOrderId'='null'::jsonb OR public.observed_json_id(p_->'externalOrderId'))
    AND (p_->'externalCampaignId'='null'::jsonb OR public.observed_json_id(p_->'externalCampaignId'))
    AND public.observed_closed_window(p_->'window',seen_)
    AND public.observed_json_integer(p_->'coverageBasisPoints',0,10000)
    AND CASE p_->>'basis'
      WHEN 'UNAVAILABLE' THEN p_->'amountMinor'='null'::jsonb AND p_->>'reason'='FEE_MISSING'
      WHEN 'ESTIMATED' THEN public.observed_json_integer(p_->'amountMinor') AND p_->>'reason'='FEE_ESTIMATED'
      WHEN 'CONFIRMED' THEN public.observed_json_integer(p_->'amountMinor')
        AND public.observed_measurement_quality(p_->'reason',FALSE,'FEE_MISSING',p_->'coverageBasisPoints'='10000'::jsonb)
      ELSE FALSE END
$$;

CREATE FUNCTION public.observed_traffic(p_ JSONB, seen_ TIMESTAMPTZ) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT public.observed_json_keys(p_,ARRAY['window','visitors','cart','checkout','paidOrders',
      'measurementVersion','coverageBasisPoints','reason'])
    AND public.observed_closed_window(p_->'window',seen_)
    AND (p_->'visitors'='null'::jsonb OR public.observed_json_integer(p_->'visitors'))
    AND (p_->'cart'='null'::jsonb OR public.observed_json_integer(p_->'cart'))
    AND (p_->'checkout'='null'::jsonb OR public.observed_json_integer(p_->'checkout'))
    AND (p_->'paidOrders'='null'::jsonb OR public.observed_json_integer(p_->'paidOrders'))
    AND public.observed_json_id(p_->'measurementVersion')
    AND public.observed_json_integer(p_->'coverageBasisPoints',0,10000)
    AND public.observed_measurement_quality(p_->'reason',
      'null'::jsonb IN (p_->'visitors',p_->'cart',p_->'checkout',p_->'paidOrders'),
      'TRAFFIC_MISSING',p_->'coverageBasisPoints'='10000'::jsonb)
$$;

CREATE FUNCTION public.observed_campaign_date(day_ JSONB, w_ JSONB) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT jsonb_typeof(day_)='string' AND day_#>>'{}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    AND day_#>>'{}'=to_char(starts_ AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD')
    -- The last included millisecond belongs to the business day even when the end is midnight.
    AND day_#>>'{}'=to_char((ends_-interval '1 millisecond') AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD')
  FROM (SELECT public.observed_json_time(w_->'periodStart') AS starts_,
    public.observed_json_time(w_->'periodEnd') AS ends_) AS limits
$$;

CREATE FUNCTION public.observed_campaign(p_ JSONB, subject_ TEXT, seen_ TIMESTAMPTZ) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT public.observed_json_keys(p_,ARRAY['externalCampaignId','businessDate','window','spendMinor',
      'attributedRevenueMinor','eligibleCount','measuredCount','measurementVersion',
      'attributionPolicyVersion','coverageBasisPoints','currency','reason'])
    AND public.observed_json_id(p_->'externalCampaignId')
    AND p_->>'externalCampaignId'=subject_ COLLATE "C"
    AND public.observed_closed_window(p_->'window',seen_)
    AND public.observed_campaign_date(p_->'businessDate',p_->'window')
    AND (p_->'spendMinor'='null'::jsonb OR public.observed_json_integer(p_->'spendMinor'))
    AND (p_->'attributedRevenueMinor'='null'::jsonb OR public.observed_json_integer(p_->'attributedRevenueMinor'))
    AND (p_->'eligibleCount'='null'::jsonb OR public.observed_json_integer(p_->'eligibleCount'))
    AND (p_->'measuredCount'='null'::jsonb OR public.observed_json_integer(p_->'measuredCount'))
    AND ('null'::jsonb IN (p_->'eligibleCount',p_->'measuredCount')
      OR public.observed_json_number(p_->'measuredCount')<=public.observed_json_number(p_->'eligibleCount'))
    AND public.observed_json_id(p_->'measurementVersion')
    AND public.observed_json_id(p_->'attributionPolicyVersion')
    AND public.observed_json_integer(p_->'coverageBasisPoints',0,10000)
    AND p_->>'currency'='CNY'
    AND public.observed_measurement_quality(p_->'reason',
      'null'::jsonb IN (p_->'spendMinor',p_->'attributedRevenueMinor',p_->'eligibleCount',p_->'measuredCount'),
      'ATTRIBUTION_MISSING',p_->'coverageBasisPoints'='10000'::jsonb)
$$;

CREATE FUNCTION public.observed_listing(p_ JSONB, subject_ TEXT, seen_ TIMESTAMPTZ) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT public.observed_json_keys(p_,ARRAY['externalSkuId','listedAt','effectiveAt','fromStatus','toStatus'])
    AND public.observed_payload_sku(p_,subject_)
    AND p_->>'fromStatus' IN ('UNLISTED','LISTED','DELISTED')
    AND p_->>'toStatus' IN ('LISTED','DELISTED')
    AND p_->>'fromStatus'<>p_->>'toStatus'
    AND listed_<=effective_ AND effective_<=seen_
    AND (p_->>'fromStatus'<>'UNLISTED' OR p_->>'toStatus'<>'LISTED' OR listed_=effective_)
  FROM (SELECT public.observed_json_time(p_->'listedAt') AS listed_,
    public.observed_json_time(p_->'effectiveAt') AS effective_) AS times
$$;

CREATE FUNCTION public.observed_price(p_ JSONB, subject_ TEXT, seen_ TIMESTAMPTZ) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT public.observed_json_keys(p_,ARRAY['externalSkuId','effectiveAt','priorPriceMinor',
      'priceMinor','priceVersion','currency'])
    AND public.observed_payload_sku(p_,subject_)
    AND public.observed_json_time(p_->'effectiveAt')<=seen_
    AND (p_->'priorPriceMinor'='null'::jsonb OR public.observed_json_integer(p_->'priorPriceMinor'))
    AND public.observed_json_integer(p_->'priceMinor')
    AND public.observed_json_id(p_->'priceVersion')
    AND p_->>'currency'='CNY'
$$;

CREATE FUNCTION public.observed_payload_location(p_ JSONB, subject_ TEXT) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT public.observed_payload_sku(p_,subject_) AND public.observed_json_id(p_->'externalLocationId')
$$;

CREATE FUNCTION public.observed_inventory_lot(p_ JSONB, subject_ TEXT, seen_ TIMESTAMPTZ) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT public.observed_json_keys(p_,ARRAY['externalSkuId','externalLocationId','externalLotId',
      'externalReceiptId','receivedAt','movementAt','reason','deltaQuantity','beforeQuantity','afterQuantity'])
    AND public.observed_payload_location(p_,subject_)
    AND public.observed_json_id(p_->'externalLotId')
    AND public.observed_json_id(p_->'externalReceiptId')
    AND public.observed_json_time(p_->'receivedAt')<=movement_ AND movement_<=seen_
    AND CASE p_->>'reason'
      WHEN 'RECEIPT' THEN delta_>0
      WHEN 'RETURN' THEN delta_>0
      WHEN 'TRANSFER_IN' THEN delta_>0
      WHEN 'SALE' THEN delta_<0
      WHEN 'WRITE_OFF' THEN delta_<0
      WHEN 'TRANSFER_OUT' THEN delta_<0
      ELSE FALSE END
    AND CASE WHEN public.observed_json_integer(p_->'beforeQuantity')
      AND public.observed_json_integer(p_->'deltaQuantity',-9007199254740991)
      AND public.observed_json_integer(p_->'afterQuantity')
      THEN public.observed_json_number(p_->'beforeQuantity')+delta_=public.observed_json_number(p_->'afterQuantity')
      ELSE FALSE END
  FROM (SELECT public.observed_json_time(p_->'movementAt') AS movement_,
    public.observed_json_number(p_->'deltaQuantity') AS delta_) AS movement
$$;

CREATE FUNCTION public.observed_json_hours(value_ JSONB) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT public.observed_json_number(value_) BETWEEN 0 AND 9007199254740991
$$;

CREATE FUNCTION public.observed_supply_quality(
  reason_ JSONB, missing_inventory_ BOOLEAN, missing_lead_time_ BOOLEAN
) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT CASE reason_
    WHEN '"INVENTORY_UNKNOWN"'::jsonb THEN missing_inventory_
    WHEN '"LEAD_TIME_MISSING"'::jsonb THEN missing_lead_time_
    WHEN 'null'::jsonb THEN NOT missing_inventory_ AND NOT missing_lead_time_
    ELSE FALSE END
$$;

CREATE FUNCTION public.observed_supplier_notice(p_ JSONB, subject_ TEXT, seen_ TIMESTAMPTZ) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT public.observed_json_keys(p_,ARRAY['externalSkuId','externalLocationId','noticeId','purchaseOrderId',
      'announcedAt','priorEta','newEta','inboundQuantity','promisedLeadHours','reason'])
    AND public.observed_payload_location(p_,subject_)
    AND public.observed_json_id(p_->'noticeId')
    AND public.observed_json_id(p_->'purchaseOrderId')
    AND public.observed_json_time(p_->'announcedAt')<=seen_
    AND (p_->'priorEta'='null'::jsonb OR public.observed_json_time(p_->'priorEta') IS NOT NULL)
    AND (p_->'newEta'='null'::jsonb OR public.observed_json_time(p_->'newEta') IS NOT NULL)
    AND (p_->'inboundQuantity'='null'::jsonb OR public.observed_json_integer(p_->'inboundQuantity'))
    AND (p_->'promisedLeadHours'='null'::jsonb OR public.observed_json_hours(p_->'promisedLeadHours'))
    AND public.observed_supply_quality(p_->'reason',p_->'inboundQuantity'='null'::jsonb,
      'null'::jsonb IN (p_->'newEta',p_->'promisedLeadHours'))
$$;

CREATE FUNCTION public.observed_inventory_position(p_ JSONB, subject_ TEXT, seen_ TIMESTAMPTZ) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT public.observed_json_keys(p_,ARRAY['externalSkuId','externalLocationId','asOf',
      'quarantine','inbound','safetyBufferHours','reason'])
    AND public.observed_payload_location(p_,subject_)
    AND public.observed_json_time(p_->'asOf')<=seen_
    AND (p_->'quarantine'='null'::jsonb OR public.observed_json_integer(p_->'quarantine'))
    AND (p_->'inbound'='null'::jsonb OR public.observed_json_integer(p_->'inbound'))
    AND (p_->'safetyBufferHours'='null'::jsonb OR public.observed_json_hours(p_->'safetyBufferHours'))
    AND public.observed_supply_quality(p_->'reason',
      'null'::jsonb IN (p_->'quarantine',p_->'inbound'),p_->'safetyBufferHours'='null'::jsonb)
$$;

-- The envelope trigger separately binds the connection subject to its scope.
CREATE FUNCTION public.observed_sync_transition(p_ JSONB, seen_ TIMESTAMPTZ) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT public.observed_json_keys(p_,ARRAY['jobId','fence','stream','status','errorCode',
      'successfulThrough','watermark','businessObservedAt','transitionSequence'])
    AND public.observed_json_id(p_->'jobId')
    AND public.observed_json_integer(p_->'fence')
    AND p_->>'stream' IN ('PRODUCTS','ORDERS','REFUNDS','INVENTORY','MARKETING')
    AND CASE p_->>'status'
      WHEN 'FAILED' THEN p_->>'errorCode' IN ('TIMEOUT','RATE_LIMIT','AUTH_EXPIRED','PERMISSION_DENIED',
        'TEMPORARY','CONFLICT','INVALID_INPUT','INVALID_RESPONSE','UNSUPPORTED','NOT_FOUND','ABORTED')
      WHEN 'SUCCEEDED' THEN p_->'errorCode'='null'::jsonb
      ELSE FALSE END
    AND (p_->'successfulThrough'='null'::jsonb OR public.observed_json_time(p_->'successfulThrough')<=seen_)
    AND (p_->'watermark'='null'::jsonb OR public.observed_json_time(p_->'watermark')<=seen_)
    AND public.observed_json_time(p_->'businessObservedAt')=seen_
    AND public.observed_json_integer(p_->'transitionSequence',1)
$$;

CREATE FUNCTION public.observed_payload_valid(
  domain_ TEXT, p_ JSONB, subject_ TEXT, seen_ TIMESTAMPTZ
) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT CASE domain_
    WHEN 'FROZEN_COST' THEN public.observed_frozen_cost(p_,subject_,seen_)
    WHEN 'REFUND_ALLOCATION' THEN public.observed_refund_allocation(p_,subject_,seen_)
    WHEN 'RETURN_RECEIPT' THEN public.observed_return_receipt(p_,subject_,seen_)
    WHEN 'FEE' THEN public.observed_fee(p_,seen_)
    WHEN 'TRAFFIC' THEN public.observed_traffic(p_,seen_)
    WHEN 'CAMPAIGN_MEASUREMENT' THEN public.observed_campaign(p_,subject_,seen_)
    WHEN 'LISTING' THEN public.observed_listing(p_,subject_,seen_)
    WHEN 'PRICE' THEN public.observed_price(p_,subject_,seen_)
    WHEN 'INVENTORY_LOT' THEN public.observed_inventory_lot(p_,subject_,seen_)
    WHEN 'SUPPLIER_NOTICE' THEN public.observed_supplier_notice(p_,subject_,seen_)
    WHEN 'INVENTORY_POSITION' THEN public.observed_inventory_position(p_,subject_,seen_)
    WHEN 'SYNC_TRANSITION' THEN public.observed_sync_transition(p_,seen_)
    ELSE FALSE
  END
$$;

REVOKE ALL ON FUNCTION public.observed_json_keys(JSONB,TEXT[]),public.observed_json_id(JSONB),
  public.observed_json_number(JSONB),public.observed_json_integer(JSONB,BIGINT,BIGINT),
  public.observed_json_time(JSONB),public.observed_payload_sku(JSONB,TEXT),public.observed_finance_line(JSONB,TEXT),
  public.observed_frozen_cost(JSONB,TEXT,TIMESTAMPTZ),public.observed_refund_allocation(JSONB,TEXT,TIMESTAMPTZ),
  public.observed_return_receipt(JSONB,TEXT,TIMESTAMPTZ),
  public.observed_closed_window(JSONB,TIMESTAMPTZ),public.observed_measurement_quality(JSONB,BOOLEAN,TEXT,BOOLEAN),
  public.observed_fee(JSONB,TIMESTAMPTZ),public.observed_traffic(JSONB,TIMESTAMPTZ),
  public.observed_campaign_date(JSONB,JSONB),public.observed_campaign(JSONB,TEXT,TIMESTAMPTZ),
  public.observed_listing(JSONB,TEXT,TIMESTAMPTZ),public.observed_price(JSONB,TEXT,TIMESTAMPTZ),
  public.observed_payload_location(JSONB,TEXT),public.observed_inventory_lot(JSONB,TEXT,TIMESTAMPTZ),
  public.observed_json_hours(JSONB),public.observed_supply_quality(JSONB,BOOLEAN,BOOLEAN),
  public.observed_supplier_notice(JSONB,TEXT,TIMESTAMPTZ),public.observed_inventory_position(JSONB,TEXT,TIMESTAMPTZ),
  public.observed_sync_transition(JSONB,TIMESTAMPTZ),
  public.observed_payload_valid(TEXT,JSONB,TEXT,TIMESTAMPTZ) FROM PUBLIC;

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
  CONSTRAINT observed_scopes_connection_generation_key UNIQUE ("connectionId",generation),
  CONSTRAINT observed_scopes_organization_key UNIQUE ("scopeId","organizationId")
);

CREATE FUNCTION public.observed_capability_role(capability_ TEXT) RETURNS NAME
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT CASE capability_
    WHEN 'PUBLISH' THEN 'shopmate_observed_publisher'
    WHEN 'CONSUME' THEN 'shopmate_observed_consumer'
    WHEN 'READ' THEN 'shopmate_observed_reader'
    WHEN 'PROVISION_DEFINITION' THEN 'shopmate_observed_definition_provisioner'
  END::name
$$;

CREATE FUNCTION public.observed_login_safe(login_ TEXT, capability_ TEXT) RETURNS BOOLEAN
LANGUAGE SQL STABLE STRICT SET search_path=pg_catalog AS $$
  SELECT EXISTS (
    SELECT FROM pg_roles AS login JOIN pg_roles AS cap ON cap.rolname=public.observed_capability_role(capability_)
    WHERE login.rolname::text=login_ COLLATE "C" AND login.rolcanlogin AND NOT cap.rolcanlogin
      AND pg_has_role(login.oid,cap.oid,'USAGE')
      AND NOT EXISTS (
        SELECT FROM pg_roles AS r WHERE pg_has_role(login.oid,r.oid,'MEMBER') AND (
          r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
          OR r.rolname IN ('pg_read_all_data','pg_write_all_data','pg_read_server_files','pg_write_server_files',
            'pg_execute_server_program','shopmate_sync_worker','shopmate_observed_guard')
          OR EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relowner=r.oid
            AND n.nspname IN ('public','demo','commerce','sync_host','mock_platform'))
          OR EXISTS (SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proowner=r.oid
            AND n.nspname IN ('public','demo','commerce','sync_host','mock_platform'))
          OR EXISTS (SELECT FROM pg_namespace n WHERE (n.nspowner=r.oid OR has_schema_privilege(r.oid,n.oid,'CREATE'))
            AND n.nspname IN ('public','demo','commerce','sync_host','mock_platform'))
          OR EXISTS (SELECT FROM pg_database d WHERE d.datdba=r.oid AND d.datname=current_database())
        )
      )
  )
$$;

CREATE FUNCTION public.observed_grant_domains(domains_ TEXT[]) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT array_ndims(domains_)=1 AND array_lower(domains_,1)=1 AND cardinality(domains_) BETWEEN 1 AND 12
    AND cardinality(domains_)=(SELECT count(DISTINCT domain_ COLLATE "C") FROM unnest(domains_) AS domain_)
    AND domains_ COLLATE "C" <@ ARRAY['FROZEN_COST','REFUND_ALLOCATION','RETURN_RECEIPT','FEE','TRAFFIC',
      'CAMPAIGN_MEASUREMENT','LISTING','PRICE','INVENTORY_LOT','SUPPLIER_NOTICE','INVENTORY_POSITION','SYNC_TRANSITION']
$$;

CREATE TABLE public.observed_principal_grants (
  "grantId" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "scopeId" UUID NOT NULL,
  "organizationId" TEXT COLLATE "C" NOT NULL,
  "databaseRole" TEXT COLLATE "C" NOT NULL,
  "principalUserId" TEXT COLLATE "C" NOT NULL,
  capability TEXT COLLATE "C" NOT NULL,
  "allowedDomains" TEXT[] COLLATE "C" NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT observed_grants_scope_fkey FOREIGN KEY ("scopeId","organizationId")
    REFERENCES public.observed_scopes("scopeId","organizationId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT observed_grants_principal_fkey FOREIGN KEY ("organizationId","principalUserId")
    REFERENCES public."OrganizationMember"("organizationId","userId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT observed_grants_identity_key UNIQUE ("scopeId","databaseRole","capability"),
  CONSTRAINT observed_grants_domains_valid CHECK (public.observed_grant_domains("allowedDomains") IS TRUE),
  CONSTRAINT observed_grants_expiry_finite CHECK (isfinite("expiresAt"))
);

CREATE FUNCTION public.observed_check_grant_login() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF public.observed_login_safe(NEW."databaseRole",NEW.capability) IS NOT TRUE THEN
    RAISE EXCEPTION 'Invalid observed grant login or capability'
      USING ERRCODE='23514', CONSTRAINT='observed_grants_login_valid';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER observed_grants_login_valid BEFORE INSERT OR UPDATE OF "databaseRole",capability
  ON public.observed_principal_grants FOR EACH ROW EXECUTE FUNCTION public.observed_check_grant_login();

CREATE FUNCTION public.observed_lock_binding(scope_ UUID) RETURNS BOOLEAN
LANGUAGE SQL VOLATILE STRICT SET search_path=pg_catalog AS $$
  SELECT EXISTS (
    SELECT FROM public.observed_scopes b JOIN public."PlatformConnection" c
      ON (c.id,c."organizationId",c."workspaceId",c."storeId",c."externalStoreId",c.generation)
        =(b."connectionId",b."organizationId",b."workspaceId",b."storeId",b."externalStoreId",b.generation)
    JOIN public."Store" s ON (s.id,s."organizationId",s."workspaceId")=(c."storeId",c."organizationId",c."workspaceId")
    JOIN public."Organization" o ON (o.id,o."legacyMerchantId")=(s."organizationId",s."merchantId")
    JOIN public."Workspace" w ON (w.id,w."organizationId")=(s."workspaceId",o.id)
    JOIN public."Merchant" m ON m.id=s."merchantId"
    WHERE b."scopeId"=scope_ AND c.status='ACTIVE' AND o.status='ACTIVE'
      AND w.status='ACTIVE' AND m.status='ACTIVE'
    FOR SHARE OF c
  )
$$;

CREATE FUNCTION public.observed_lock_member(scope_ UUID, user_ TEXT, writer_ BOOLEAN) RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE STRICT SET search_path=pg_catalog AS $$
DECLARE
  role_ public."TenantRole";
BEGIN
  SELECT m.role INTO role_ FROM public.observed_scopes b JOIN public."OrganizationMember" m
    ON m."organizationId"=b."organizationId"
    WHERE b."scopeId"=scope_ AND m."userId"=user_ AND m.status='ACTIVE'
      AND (NOT writer_ OR m.role IN ('OWNER','ADMIN','OPERATOR'))
    FOR SHARE OF m;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  IF role_ IN ('OWNER','ADMIN') THEN RETURN TRUE; END IF;
  RETURN EXISTS (
    SELECT FROM public.observed_scopes b JOIN public."WorkspaceMember" m
      ON (m."organizationId",m."workspaceId")=(b."organizationId",b."workspaceId")
    WHERE b."scopeId"=scope_ AND m."userId"=user_ AND m.status='ACTIVE'
    FOR SHARE OF m
  );
END
$$;

-- The caller holds this transaction open through its own final operation. Publish and consume
-- require the request's exact grant. Actor-based checks can rely on the unique scoped grant.
CREATE FUNCTION public.observed_authorize(
  scope_ UUID, user_ TEXT, capability_ TEXT, domain_ TEXT, expected_grant_ TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path=pg_catalog AS $$
DECLARE
  grant_ UUID;
  expiry_ TIMESTAMPTZ;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed'
    OR current_setting('role') NOT IN ('none',SESSION_USER)
    OR (capability_ IN ('PUBLISH','CONSUME') AND expected_grant_ IS NULL)
    OR public.observed_login_safe(SESSION_USER::text,capability_) IS NOT TRUE THEN
    RAISE EXCEPTION 'Observed scope access denied' USING ERRCODE='42501';
  END IF;
  -- Do not lock caller-selected resources until a scoped grant is visible.
  SELECT g."grantId" INTO grant_ FROM public.observed_principal_grants g
    WHERE g."scopeId"=scope_ AND g."databaseRole"=SESSION_USER AND g."principalUserId"=user_ COLLATE "C"
      AND g.capability=capability_ COLLATE "C" AND domain_ COLLATE "C"=ANY(g."allowedDomains")
      AND (expected_grant_ IS NULL OR g."grantId"::text=expected_grant_ COLLATE "C")
      AND g.active AND g."expiresAt">clock_timestamp();
  IF grant_ IS NULL OR public.observed_lock_binding(scope_) IS NOT TRUE THEN
    RAISE EXCEPTION 'Observed scope access denied' USING ERRCODE='42501';
  END IF;
  SELECT g."expiresAt" INTO expiry_ FROM public.observed_principal_grants g
    WHERE g."grantId"=grant_ AND g."scopeId"=scope_ AND g."databaseRole"=SESSION_USER
      AND g."principalUserId"=user_ COLLATE "C" AND g.capability=capability_ COLLATE "C"
      AND domain_ COLLATE "C"=ANY(g."allowedDomains") AND g.active
    FOR SHARE OF g;
  IF expiry_ IS NULL OR public.observed_lock_member(scope_,user_,capability_<>'READ') IS NOT TRUE THEN
    RAISE EXCEPTION 'Observed scope access denied' USING ERRCODE='42501';
  END IF;
  IF public.observed_lock_binding(scope_) IS NOT TRUE
    OR public.observed_login_safe(SESSION_USER::text,capability_) IS NOT TRUE OR expiry_<=clock_timestamp() THEN
    RAISE EXCEPTION 'Observed scope access denied' USING ERRCODE='42501';
  END IF;
END
$$;

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
    AND public.observed_payload_valid(domain,payload,"subjectId","observedAt")
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
-- The original writer's definer context has ended when this check runs at commit.
CREATE FUNCTION public.observed_check_members() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.observed_page_receipts AS r
    CROSS JOIN LATERAL (
      SELECT count(*) AS members, count(DISTINCT "factId") AS identities,
        bool_and((ordinal=position-1 AND (previous IS NULL OR previous<sequence)
          AND "observedAt"<=r.through
          AND (r.domain NOT IN ('FEE','TRAFFIC','CAMPAIGN_MEASUREMENT') OR (
            public.observed_json_time(payload->'window'->'periodStart')>=r."periodStart"
            AND public.observed_json_time(payload->'window'->'periodEnd')<=r."periodEnd"
            AND payload->'window'->>'timezone'=r.timezone AND payload->'window'->>'currency'=r.currency
          ))) IS TRUE) AS valid
      FROM (
        SELECT m.ordinal, f."factId", f.sequence, f."observedAt", f.payload,
          row_number() OVER member_order AS position, lag(f.sequence) OVER member_order AS previous
        FROM public.observed_receipt_members AS m
        JOIN public.observed_facts AS f ON f."factKey"=m."factKey"
        WHERE m."receiptKey"=r."receiptKey"
        WINDOW member_order AS (ORDER BY m.ordinal)
      ) AS page_members
    ) AS page
    WHERE r."receiptKey"=NEW."receiptKey" AND page.members=r."recordCount"
      AND page.members=page.identities AND coalesce(page.valid,TRUE)
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
  public.observed_receipt_members,public.observed_principal_grants
  FROM PUBLIC,shopmate_observed_publisher,shopmate_observed_consumer,shopmate_observed_reader,
    shopmate_observed_definition_provisioner;
ALTER TABLE public.observed_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.observed_scopes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.observed_page_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.observed_page_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.observed_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.observed_facts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.observed_receipt_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.observed_receipt_members FORCE ROW LEVEL SECURITY;
ALTER TABLE public.observed_principal_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.observed_principal_grants FORCE ROW LEVEL SECURITY;
REVOKE ALL ON FUNCTION public.observed_opaque_text(TEXT,INTEGER),public.observed_time(TIMESTAMPTZ),
  public.observed_subject_valid(TEXT,TEXT,TEXT),public.observed_stamp_receipt(),
  public.observed_fact_envelope(public.observed_facts,public.observed_scopes),public.observed_check_fact_bytes(),
  public.observed_check_members(),public.observed_reject_history_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.observed_capability_role(TEXT),public.observed_login_safe(TEXT,TEXT),
  public.observed_grant_domains(TEXT[]),public.observed_check_grant_login() FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO shopmate_observed_publisher,shopmate_observed_consumer,
  shopmate_observed_reader,shopmate_observed_definition_provisioner,shopmate_observed_guard;
GRANT SELECT ON public.observed_scopes,public.observed_principal_grants TO shopmate_observed_guard;
GRANT SELECT ("receiptKey",domain,"periodStart","periodEnd",timezone,currency,through,"recordCount")
  ON public.observed_page_receipts TO shopmate_observed_guard;
GRANT SELECT ("factKey","factId",sequence,"observedAt",payload) ON public.observed_facts TO shopmate_observed_guard;
GRANT SELECT ("receiptKey",ordinal,"factKey") ON public.observed_receipt_members TO shopmate_observed_guard;
GRANT SELECT (id,"organizationId","workspaceId","storeId","externalStoreId",status,generation)
  ON public."PlatformConnection" TO shopmate_observed_guard;
GRANT SELECT (id,"organizationId","workspaceId","merchantId") ON public."Store" TO shopmate_observed_guard;
GRANT SELECT (id,status,"legacyMerchantId") ON public."Organization" TO shopmate_observed_guard;
GRANT SELECT (id,status,"organizationId") ON public."Workspace" TO shopmate_observed_guard;
GRANT SELECT (id,status) ON public."Merchant" TO shopmate_observed_guard;
GRANT SELECT ("organizationId","userId",status,role) ON public."OrganizationMember" TO shopmate_observed_guard;
GRANT SELECT ("organizationId","workspaceId","userId",status) ON public."WorkspaceMember" TO shopmate_observed_guard;

CREATE POLICY observed_guard_read ON public.observed_scopes FOR SELECT TO shopmate_observed_guard USING (true);
CREATE POLICY observed_guard_read ON public.observed_principal_grants FOR SELECT TO shopmate_observed_guard USING (true);
CREATE POLICY observed_guard_read ON public.observed_page_receipts FOR SELECT TO shopmate_observed_guard USING (true);
CREATE POLICY observed_guard_read ON public.observed_facts FOR SELECT TO shopmate_observed_guard USING (true);
CREATE POLICY observed_guard_read ON public.observed_receipt_members FOR SELECT TO shopmate_observed_guard USING (true);
CREATE POLICY observed_guard_read ON public."PlatformConnection" FOR SELECT TO shopmate_observed_guard USING (true);
CREATE POLICY observed_guard_read ON public."Organization" FOR SELECT TO shopmate_observed_guard USING (true);
CREATE POLICY observed_guard_read ON public."Workspace" FOR SELECT TO shopmate_observed_guard USING (true);
CREATE POLICY observed_guard_read ON public."OrganizationMember" FOR SELECT TO shopmate_observed_guard USING (true);
CREATE POLICY observed_guard_read ON public."WorkspaceMember" FOR SELECT TO shopmate_observed_guard USING (true);

-- PostgreSQL requires an UPDATE column privilege for row locks. Policies prohibit writes.
GRANT UPDATE (active) ON public.observed_principal_grants TO shopmate_observed_guard;
GRANT UPDATE (status) ON public."PlatformConnection",public."OrganizationMember",public."WorkspaceMember"
  TO shopmate_observed_guard;
CREATE POLICY observed_guard_lock ON public.observed_principal_grants FOR UPDATE TO shopmate_observed_guard
  USING (true) WITH CHECK (false);
CREATE POLICY observed_guard_lock ON public."PlatformConnection" FOR UPDATE TO shopmate_observed_guard
  USING (true) WITH CHECK (false);
CREATE POLICY observed_guard_no_update ON public."PlatformConnection" AS RESTRICTIVE FOR UPDATE TO shopmate_observed_guard
  USING (true) WITH CHECK (false);
CREATE POLICY observed_guard_lock ON public."OrganizationMember" FOR UPDATE TO shopmate_observed_guard
  USING (true) WITH CHECK (false);
CREATE POLICY observed_guard_lock ON public."WorkspaceMember" FOR UPDATE TO shopmate_observed_guard
  USING (true) WITH CHECK (false);

REVOKE ALL ON FUNCTION public.observed_lock_binding(UUID),public.observed_lock_member(UUID,TEXT,BOOLEAN),
  public.observed_authorize(UUID,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.observed_capability_role(TEXT),public.observed_login_safe(TEXT,TEXT),
  public.observed_lock_binding(UUID),public.observed_lock_member(UUID,TEXT,BOOLEAN),
  public.observed_json_time(JSONB) TO shopmate_observed_guard;
GRANT EXECUTE ON FUNCTION public.observed_authorize(UUID,TEXT,TEXT,TEXT,TEXT)
  TO shopmate_observed_publisher,shopmate_observed_consumer,shopmate_observed_reader,
    shopmate_observed_definition_provisioner;
ALTER FUNCTION public.observed_authorize(UUID,TEXT,TEXT,TEXT,TEXT) OWNER TO shopmate_observed_guard;
ALTER FUNCTION public.observed_check_members() OWNER TO shopmate_observed_guard;

COMMIT;

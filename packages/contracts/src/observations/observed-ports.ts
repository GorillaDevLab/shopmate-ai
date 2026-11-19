import type {
  AppendObservedPageV1,
  ObservedCaptureRequestV1,
  ObservedCaptureV1,
  ObservedDemandPageV1,
  ObservedDomain,
  ObservedError,
  ObservedFactV1,
  ObservedFinanceProducerRequestV1,
  ObservedProducerRunV1,
  ObservedPublicationReadV1,
  ObservedPublicationRequestV1,
  ObservedPublicationV1,
  ObservedPublishedPageV1,
  ObservedReadRequestV1,
  ObservedReceiptV1,
  ObservedSelectionRequestV1,
  ScopedMetricInputV1,
} from "./observed-fact.schema.js";

export type ObservedErrorCode = ObservedError["code"];

/**
 * INVALID_INPUT covers malformed data and OVERFLOW covers size or checked arithmetic bounds.
 * CONFLICT covers a stale fence, gap, fork or divergent replay. VERSION_MISMATCH covers the
 * wrong model or revision namespace. Use opaque NOT_FOUND or FORBIDDEN for inaccessible resources
 * as appropriate to the endpoint and SOURCE_UNAVAILABLE for missing source or required configuration.
 */
export type ObservedResult<T> = Readonly<
  { ok: true; value: T } | { ok: false; error: ObservedError }
>;

/**
 * Adapters validate strict DTOs and enforce a 16 MiB UTF-8 limit before JSON decoding and on
 * emitted requests and results. Return OVERFLOW without truncation. Services inject their own
 * DB connection and principal. P03-020 owns immutable storage and DB roles. Storage authorization
 * verifies a live grant for the principal, full binding, active generation and permitted domains.
 * In READ COMMITTED, lock generation, grant and membership in that order where applicable.
 * Revocation and reset take conflicting locks. Recheck authority, expiry, deadlines and any lease
 * after waiting for locks and immediately before the final append, seal, capture or authorized read.
 * Sample fresh DB SECURITY_UTC with clock_timestamp() for those checks. Authoritative business
 * time determines source visibility.
 */
type ObservedCall<I, O> = (request: I) => Promise<ObservedResult<O>>;

export interface ObservedPublisherPort {
  /**
   * P03-035 certifies the authoritative source through the pinned business cutoff under a live
   * scoped grant. Verify the active generation, model and config hash server-side and derive
   * contiguous publication/page links, exact original bytes and content hashes, and terminal
   * coverage. Exact ordinal retries return the original certificate. Divergent or gapped seals conflict.
   */
  readonly publishObserved: ObservedCall<ObservedPublicationRequestV1, ObservedPublicationV1>;
  /** P03-035 verifies current scoped authority and returns the exact bytes of the sealed page. */
  readonly readPublishedPage: ObservedCall<ObservedPublicationReadV1, ObservedPublishedPageV1>;
}

export interface ObservedConsumerPort {
  /**
   * P03-021 resolves the authoritative certificate and verifies requested bytes and prior links,
   * full binding, active generation, domain, live grant and lease/fence at final append. Atomically
   * commit facts, membership receipt and cursor/terminal coverage. Exact page retries under current
   * authority return the original receipt. Divergence conflicts. A repeated member keeps its
   * original insertion receipt and bytes. Corrections append superseding versions.
   * P03-026 records its separate CONNECTION/SYNC_TRANSITION in the pipeline job transaction,
   * including initial failures before a normal bundle exists.
   */
  readonly appendObservedPage: ObservedCall<AppendObservedPageV1, ObservedReceiptV1>;
}

export interface ObservedReaderPort {
  /**
   * P03-022 authorizes the actor's live membership, connection and scoped grant and captures at the
   * authoritative current business cutoff. Resolve and verify original base/observed bytes and the
   * complete authoritative source set. Seal the full digest, including comparison, current page
   * membership and immutable insertion-receipt edges. Recheck under the authority locks at final capture.
   */
  readonly captureObserved: ObservedCall<ObservedCaptureRequestV1, ObservedCaptureV1>;
  /**
   * P03-022 reauthorizes live membership, full binding, current generation and applicable grant.
   * Replay only the sealed identity and digest with its original bytes and receipts. Preserve the
   * original insertion provenance and the distinct certification of later page memberships.
   */
  readonly readObserved: ObservedCall<ObservedReadRequestV1, ObservedCaptureV1>;
}

export interface AuthorizedObservedSelectionPort {
  /**
   * P03-027 reauthorizes current membership, full binding, generation and grant before selection.
   * Verify the full sealed graph digest and original source bytes and validate the returned scoped proof.
   * For STORE ROAS, resolve every original base MARKETING page and compare the complete eligible
   * campaign-day enumeration with certified components and projected rows, preserving original values,
   * windows and provenance. Preserve the primary INVENTORY_POSITION and matching visible
   * SUPPLIER_NOTICE provenance for supported lead time and ETA. Reject unsupported or ambiguous mappings.
   */
  readonly selectObserved: ObservedCall<ObservedSelectionRequestV1, ScopedMetricInputV1>;
}

export type FactPage<D extends ObservedDomain> = Readonly<{
  records: readonly Extract<ObservedFactV1, { readonly domain: D }>[];
  nextCursor: string | null;
}>;
type FinanceDomain = "FROZEN_COST" | "REFUND_ALLOCATION" | "RETURN_RECEIPT" | "FEE";
type SupplyDomain =
  | "LISTING"
  | "PRICE"
  | "INVENTORY_LOT"
  | "SUPPLIER_NOTICE"
  | "INVENTORY_POSITION";

export interface ObservedFinanceProducerPort {
  /**
   * Reduce an actual scoped event using the pinned immutable acquisition and fee schedules.
   * Validate the output's full scope, generation, run cutoff and page limit. Cursors are opaque.
   */
  readonly reduceFinance: ObservedCall<ObservedFinanceProducerRequestV1, FactPage<FinanceDomain>>;
}

export interface ObservedSupplyProducerPort {
  /** Produce visible supply observations and check full output scope, generation, cutoff and run limit. */
  readonly produceSupply: ObservedCall<ObservedProducerRunV1, FactPage<SupplyDomain>>;
}

export interface ObservedDemandProducerPort {
  /**
   * Advance visitors through cart, checkout and payment using prices and quantities announced by the
   * business cutoff and the composed supply and finance ports. Validate output scope, generation,
   * cutoff and run limit, including each order's external store and order, payment and source times.
   * The finance port also accepts independently delivered settlement and return acceptance events.
   */
  readonly produceDemand: ObservedCall<ObservedProducerRunV1, ObservedDemandPageV1>;
}

/** P03-036 wires the causal ports after the P03-031/032 v3 admission and driver. */
export interface ObservedCausalDependencies {
  readonly supply: ObservedSupplyProducerPort;
  readonly finance: ObservedFinanceProducerPort;
}

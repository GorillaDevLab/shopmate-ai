import { EventDetectorRegistry } from "./event-evaluation.service.js";
import { DEFAULT_EVENT_RULE_POLICY } from "./event-rule-policy.js";
import { StockoutDetector } from "./detectors/stockout.detector.js";
import { createInventoryStagnationDetector } from "./detectors/inventory-stagnation.detector.js";
import { RefundSpikeDetector } from "./detectors/refund-spike.detector.js";
import { CancelledOrderSpikeDetector } from "./detectors/cancelled-order-spike.detector.js";
import { ProfitMarginDropDetector } from "./detectors/profit-margin-drop.detector.js";
import { UnusualDiscountDetector } from "./detectors/unusual-discount.detector.js";
import { MarketingDetector } from "./detectors/marketing.detector.js";
import { ConversionDropDetector } from "./detectors/conversion-drop.detector.js";
import { ProductBreakoutDetector } from "./detectors/product-breakout.detector.js";
import { SyncQualityDetector } from "./detectors/sync-quality.detector.js";
import { RevenueDropDetector } from "./detectors/revenue-drop.detector.js";

/** Registration does not assert that the persisted source exposes every family's facts. */
export function createRuntimeDetectorRegistry(): EventDetectorRegistry {
  const policy = DEFAULT_EVENT_RULE_POLICY;
  const detectors = {
    STOCKOUT_RISK: new StockoutDetector(),
    INVENTORY_STAGNATION: createInventoryStagnationDetector(),
    REFUND_SPIKE: new RefundSpikeDetector(),
    CANCELLED_ORDER_SPIKE: new CancelledOrderSpikeDetector(),
    PROFIT_MARGIN_DROP: new ProfitMarginDropDetector(),
    UNUSUAL_DISCOUNT: new UnusualDiscountDetector(),
    ROAS_DROP: new MarketingDetector(),
    AD_SPEND_SPIKE: new MarketingDetector(),
    CONVERSION_DROP: new ConversionDropDetector(),
    PRODUCT_BREAKOUT: new ProductBreakoutDetector(),
    SYNC_FAILURE: new SyncQualityDetector(),
    REVENUE_DROP: new RevenueDropDetector(),
  };
  return new EventDetectorRegistry(
    policy,
    policy.rules.map((rule) => ({
      eventType: rule.eventType,
      rulePolicyVersion: policy.version,
      detector: detectors[rule.eventType],
    })),
  );
}

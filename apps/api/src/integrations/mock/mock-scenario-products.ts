import type { MockConfig } from "./mock-config.js";
import { generateCatalog, sourceAt, type CatalogEntry } from "./mock-catalog.js";
import { plannedSku } from "./mock-scenario-candidates.js";
import type { SourceGroupSnapshot } from "./mock-source-group-types.js";
export function scenarioCatalog(config: MockConfig, at: number): readonly CatalogEntry[] {
  const plan = config.scenarioPlan;
  return generateCatalog(config).map((entry, index) => {
    const launch = plan?.mutations.find(
      (m) => m.launchRampDays > 0 && Math.floor(m.skuIndex / config.variantsPerProduct) === index,
    );
    const launchAt = launch
      ? new Date(Date.parse(config.historyStart) + plan!.startDay * 86400000).toISOString()
      : entry.launchAt;
    const draft = launch && at < Date.parse(launchAt);
    return {
      ...entry,
      launchAt,
      product: {
        ...entry.product,
        status: draft ? "DRAFT" : entry.product.status,
        skus: entry.product.skus.map((sku) => ({
          ...plannedSku(config, sku, at),
          status: draft ? "INACTIVE" : sku.status,
        })),
      },
    };
  });
}
/** Publish both edges so current catalog reflects price reversions without changing earlier orders. */
export function scenarioProducts(config: MockConfig, at: string): SourceGroupSnapshot[] {
  const plan = config.scenarioPlan;
  if (!plan) return [];
  const day = (Date.parse(at) - Date.parse(config.historyStart)) / 86400000;
  if (day !== plan.startDay && day !== plan.endDay) return [];
  return scenarioCatalog(config, Date.parse(at))
    .filter((_entry, index) =>
      plan.mutations.some(
        (m) =>
          Math.floor(m.skuIndex / config.variantsPerProduct) === index &&
          (m.priceBps !== 10000 || (m.launchRampDays > 0 && day === plan.startDay)),
      ),
    )
    .map((entry) => ({
      kind: "PRODUCT",
      occurredAt: at,
      ordinal: "0",
      after: {
        ...entry.product,
        source: {
          ...sourceAt(at, entry.product.source.quality.state === "PARTIAL"),
          version: null,
        },
      },
    }));
}

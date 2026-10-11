import type { ConnectorSku } from "@shopmate/contracts";
import type { MockConfig } from "./mock-config.js";
import type { OrderCandidate } from "./mock-history.js";
import { scenarioAt } from "./mock-scenario-plans.js";
import { seededInteger } from "./mock-random.js";
export function plannedSku(config: MockConfig, sku: ConnectorSku, at: number): ConnectorSku {
  const index =
    Number(sku.externalProductId.split(":").at(-1)) * config.variantsPerProduct +
    Number(sku.externalSkuId.split(":").at(-1));
  const mutation = scenarioAt(config, at)?.mutations.find((m) => m.skuIndex === index);
  if (!mutation || mutation.priceBps === 10000) return sku;
  return { ...sku, salePriceMinor: Math.floor((sku.salePriceMinor! * mutation.priceBps) / 10000) };
}
export function plannedCandidate(
  config: MockConfig,
  candidate: OrderCandidate,
  skuIndex: number,
): OrderCandidate | null {
  const mutation = scenarioAt(config, candidate.at)?.mutations.find((m) => m.skuIndex === skuIndex);
  if (!mutation) return candidate;
  const random = (key: string) =>
    seededInteger(config.seed, ["scenario", candidate.id, key], 10000);
  if (random("demand") >= mutation.retainDemandBps) return null;
  return {
    ...candidate,
    sku: plannedSku(config, candidate.sku, candidate.at),
    discountBps: mutation.discountBps === 500 ? candidate.discountBps : mutation.discountBps,
    refund:
      mutation.refundBps === config.refundBps
        ? candidate.refund
        : random("refund") < mutation.refundBps,
    cancel: mutation.cancelBps === 1200 ? candidate.cancel : random("cancel") < mutation.cancelBps,
  };
}

export function launchedCandidate(
  config: MockConfig,
  candidate: OrderCandidate,
  skus: readonly ConnectorSku[],
): OrderCandidate | null {
  const plan = config.scenarioPlan,
    launch = plan?.mutations.find((m) => m.launchRampDays > 0);
  if (!plan || !launch) return candidate;
  const day = (candidate.at - Date.parse(config.historyStart)) / 86400000;
  const target = skus[launch.skuIndex]!;
  if (day < plan.startDay && candidate.sku.externalProductId === target.externalProductId)
    return null;
  if (day < plan.startDay || day >= plan.endDay || candidate.sku !== skus[0]) return candidate;
  const progress = Math.min(1, (day - plan.startDay + 1) / launch.launchRampDays);
  const accepted = seededInteger(config.seed, ["launch", candidate.id], 10000) < progress * 10000;
  return accepted ? { ...candidate, sku: target } : candidate;
}

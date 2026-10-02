import type { MockConfig } from "./mock-config.js";

/** Coarse daily traffic model, deliberately bounded before order/event allocation. */
export function campaignPlan(config: MockConfig, day: number) {
  const progress = day / Math.max(1, config.days - 1);
  const problematic = config.profile === "problematic";
  const spendMinor = Math.floor(config.adSpendMinor * (problematic ? 1 + progress * 2 : 1));
  const clicks = Math.floor(spendMinor / 80);
  const conversionBps = problematic ? 200 - Math.floor(progress * 100) : 500;
  return { spendMinor, clicks, potentialOrders: Math.floor((clicks * conversionBps) / 10_000) };
}

import {
  MockConfigSchema,
  createSourceGroupGenerator,
  generateCatalog,
  dailyDemand,
  DAY_MS,
} from "@shopmate/api/mock-generator";
import type { HydrationEntityKey } from "@shopmate/database/mock-platform";
import type { GenerationTools } from "./build-types.js";

type Config = ReturnType<typeof MockConfigSchema.parse>;
function orderKeys(config: Config, before: number): HydrationEntityKey[] {
  const start = Date.parse(config.historyStart);
  const firstDay = Math.max(0, Math.floor((before - 5 * DAY_MS - start) / DAY_MS));
  const lastDay = Math.min(config.days - 1, Math.floor((before - start) / DAY_MS));
  const keys: HydrationEntityKey[] = [];
  // Sparse delayed returns may have no event in the first resumed window. Hydrate
  // the whole bounded active order tail rather than only that window's candidates.
  for (let day = firstDay; day <= lastDay; day++)
    for (let index = 0; index < dailyDemand(config, day); index++)
      keys.push(["ORDER", `${config.binding.externalStoreId}:order:${day}:${index}`]);
  return keys;
}
function marketingKeys(config: Config, before: number): HydrationEntityKey[] {
  const keys: HydrationEntityKey[] = [];
  const start = Date.parse(config.historyStart);
  for (let day = 0; day < config.days && start + day * DAY_MS <= before; day++) {
    if (dailyDemand(config, day) === 0) continue;
    const date = new Date(start + day * DAY_MS + 8 * 3_600_000).toISOString().slice(0, 10);
    keys.push(["MARKETING", `${config.binding.externalStoreId}:campaign:${day}`, date]);
  }
  return keys;
}
export const generationTools: GenerationTools = Object.freeze<GenerationTools>({
  hydrationKeys(input, beforeTime) {
    const config = MockConfigSchema.parse(input),
      before = Date.parse(beforeTime);
    if (!Number.isFinite(before) || new Date(before).toISOString() !== beforeTime)
      throw new Error("SOURCE_INVALID_HYDRATION_TIME");
    const inventory = generateCatalog(config).flatMap((entry) =>
      entry.product.skus.map(
        (sku): HydrationEntityKey => [
          "INVENTORY",
          sku.externalSkuId,
          `${config.binding.externalStoreId}:warehouse:0`,
        ],
      ),
    );
    return [...orderKeys(config, before), ...inventory, ...marketingKeys(config, before)];
  },
  create(config, rows, beforeTime) {
    return createSourceGroupGenerator(config, {
      causal: { orders: rows.ORDER, inventory: rows.INVENTORY, lastEvent: null },
      marketing: rows.MARKETING,
      through: new Date(Date.parse(beforeTime) - 1).toISOString(),
    });
  },
});

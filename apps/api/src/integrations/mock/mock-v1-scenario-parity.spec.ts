import { expect, it } from "vitest";
import { generateMockSource } from "./mock-source.js";
// Measured from the pre-scenario source-group parent fc1ed17, not recomputed from current code.
const hashes = {
  growing: "ae6d4f6a4be87d2172dc81b51e9299068c07a234056ecf96b27735b208e5edfa",
  problematic: "d6e9efe0b8c1c8eb513aab16c0808fc25a8385f6bf6a0ee58fa586267a4ee651",
  mature: "f0aa6f7053aa06ebe3549f41a4229dff87c8a6063c69dc9b0fc70ee93eb61e3d",
  new: "f7fdd9ae4674b7e500c880a673aa3ed5ba26f3e52d75d1aaae7fbef705ded596",
};
it.each(Object.entries(hashes))("preserves exact frozen v1 %s output hash", (profile, hash) => {
  const config = {
    binding: {
      organizationId: "o",
      workspaceId: "w",
      storeId: "s",
      connectionId: "c",
      externalStoreId: "m",
    },
    seed: 42,
    profile,
    historyStart: "2026-01-01T16:00:00.000Z",
    days: 21,
    productCount: 3,
    variantsPerProduct: 2,
    dailyOrders: 20,
  };
  const source = generateMockSource(config, "2026-01-22T16:00:00.000Z");
  expect(source.generatorVersion).toBe("mock-source-v1");
  expect(source.datasetHash).toBe(hash);
});

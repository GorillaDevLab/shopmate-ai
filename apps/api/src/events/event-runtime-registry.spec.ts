import { expect, it } from "vitest";
import { EventTypeSchema } from "@shopmate/contracts";
import { createRuntimeDetectorRegistry } from "./event-runtime-registry.js";
it("registers every pinned default detector without constructing observations", () => {
  const registry = createRuntimeDetectorRegistry();
  expect(EventTypeSchema.options).toHaveLength(12);
  expect(EventTypeSchema.options.every((type) => registry.has(type))).toBe(true);
  expect(registry.policy.version).toBe("event-policy-v1");
});

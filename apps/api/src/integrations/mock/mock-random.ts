import { createHash } from "node:crypto";
import { GENERATOR_VERSION } from "./mock-config.js";

/** Domain keys keep independent catalog/day/order streams stable across regeneration. */
export function seededInteger(
  seed: number,
  keys: readonly (string | number)[],
  maximum: number,
): number {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 0xffff_ffff) {
    throw new RangeError("Invalid deterministic random bound");
  }
  const digest = createHash("sha256")
    .update(JSON.stringify([GENERATOR_VERSION, seed, ...keys]))
    .digest();
  return digest.readUInt32BE(0) % maximum;
}

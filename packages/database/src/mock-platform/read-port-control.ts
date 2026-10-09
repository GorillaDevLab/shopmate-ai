import { SourceStorageError } from "./errors.js";
import { types } from "node:util";
import { validateUtc } from "./record-primitives.js";
import type { SourceReadControl } from "./types.js";

export function fixedPortControl(control?: SourceReadControl): SourceReadControl {
  if (control !== undefined) {
    if (
      !control ||
      typeof control !== "object" ||
      types.isProxy(control) ||
      Object.getPrototypeOf(control) !== Object.prototype
    )
      throw new SourceStorageError("SOURCE_INPUT");
    for (const name of Reflect.ownKeys(control)) {
      const descriptor = Object.getOwnPropertyDescriptor(control, name);
      if (
        (name !== "signal" && name !== "deadlineAt") ||
        !descriptor ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      )
        throw new SourceStorageError("SOURCE_INPUT");
    }
    if (control.signal !== undefined && !(control.signal instanceof AbortSignal))
      throw new SourceStorageError("SOURCE_INPUT");
  }
  const requested = control?.deadlineAt;
  if (requested !== undefined && !validateUtc(requested))
    throw new SourceStorageError("SOURCE_INPUT");
  const deadline = Math.min(
    requested === undefined ? Infinity : Date.parse(requested),
    Date.now() + 30_000,
  );
  return Object.freeze({ ...control, deadlineAt: new Date(deadline).toISOString() });
}

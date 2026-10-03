import { ConnectorTimestampSchema } from "@shopmate/contracts";
import { z } from "zod";
import type { BusinessClock, BusinessTime } from "./business-clock.js";
import { MockConnectorError } from "./mock-call.js";

const counterSchema = z.number().int().min(0).max(2_147_483_647);
const stateSchema = z
  .strictObject({
    now: ConnectorTimestampSchema.refine((input) => {
      const year = new Date(input).getUTCFullYear();
      return year >= 1 && year <= 9999;
    }).transform((input) => new Date(input).toISOString()),
    revision: counterSchema,
    generation: counterSchema,
  })
  .readonly();
type ClockState = z.infer<typeof stateSchema>;

/** Persisted business time never participates in real request or authorization expiry. */
export class PersistentMockClock implements BusinessClock {
  private state: ClockState | null = null;

  snapshot(): BusinessTime {
    if (!this.state) throw new MockConnectorError("INVALID_RESPONSE");
    return Object.freeze({ now: this.state.now, revision: this.state.revision });
  }

  refresh(input: unknown): BusinessTime {
    const parsed = stateSchema.safeParse(input);
    if (!parsed.success) throw new MockConnectorError("INVALID_RESPONSE");
    if (this.state) validateTransition(this.state, parsed.data);
    this.state = parsed.data;
    return this.snapshot();
  }
}

function validateTransition(previous: ClockState, next: ClockState): void {
  if (next.generation < previous.generation) throw new MockConnectorError("AUTH_EXPIRED");
  if (next.revision < previous.revision) throw new MockConnectorError("CONFLICT");
  if (next.revision === previous.revision && next.now !== previous.now) {
    throw new MockConnectorError("INVALID_RESPONSE");
  }
  // A reset must raise both counters; only a newer generation can move business time backwards.
  if (next.generation === previous.generation && Date.parse(next.now) < Date.parse(previous.now)) {
    throw new MockConnectorError("INVALID_RESPONSE");
  }
}

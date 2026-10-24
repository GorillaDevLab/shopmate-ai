import type {
  DecisionProviderDescriptor,
  DecisionResult,
  SanitizedDecisionInput,
} from "./decision.schema.js";
import { z } from "zod";
import { EventTimestampSchema } from "../events/event-evidence.schema.js";

export const DecisionControlSchema = z
  .strictObject({
    timeDomain: z.literal("SECURITY_UTC"),
    deadlineAt: EventTimestampSchema,
    signal: z.instanceof(AbortSignal),
  })
  .readonly();

/** Required real security UTC deadline; a BusinessClock must never drive provider cancellation. */
export interface DecisionControl {
  readonly timeDomain: "SECURITY_UTC";
  readonly deadlineAt: string;
  readonly signal: AbortSignal;
}
/** Server selects the descriptor. The provider receives no scope, credentials or action capabilities. */
export interface DecisionProvider {
  readonly descriptor: DecisionProviderDescriptor;
  readonly evaluate: (
    input: SanitizedDecisionInput,
    control: DecisionControl,
  ) => Promise<DecisionResult>;
}

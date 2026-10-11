import {
  MockReadFailureRulesSchema,
  MockReadMethodSchema,
  MockReadFailureEffectSchema,
  DemoFailureRuleTimestampSchema,
} from "@shopmate/contracts";
import type { z } from "zod";
import { MockConnectorError } from "./mock-call.js";
export {
  MockReadFailureRulesSchema,
  MockReadMethodSchema,
  MockReadFailureEffectSchema,
} from "@shopmate/contracts";
export type MockReadMethod = z.infer<typeof MockReadMethodSchema>;

export interface MockReadFailureDecision {
  readonly ruleId: string;
  readonly effect: z.infer<typeof MockReadFailureEffectSchema>;
}

/** One deterministic winning condition; activation never uses real-time call counters. */
export function selectMockReadFailure(
  unknownRules: unknown,
  method: MockReadMethod,
  observedAt: unknown,
): Readonly<MockReadFailureDecision> | null {
  const rules = MockReadFailureRulesSchema.safeParse(unknownRules);
  const at = DemoFailureRuleTimestampSchema.safeParse(observedAt);
  if (!rules.success || !at.success) throw new MockConnectorError("INVALID_RESPONSE");
  const now = Date.parse(at.data);
  const winner = rules.data
    .filter(
      (rule) =>
        rule.methods.includes(method) &&
        Date.parse(rule.startsAt) <= now &&
        now < Date.parse(rule.endsAt),
    )
    .sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  return winner ? Object.freeze({ ruleId: winner.id, effect: winner.effect }) : null;
}

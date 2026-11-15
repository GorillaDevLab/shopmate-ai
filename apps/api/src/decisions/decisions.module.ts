import { Injectable, Module } from "@nestjs/common";
import type { EvaluationContext, SecurityClock } from "@shopmate/contracts";
import type { DecisionEvaluationAuthority, DecisionReadPort } from "@shopmate/database";
import type { EventRuntimeTransaction } from "../events/event-decision-transaction.js";
import { createRuntimeDecisionHost } from "./decision-runtime-host.js";

@Injectable()
export class DecisionRuntimeComposition {
  host(
    scope: EventRuntimeTransaction,
    context: EvaluationContext,
    repository: DecisionEvaluationAuthority & DecisionReadPort,
    clock: SecurityClock,
  ) {
    return createRuntimeDecisionHost(scope, context, repository, clock);
  }
}
@Module({ providers: [DecisionRuntimeComposition], exports: [DecisionRuntimeComposition] })
export class DecisionsModule {}

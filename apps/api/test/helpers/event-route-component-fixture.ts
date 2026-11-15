import { randomUUID } from "node:crypto";
import { ServiceUnavailableException } from "@nestjs/common";
import {
  createEventFingerprint,
  EventCandidateSchema,
  EventEvidenceV1Schema,
  RoutedPrimaryDecisionRunSchema,
  type DecisionControl,
  type DecisionLabels,
  type DecisionProvider,
  type DecisionResult,
  type EvaluationContext,
  type EventCandidate,
  type PrimaryDecisionRun,
  type RoutingPort,
} from "@shopmate/contracts";
import { createDecisionRunRepository } from "@shopmate/database";
import {
  DecisionEvaluationHost,
  DecisionProviderRegistry,
  stableKey,
} from "../../src/decisions/decision-evaluation.host.js";
import { DEFAULT_DECISION_RULESET as ruleset } from "../../src/decisions/decision-ruleset.js";
import { DEFAULT_EVENT_RULE_POLICY as eventPolicy } from "../../src/events/event-rule-policy.js";
import { DefaultDecisionHardGate } from "../../src/decisions/decision-hard-gate.js";
import { DefaultDecisionInputSanitizer } from "../../src/decisions/decision-input-sanitizer.js";
import { DecisionRoutingService } from "../../src/decisions/decision-routing.service.js";
import {
  RUNTIME_ROUTING_POLICY,
  RUNTIME_RULES_DESCRIPTOR,
} from "../../src/decisions/decision-runtime-policy.js";
import { loadRuntimeHistory } from "../../src/decisions/decision-runtime-history.js";
import { persistRuntimeCandidate } from "../../src/events/event-runtime-persistence.js";
import { applyRuntimeEffects } from "../../src/events/event-runtime-effects.js";
import {
  EVENT_SECURITY_CLOCK as clock,
  runtimeControl,
} from "../../src/events/event-decision-unit-of-work.js";
import type { EventRuntimeTransaction } from "../../src/events/event-decision-transaction.js";
import {
  actor,
  binding,
  observedAt,
  type AtomicityFixture,
} from "./event-route-atomicity-fixture.js";
import { customEffects } from "./event-route-component-effects.js";

function period(at: string) {
  return {
    periodStart: new Date(Date.parse(at) - 3600000).toISOString(),
    periodEnd: at,
    timezone: "Asia/Shanghai",
    currency: "CNY",
  };
}
function source(at: string, version: number) {
  return {
    kind: "NORMALIZED_AGGREGATE",
    id: "test-only-component-aggregate",
    version: `v${version}`,
    hash: `test-only-hash-${version}`,
    binding,
    definitionVersion: "metrics-v1",
    period: period(at),
    observedAt: at,
    measure: null,
  };
}
function stockoutFacts(at: string) {
  return {
    availableUnits: 100,
    salesUnits: 100,
    salesWindow: period(at),
    salesWindowHours: 1,
    estimatedHoursRemaining: 1,
    supplierLeadTimeHours: 8,
    safetyBufferHours: null,
    inboundETA: null,
    inventoryObservedAt: at,
    inventoryAgeSeconds: 0,
    inventoryStatus: "VERIFIED",
  };
}
export function candidate(version = 1): EventCandidate {
  const at = new Date(Date.parse(observedAt) + version * 1000).toISOString();
  const evidence = EventEvidenceV1Schema.parse({
    schemaVersion: 1,
    binding,
    ...period(at),
    observedAt: at,
    sourceWatermark: at,
    dataStatus: "VERIFIED",
    sampleSize: 100,
    coverageBasisPoints: 10000,
    issues: [],
    definitionVersion: "metrics-v1",
    baselineVersion: null,
    baselineAlignment: "MISSING",
    baseline: null,
    sourceReferences: [source(at, version)],
    eventType: "STOCKOUT_RISK",
    entity: { kind: "SKU", externalSkuId: "component-only-sku" },
    facts: stockoutFacts(at),
  });
  return EventCandidateSchema.parse({
    schemaVersion: 1,
    fingerprint: createEventFingerprint(evidence),
    severityFloor: "HIGH",
    rulePolicyVersion: eventPolicy.version,
    evidence,
  });
}
export function evaluated(
  correlationId: string,
  severity: DecisionLabels["severity"] = "HIGH",
): DecisionResult {
  return {
    schemaVersion: 1,
    status: "EVALUATED",
    correlationId,
    rulesetVersion: ruleset.version,
    labels: {
      severity,
      notificationRoute: "NOTIFY_NOW",
      llmEscalation: "DEEP_REASONING_REQUIRED",
      evidenceSufficiency: "SUFFICIENT",
      attentionPriority: "HIGH_PRIORITY",
      reasonCodes: ["CONFIRMED_STOCKOUT"],
    },
    confidenceMetadata: null,
  };
}
export function offlineProvider(severity: DecisionLabels["severity"] = "HIGH"): DecisionProvider {
  return {
    descriptor: RUNTIME_RULES_DESCRIPTOR,
    evaluate: async (input) => evaluated(input.correlationId, severity),
  };
}
export class ComponentEvaluator {
  routes = 0;
  providers = 0;
  constructor(
    readonly fixture: AtomicityFixture,
    readonly primary = offlineProvider(),
    readonly attemptTimeoutMs = 1000,
  ) {}
  private fallback = offlineProvider();
  decisionKey = (context: EvaluationContext) =>
    stableKey(context, ruleset, this.primary, this.fallback);
  async evaluate(
    version = 1,
    control: DecisionControl = runtimeControl(),
    context?: EvaluationContext,
  ): Promise<PrimaryDecisionRun> {
    return this.fixture.uow.transaction(
      {
        actor,
        binding,
        generation: 0,
        revisions: [],
        recipientId: "event-runtime-recipient",
        writable: true,
        control,
      },
      async (scope) => {
        const current =
          context ??
          (await persistRuntimeCandidate(
            this.fixture.uow,
            scope,
            candidate(version),
            randomUUID(),
            randomUUID(),
          ));
        return this.evaluateIn(scope, current);
      },
    );
  }
  private repository(scope: EventRuntimeTransaction) {
    return createDecisionRunRepository({
      actor,
      client: scope.client,
      clock,
      decisionKey: this.decisionKey,
    });
  }
  private async evaluateIn(scope: EventRuntimeTransaction, context: EvaluationContext) {
    const repository = this.repository(scope);
    const prior = await scope.client.query(
      'SELECT "winnerRunId" FROM decision_claims WHERE "eventId"=$1 AND "evidenceId"=$2 AND "decisionKey"=$3',
      [context.event.id, context.evidence.reference.id, this.decisionKey(context)],
    );
    const result = await this.host(scope, context, repository).evaluate(
      context,
      scope.authority.control,
    );
    if (!result.ok || !result.value.effective)
      throw new ServiceUnavailableException("Component evaluation unavailable");
    const winner = prior.rows[0]?.winnerRunId;
    if (this.primary.descriptor.key === "rules")
      await applyRuntimeEffects(
        scope,
        context,
        result.value,
        typeof winner === "string" ? winner : null,
        clock,
      );
    else
      await customEffects(
        scope,
        context,
        result.value,
        this.decisionKey,
        typeof winner === "string",
      );
    return result.value;
  }
  private host(
    scope: EventRuntimeTransaction,
    context: EvaluationContext,
    repository: ReturnType<ComponentEvaluator["repository"]>,
  ) {
    const primary: DecisionProvider = {
      descriptor: this.primary.descriptor,
      evaluate: (input, control) => {
        this.providers++;
        return this.primary.evaluate(input, control);
      },
    };
    const registry =
      primary.descriptor.key === "rules"
        ? new DecisionProviderRegistry(primary)
        : new DecisionProviderRegistry(this.fallback, [{ mode: "PRIMARY", provider: primary }]);
    const hardGate = new DefaultDecisionHardGate({
      read: () => ({ ok: true, value: { context, ruleset, eventPolicy, budget: "ELIGIBLE" } }),
    });
    return new DecisionEvaluationHost({
      registry,
      authority: repository,
      clock,
      ruleset,
      hardGate,
      sanitizer: new DefaultDecisionInputSanitizer(),
      primaryKey: primary.descriptor.key,
      attemptTimeoutMs: this.attemptTimeoutMs,
      routing: this.routing(scope, context, repository),
    });
  }
  private routing(
    scope: EventRuntimeTransaction,
    context: EvaluationContext,
    repository: ReturnType<ComponentEvaluator["repository"]>,
  ): RoutingPort {
    return {
      route: async (request) => {
        this.routes++;
        return new DecisionRoutingService(
          {
            load: async () => ({
              ok: true,
              value: {
                context,
                activeRun: RoutedPrimaryDecisionRunSchema.parse(request.run),
                decisionKey: request.run.decisionKey,
                provider: request.run.provider,
                rulesetVersion: ruleset.version,
                preferences: { notifications: "ALL", allowDeep: true, quietHours: null },
                budget: { remainingDeepRuns: 100 },
                policy: RUNTIME_ROUTING_POLICY,
                history: await loadRuntimeHistory(scope, repository),
              },
            }),
          },
          clock,
        ).route(request);
      },
    };
  }
}

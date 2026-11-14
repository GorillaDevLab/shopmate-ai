import { BadRequestException, HttpException, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DecisionControlSchema,
  EventPeriodSchema,
  EventTimestampSchema,
  ExternalIdSchema,
  TenantIdSchema,
  type EventRecord,
  type EventCandidate,
  type PrimaryDecisionRun,
} from "@shopmate/contracts";
import type { AuthContext } from "../auth/contracts/index.js";
import { AuthPermission } from "../auth/contracts/index.js";
import { TenantScopeService, tenantNotFound } from "../tenant/tenant-scope.service.js";
import { MetricRuntimeService } from "../metrics/metric-runtime.service.js";
import {
  EventDecisionUnitOfWork,
  EVENT_SECURITY_CLOCK,
  runtimeControl,
} from "./event-decision-unit-of-work.js";
import { EventRuntimeSource, type PersistedRuntimeFrame } from "./event-runtime-source.js";
import { EventEvaluationService } from "./event-evaluation.service.js";
import { createRuntimeDetectorRegistry } from "./event-runtime-registry.js";
import { createRobustBaseline } from "./robust-baseline.js";
import { DEFAULT_EVENT_RULE_POLICY } from "./event-rule-policy.js";
import { persistRuntimeCandidate } from "./event-runtime-persistence.js";
import { DecisionRuntimeComposition } from "../decisions/decisions.module.js";
import { priorRuntimeWinner, applyRuntimeEffects } from "./event-runtime-effects.js";
import type { EventRuntimeTransaction } from "./event-decision-transaction.js";
import { runtimeUnavailable } from "./event-transaction-lifetime.js";

const requestSchema = z
  .strictObject({
    identity: z.strictObject({
      userId: TenantIdSchema,
      merchantId: TenantIdSchema,
      permissions: z.array(z.enum(AuthPermission)).readonly(),
    }),
    workspaceId: TenantIdSchema,
    storeId: TenantIdSchema,
    externalSkuId: ExternalIdSchema,
    window: EventPeriodSchema,
    observedAt: EventTimestampSchema,
    recipientId: TenantIdSchema,
    control: DecisionControlSchema.optional(),
  })
  .refine((input) => Date.parse(input.window.periodEnd) <= Date.parse(input.observedAt));
export interface EventRuntimeRequest {
  readonly identity: AuthContext;
  readonly workspaceId: string;
  readonly storeId: string;
  readonly externalSkuId: string;
  readonly window: z.infer<typeof EventPeriodSchema>;
  readonly observedAt: string;
  readonly recipientId: string;
  readonly control?: z.infer<typeof DecisionControlSchema>;
}
export interface EventRuntimeResult {
  readonly events: readonly EventRecord[];
  readonly decisions: readonly PrimaryDecisionRun[];
}
/** Server-only application service. No controller exposes evaluation or source provisioning. */
@Injectable()
export class EventDecisionRuntimeService {
  constructor(
    private readonly tenants: TenantScopeService,
    private readonly metrics: MetricRuntimeService,
    private readonly source: EventRuntimeSource,
    private readonly uow: EventDecisionUnitOfWork,
    private readonly decisions: DecisionRuntimeComposition,
  ) {}
  async evaluate(request: EventRuntimeRequest): Promise<EventRuntimeResult> {
    const parsed = requestSchema.safeParse(request);
    if (!parsed.success) throw new BadRequestException();
    try {
      return await this.evaluateAuthorized(parsed.data);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw runtimeUnavailable();
    }
  }
  private async evaluateAuthorized(
    input: z.infer<typeof requestSchema>,
  ): Promise<EventRuntimeResult> {
    this.uow.requireAvailable();
    const actor = await this.tenants.resolve(input.identity, input.workspaceId);
    const binding = await this.metrics.resolve(actor, input.storeId);
    if (!binding) tenantNotFound();
    const frame = await this.source.prepare({
      actor,
      binding,
      externalSkuId: input.externalSkuId,
      window: input.window,
      observedAt: input.observedAt,
    });
    return this.uow.transaction(
      {
        actor,
        binding,
        generation: frame.bundle.generation,
        revisions: [frame.bundle.inputRevision],
        recipientId: input.recipientId,
        writable: true,
        control: input.control ?? runtimeControl(),
      },
      (scope) => this.evaluateFrame(scope, frame),
    );
  }
  private async evaluateFrame(
    scope: EventRuntimeTransaction,
    frame: PersistedRuntimeFrame,
  ): Promise<EventRuntimeResult> {
    const candidates = await this.detect(frame);
    const events: EventRecord[] = [],
      decisions: PrimaryDecisionRun[] = [];
    for (const candidate of candidates) {
      const result = await this.decide(scope, candidate);
      events.push(result.event);
      decisions.push(result.decision);
    }
    return { events, decisions };
  }
  private async detect(frame: PersistedRuntimeFrame): Promise<readonly EventCandidate[]> {
    const registry = createRuntimeDetectorRegistry();
    const baselines = createRobustBaseline({
      version: registry.policy.baselineVersion,
      minimumSamples: 4,
      lookbackWeeks: 8,
      maximumAgeSeconds: 8 * 7 * 86400,
    });
    const evaluated = await new EventEvaluationService(
      frame.observation.actor,
      this.metrics,
      baselines,
      registry,
    ).evaluate({
      binding: frame.observation.binding,
      period: frame.observation.window,
      observedAt: frame.observation.observedAt,
      definitionVersion: frame.evidence.definitionVersion,
      inputRevision: frame.bundle.inputRevision,
      sourceWatermark: frame.bundle.sourceWatermark,
      rulePolicyVersion: DEFAULT_EVENT_RULE_POLICY.version,
      jobs: [
        {
          evidence: frame.evidence,
          measures: frame.rows.map((row) => ({
            kind: row.snapshot.metric.kind,
            unit: row.snapshot.metric.unit,
          })),
          baselineRequest: null,
        },
      ],
    });
    if (!evaluated.ok) throw runtimeUnavailable();
    return evaluated.value.candidates;
  }
  private async decide(scope: EventRuntimeTransaction, candidate: EventCandidate) {
    const context = await persistRuntimeCandidate(
      this.uow,
      scope,
      candidate,
      randomUUID(),
      randomUUID(),
    );
    const repository = this.uow.decisions(scope);
    const prior = await priorRuntimeWinner(scope, context);
    await scope.reauthorize();
    const decision = await this.decisions
      .host(scope, context, repository, EVENT_SECURITY_CLOCK)
      .evaluate(context, scope.authority.control);
    if (!decision.ok) throw runtimeUnavailable();
    await applyRuntimeEffects(scope, context, decision.value, prior, EVENT_SECURITY_CLOCK);
    return { event: context.event, decision: decision.value };
  }
}

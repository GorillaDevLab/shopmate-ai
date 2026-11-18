import { randomUUID } from "node:crypto";
import { EvaluationContextSchema, type PrimaryDecisionRun } from "@shopmate/contracts";
import {
  EventLifecycleService,
  type EventLifecycleUnitOfWork,
} from "../../src/events/event-lifecycle.service.js";
import { TenantScopeService } from "../../src/tenant/tenant-scope.service.js";
import { AuditAppendRepository } from "../../src/audit/audit-append.repository.js";
import type { BoundNotificationTransaction } from "../../src/notifications/notification-enqueue.repository.js";
import { runtimeControl } from "../../src/events/event-decision-unit-of-work.js";
import {
  actor,
  binding,
  identity,
  type AtomicityFixture,
} from "./event-route-atomicity-fixture.js";

function lifecycleUnit(
  fixture: AtomicityFixture,
): EventLifecycleUnitOfWork<BoundNotificationTransaction> {
  return {
    run: (_identity, _selection, work) =>
      fixture.uow.transaction(
        {
          actor,
          binding,
          generation: 0,
          revisions: [],
          recipientId: "event-runtime-recipient",
          writable: true,
          control: runtimeControl(),
        },
        async (scope) => {
          const events = fixture.uow.events(scope);
          return work({ actor, binding, transaction: scope.handle, query: events, events });
        },
      ),
  };
}
export async function recoveryContext(fixture: AtomicityFixture, prior: PrimaryDecisionRun) {
  const event = await fixture.uow.read(actor, binding, (scope) =>
    fixture.uow.events(scope).detail({ actor, binding, eventId: prior.eventId }),
  );
  if (!event.ok) throw new Error("Component event unavailable");
  const service = new EventLifecycleService(
    fixture.app.get(TenantScopeService),
    lifecycleUnit(fixture),
    new AuditAppendRepository(),
  );
  const resolved = await service.execute("resolve", {
    auth: identity,
    headers: {},
    rawHeaders: [],
    params: {
      workspaceId: binding.workspaceId,
      storeId: binding.storeId,
      eventId: prior.eventId,
    },
    body: { expectedRevision: event.value.revision, reason: "CONDITION_CLEARED" },
  });
  return fixture.uow.read(actor, binding, async (scope) => {
    const evidence = await fixture.uow
      .events(scope)
      .evidence({ actor, binding, eventId: resolved.id, reference: resolved.currentEvidence });
    if (!evidence.ok) throw new Error("Component recovery evidence unavailable");
    return EvaluationContextSchema.parse({
      schemaVersion: 1,
      actor,
      event: resolved,
      evidence: evidence.value,
      requestId: randomUUID(),
      correlationId: randomUUID(),
    });
  });
}

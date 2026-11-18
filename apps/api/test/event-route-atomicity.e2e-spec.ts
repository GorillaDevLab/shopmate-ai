import { recoveryContext } from "./helpers/event-route-component-recovery.js";
import "reflect-metadata";
import { expect, it, vi } from "vitest";
import { disconnectPrismaClient, getPrismaClient } from "@shopmate/database";
import request from "supertest";
import {
  withAtomicity,
  evaluateDefault,
  binding,
  actor,
  type AtomicityFixture,
} from "./helpers/event-route-atomicity-fixture.js";
import {
  ComponentEvaluator,
  evaluated,
  offlineProvider,
} from "./helpers/event-route-component-fixture.js";
import { deferred, overlapping, sqlFault } from "./helpers/event-route-atomicity-controls.js";
import { runtimeControl } from "../src/events/event-decision-unit-of-work.js";
import type { DecisionProvider, PrimaryDecisionRun } from "@shopmate/contracts";

const immediate = { notificationRoute: "NOTIFY_NOW", llmEscalation: "DEEP_REASONING_REQUIRED" };

async function savedWinner(fixture: AtomicityFixture, run: PrimaryDecisionRun) {
  const durable = await fixture.uow.read(actor, binding, (scope) =>
    fixture.uow.decisions(scope).read({ actor, binding, eventId: run.eventId, decisionId: run.id }),
  );
  expect(durable.ok && durable.value).toEqual([run]);
  const winner = await fixture.source.query(
    'SELECT "winnerRunId" FROM decision_claims WHERE "eventId"=$1 AND "decisionKey"=$2',
    [run.eventId, run.decisionKey],
  );
  expect(winner.rows).toEqual([{ winnerRunId: run.id }]);
  const outbox = await fixture.source.query(
    'SELECT "decisionRunId",route FROM notification_outbox WHERE "decisionRunId"=$1',
    [run.id],
  );
  expect(outbox.rows).toEqual([{ decisionRunId: run.id, route: run.effective?.notificationRoute }]);
  const audit = await fixture.source.query(
    `SELECT payload->'event'->>'eventType' AS type FROM audit_logs
    WHERE payload->'links'->>'runId'=$1 OR payload->'resource'->>'id' IN
    (SELECT "rowId"::text FROM notification_outbox WHERE "decisionRunId"=$1) ORDER BY type`,
    [run.id],
  );
  expect(audit.rows).toEqual([{ type: "AGENT_RUN" }, { type: "NOTIFICATION_INTENT" }]);
}
async function protectedReadback(
  fixture: AtomicityFixture,
  result: Awaited<ReturnType<typeof evaluateDefault>>,
) {
  const event = result.events[0]!,
    run = result.decisions[0]!,
    base = `/api/v1/stores/${binding.storeId}/events/${event.id}`;
  await request(fixture.app.getHttpServer()).get(base).expect(401);
  const detail = await request(fixture.app.getHttpServer())
    .get(base)
    .set("Cookie", fixture.cookie)
    .expect(200);
  expect(detail.body.event.id).toBe(event.id);
  const ref = event.currentEvidence;
  await request(fixture.app.getHttpServer())
    .get(`${base}/evidence/${ref.id}`)
    .query({ version: ref.version, hash: ref.hash, definitionVersion: ref.definitionVersion })
    .set("Cookie", fixture.cookie)
    .expect(200);
  const decisions = await request(fixture.app.getHttpServer())
    .get(`${base}/decisions`)
    .set("Cookie", fixture.cookie)
    .expect(200);
  expect(decisions.body.items.map((item: { id: string }) => item.id)).toEqual([run.id]);
  await request(fixture.app.getHttpServer())
    .post(`/api/v1/stores/${binding.storeId}/events/evaluate`)
    .set("Cookie", fixture.cookie)
    .send({})
    .expect(404);
}
it("default App concurrent evaluations retain one conservative DAILY_BRIEF winner and protected evidence", async () => {
  await withAtomicity(async (fixture) => {
    await fixture.source.seed();
    const results = await overlapping(fixture, () => evaluateDefault(fixture));
    for (let i = 0; i < 8; i++) results.push(await evaluateDefault(fixture));
    expect(new Set(results.map((result) => result.decisions[0]?.id)).size).toBe(1);
    const run = results[0]!.decisions[0]!;
    expect(run.effective).toMatchObject({
      notificationRoute: "DAILY_BRIEF",
      llmEscalation: "NO_LLM_NEEDED",
      evidenceSufficiency: "INSUFFICIENT_DATA",
    });
    expect(await fixture.source.counts()).toMatchObject({
      events: 1,
      event_evidence: 1,
      decision_claims: 1,
      decision_runs: 1,
      notification_outbox: 1,
      audit_logs: 2,
    });
    await savedWinner(fixture, run);
    await protectedReadback(fixture, results[0]!);
  });
});
it("known-preferences component authorizes DEEP once and deduplicates ten concurrent/repeated evaluations", async () => {
  await withAtomicity(async (fixture) => {
    const component = new ComponentEvaluator(fixture);
    const results = await overlapping(fixture, () => component.evaluate());
    expect(results[0]!.effective).toMatchObject({
      notificationRoute: "NOTIFY_NOW",
      llmEscalation: "DEEP_REASONING_REQUIRED",
    });
    for (let i = 0; i < 8; i++) results.push(await component.evaluate());
    expect(new Set(results.map((run) => run.id)).size).toBe(1);
    expect(component.routes).toBe(1);
    expect(component.providers).toBe(1);
    expect(await fixture.source.counts()).toMatchObject({
      events: 1,
      event_evidence: 1,
      decision_claims: 1,
      decision_runs: 1,
      notification_outbox: 1,
      audit_logs: 2,
    });
    await savedWinner(fixture, results[0]!);
  });
});
it.each(["audit", "outbox", "denial"] as const)(
  "rolls back every earlier write on a real %s boundary failure and retries once",
  async (boundary) => {
    await withAtomicity(async (fixture) => {
      const component = new ComponentEvaluator(fixture),
        before = await fixture.source.counts();
      const { evidence, result } = await sqlFault(fixture, boundary, () => component.evaluate());
      expect(evidence.upstream).toEqual([{ events: 1, runs: 1 }]);
      if (boundary === "denial") {
        expect(evidence.authorization).toEqual([{ allowed: false, currentUser: actor.userId }]);
      } else {
        expect(evidence.injected).toBe(boundary);
      }
      expect(result).toMatchObject({ status: "rejected", reason: { status: 503 } });
      expect(await fixture.source.counts()).toEqual(before);
      const run = await component.evaluate();
      await savedWinner(fixture, run);
      const after = await fixture.source.counts();
      expect(after).toMatchObject({
        events: 1,
        event_evidence: 1,
        decision_claims: 1,
        decision_runs: 1,
        notification_outbox: 1,
        audit_logs: 2,
      });
      expect((await component.evaluate()).id).toBe(run.id);
      expect(await fixture.source.counts()).toEqual(after);
    });
  },
);
it("finishes fixture cleanup and restores process state when disposers fail", async () => {
  const fetch = globalThis.fetch;
  const databaseUrl = process.env.DATABASE_URL;
  const runtimeUrl = process.env.EVENT_DECISION_DATABASE_URL;
  const workFailure = new Error("Fixture work failed");
  const appFailure = new Error("App disposer failed");
  const sourceFailure = new Error("Source disposer failed");
  let childPrisma: ReturnType<typeof getPrismaClient> | undefined;
  try {
    const [result] = await Promise.allSettled([
      withAtomicity(async ({ app, source }) => {
        childPrisma = getPrismaClient();
        const closeApp = app.close.bind(app);
        vi.spyOn(app, "close").mockImplementationOnce(async () => {
          await closeApp();
          throw appFailure;
        });
        // Keep the child safe to drop even if the cleanup regression recurs.
        await source.close();
        vi.spyOn(source, "close").mockRejectedValueOnce(sourceFailure);
        throw workFailure;
      }),
    ]);
    expect({
      databaseRestored: process.env.DATABASE_URL === databaseUrl,
      runtimeRestored: process.env.EVENT_DECISION_DATABASE_URL === runtimeUrl,
      fetchRestored: globalThis.fetch === fetch,
    }).toEqual({ databaseRestored: true, runtimeRestored: true, fetchRestored: true });
    expect(getPrismaClient() === childPrisma).toBe(false);
    expect(result).toMatchObject({
      status: "rejected",
      reason: { errors: [workFailure, appFailure, sourceFailure] },
    });
  } finally {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await disconnectPrismaClient();
  }
});

function lateProvider() {
  const entered = deferred(),
    release = deferred(),
    completed = deferred();
  const provider: DecisionProvider = {
    descriptor: { key: "offline-primary", version: "test-v1", supportedInputVersions: [1] },
    evaluate: async (input) => {
      entered.resolve();
      await release.promise;
      const result = evaluated(input.correlationId);
      completed.resolve();
      return result;
    },
  };
  return { provider, entered, release, completed };
}
it("a timed-out offline primary cannot displace the committed real fallback winner after completing late", async () => {
  await withAtomicity(async (fixture) => {
    const late = lateProvider(),
      component = new ComponentEvaluator(fixture, late.provider, 100);
    const pending = component.evaluate(1, runtimeControl(10000));
    try {
      await Promise.race([late.entered.promise, pending]);
      const winner = await pending;
      expect(winner.provider.key).toBe("rules");
      expect(winner.fallbackOf).not.toBeNull();
      const primary = await fixture.source.query(
        "SELECT result,effective FROM decision_runs WHERE id=$1",
        [winner.fallbackOf],
      );
      expect(primary.rows).toEqual([
        {
          result: expect.objectContaining({ status: "UNAVAILABLE", code: "TIMEOUT" }),
          effective: null,
        },
      ]);
      expect(winner.effective).toMatchObject({
        notificationRoute: "NOTIFY_NOW",
        llmEscalation: "DEEP_REASONING_REQUIRED",
      });
      const before = await fixture.source.counts();
      late.release.resolve();
      await late.completed.promise;
      await savedWinner(fixture, winner);
      expect(await fixture.source.counts()).toEqual(before);
      expect((await component.evaluate()).id).toBe(winner.id);
      expect(component.routes).toBe(1);
      expect(component.providers).toBe(1);
    } finally {
      late.release.resolve();
      await pending.catch(() => undefined);
    }
  });
});
it("real SECURITY_UTC expiry rolls back pending work and prevents late effective commit", async () => {
  await withAtomicity(async (fixture) => {
    const late = lateProvider(),
      component = new ComponentEvaluator(fixture, late.provider, 5000);
    const before = await fixture.source.counts(),
      control = runtimeControl(700);
    const pending = component.evaluate(1, control);
    try {
      await Promise.race([late.entered.promise, pending]);
      await expect(pending).rejects.toMatchObject({ status: 503 });
      expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(control.deadlineAt));
      late.release.resolve();
      await late.completed.promise;
      expect(await fixture.source.counts()).toEqual(before);
    } finally {
      late.release.resolve();
      await pending.catch(() => undefined);
    }
  });
});

it("persisted cooldown history defers unchanged severity and allows fresh upgrade and legitimate recovery", async () => {
  await withAtomicity(async (fixture) => {
    const initial = new ComponentEvaluator(fixture),
      first = await initial.evaluate();
    expect(first.effective).toMatchObject(immediate);
    const unchanged = await initial.evaluate(2);
    expect(unchanged.effective).toMatchObject({
      notificationRoute: "DAILY_BRIEF",
      llmEscalation: "NO_LLM_NEEDED",
    });
    expect(unchanged.overrideReason).toBe("COOLDOWN");
    const upgrade = new ComponentEvaluator(fixture, offlineProvider("CRITICAL"));
    const higher = await upgrade.evaluate(3);
    expect(higher.effective).toMatchObject({
      severity: "CRITICAL",
      notificationRoute: "NOTIFY_NOW",
      llmEscalation: "DEEP_REASONING_REQUIRED",
    });
    const context = await recoveryContext(fixture, higher);
    expect(context.event.state).toBe("RESOLVED");
    const recovered = await upgrade.evaluate(3, runtimeControl(), context);
    expect(recovered.effective).toMatchObject(immediate);
    for (const run of [first, unchanged, higher, recovered]) await savedWinner(fixture, run);
    const counts = await fixture.source.counts();
    expect(counts).toMatchObject({
      events: 1,
      event_evidence: 3,
      decision_claims: 4,
      decision_runs: 4,
      notification_outbox: 4,
      audit_logs: 9,
    });
    expect((await upgrade.evaluate(3, runtimeControl(), context)).id).toBe(recovered.id);
    expect(await fixture.source.counts()).toEqual(counts);
  });
});

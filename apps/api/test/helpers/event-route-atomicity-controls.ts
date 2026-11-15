import { setTimeout as delay } from "node:timers/promises";
import { expect, vi } from "vitest";
import type { EventDecisionUnitOfWork } from "../../src/events/event-decision-unit-of-work.js";
import type { EventRuntimeTransaction } from "../../src/events/event-decision-transaction.js";
import type { AtomicityFixture } from "./event-route-atomicity-fixture.js";

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function waiting(fixture: AtomicityFixture, firstPid: number) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const result = await fixture.source.query(
      "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND pid<>$2 AND wait_event_type='Lock'",
      ["shopmate_event_decision_api", firstPid],
    );
    if (result.rows.length) return;
    await delay(5);
  }
  throw new Error("A second real restricted runtime session did not wait on PostgreSQL");
}
async function finishOverlap<T>(
  fixture: AtomicityFixture,
  pid: number,
  release: () => void,
  first: Promise<T>,
  second: Promise<T>,
) {
  let failure: unknown;
  try {
    await waiting(fixture, pid);
  } catch (error) {
    failure = error;
  } finally {
    release();
  }
  const results = await Promise.all([first, second]);
  if (failure) throw failure;
  return results;
}
export async function overlapping<T>(fixture: AtomicityFixture, evaluate: () => Promise<T>) {
  const entered = deferred<number>(),
    release = deferred();
  const original = fixture.uow.transaction.bind(fixture.uow);
  let held = false;
  const hook: EventDecisionUnitOfWork["transaction"] = (input, work) =>
    original(input, async (scope) => {
      const result = await work(scope);
      if (input.writable && !held) {
        held = true;
        const pid = (await scope.client.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
        if (typeof pid !== "number") throw new Error("Restricted runtime PID unavailable");
        entered.resolve(pid);
        await release.promise;
      }
      return result;
    });
  const spy = vi.spyOn(fixture.uow, "transaction").mockImplementation(hook);
  const first = evaluate();
  try {
    const pid = await Promise.race([
      entered.promise,
      first.then(() => {
        throw new Error("No runtime barrier reached");
      }),
    ]);
    return await finishOverlap(fixture, pid, release.resolve, first, evaluate());
  } finally {
    release.resolve();
    spy.mockRestore();
  }
}
type Boundary = "audit" | "outbox" | "denial";
function matches(sql: string, boundary: Boundary) {
  if (boundary === "audit") return sql.includes("INSERT INTO public.audit_logs");
  if (boundary === "outbox") return sql.includes("INSERT INTO public.notification_outbox");
  return (
    sql.startsWith("SELECT public.notification_scope_access") && sql.includes('AS "currentUser"')
  );
}
async function hitBoundary(
  fixture: AtomicityFixture,
  scope: EventRuntimeTransaction,
  boundary: Boundary,
) {
  const rows = await scope.client.query(
    "SELECT (SELECT count(*)::int FROM events) AS events,(SELECT count(*)::int FROM decision_runs) AS runs",
  );
  expect(rows.rows[0]).toMatchObject({ events: 1, runs: 1 });
  if (boundary === "denial")
    await fixture.source.query('UPDATE "WorkspaceMember" SET status=$1 WHERE "userId"=$2', [
      "INACTIVE",
      "event-runtime-recipient",
    ]);
  else throw new Error(`Injected actual ${boundary} SQL boundary failure`);
}
async function faultIn<T>(
  fixture: AtomicityFixture,
  scope: EventRuntimeTransaction,
  boundary: Boundary,
  reached: { value: boolean },
  operation: (scope: EventRuntimeTransaction) => Promise<T>,
) {
  const query = scope.client.query.bind(scope.client);
  const spy = vi.spyOn(scope.client, "query").mockImplementation(async (sql, values) => {
    if (!reached.value && matches(sql, boundary)) {
      reached.value = true;
      await hitBoundary(fixture, scope, boundary);
    }
    const result = await query(sql, values);
    if (boundary === "denial" && matches(sql, boundary))
      expect(result.rows[0]?.allowed).toBe(false);
    return result;
  });
  try {
    return await operation(scope);
  } finally {
    spy.mockRestore();
  }
}
export async function sqlFault<T>(
  fixture: AtomicityFixture,
  boundary: Boundary,
  work: () => Promise<T>,
) {
  const original = fixture.uow.transaction.bind(fixture.uow),
    reached = { value: false };
  const hook: EventDecisionUnitOfWork["transaction"] = (input, operation) =>
    original(input, (scope) => faultIn(fixture, scope, boundary, reached, operation));
  const spy = vi.spyOn(fixture.uow, "transaction").mockImplementation(hook);
  try {
    return await work();
  } finally {
    spy.mockRestore();
    await fixture.source.query('UPDATE "WorkspaceMember" SET status=$1 WHERE "userId"=$2', [
      "ACTIVE",
      "event-runtime-recipient",
    ]);
    expect(reached.value).toBe(true);
  }
}

import { setTimeout as delay } from "node:timers/promises";
import { vi } from "vitest";
import { overlapAtBarrier } from "../../../../packages/database/test/helpers/event-decision-concurrency-fixture.mjs";
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
  try {
    return await overlapAtBarrier({
      entered: entered.promise,
      release: release.resolve,
      first: evaluate,
      second: evaluate,
      waitForOverlap: (pid) => waiting(fixture, pid),
    });
  } finally {
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
interface FaultEvidence {
  intercepted?: true;
  upstream?: unknown;
  injected?: "audit" | "outbox";
  authorization?: unknown;
}
async function hitBoundary(
  fixture: AtomicityFixture,
  scope: EventRuntimeTransaction,
  boundary: Boundary,
  evidence: FaultEvidence,
) {
  const rows = await scope.client.query(
    "SELECT (SELECT count(*)::int FROM events) AS events,(SELECT count(*)::int FROM decision_runs) AS runs",
  );
  evidence.upstream = rows.rows;
  if (boundary === "denial") {
    await setRecipientStatus(fixture, "INACTIVE");
    return;
  }
  evidence.injected = boundary;
  throw new Error(`Injected actual ${boundary} SQL boundary failure`);
}
async function setRecipientStatus(fixture: AtomicityFixture, status: "ACTIVE" | "INACTIVE") {
  await fixture.source.query('UPDATE "WorkspaceMember" SET status=$1 WHERE "userId"=$2', [
    status,
    "event-runtime-recipient",
  ]);
}
async function faultIn<T>(
  fixture: AtomicityFixture,
  scope: EventRuntimeTransaction,
  boundary: Boundary,
  evidence: FaultEvidence,
  operation: (scope: EventRuntimeTransaction) => Promise<T>,
) {
  const query = scope.client.query.bind(scope.client);
  const spy = vi.spyOn(scope.client, "query").mockImplementation(async (sql, values) => {
    if (evidence.intercepted || !matches(sql, boundary)) return query(sql, values);

    evidence.intercepted = true;
    await hitBoundary(fixture, scope, boundary, evidence);
    const result = await query(sql, values);
    evidence.authorization = result.rows;
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
  const original = fixture.uow.transaction.bind(fixture.uow);
  const evidence: FaultEvidence = {};
  const hook: EventDecisionUnitOfWork["transaction"] = (input, operation) =>
    original(input, (scope) => faultIn(fixture, scope, boundary, evidence, operation));
  const spy = vi.spyOn(fixture.uow, "transaction").mockImplementation(hook);
  try {
    const [result] = await Promise.allSettled([work()]);
    return { result, evidence };
  } finally {
    spy.mockRestore();
    if (boundary === "denial") await setRecipientStatus(fixture, "ACTIVE");
  }
}

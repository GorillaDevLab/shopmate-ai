import assert from "node:assert/strict";
import process from "node:process";
import pg from "pg";

let observed = 0;
let notify;
let held, unblock, started;
const Client = pg.Client;
class ObservedClient extends Client {
  query(...args) {
    const result = super.query(...args);
    if (held && args[0] === "SET LOCAL TIME ZONE 'UTC'") {
      return result.then(async (value) => {
        started();
        await held;
        return value;
      });
    }
    return result;
  }
  emit(event, ...args) {
    const result = super.emit(event, ...args);
    if (event === "error" && held) {
      observed += 1;
      notify?.();
    }
    return result;
  }
}
const Pool = pg.Pool;
// Observe actual delivery without adding a listener that would hide an unhandled error.
pg.Pool = class extends Pool {
  constructor(options) {
    super({ ...options, Client: ObservedClient });
  }
  emit(event, ...args) {
    const result = super.emit(event, ...args);
    if (event === "error") {
      observed += 1;
      notify?.();
    }
    return result;
  }
};
const source = await import("../../dist/src/mock-platform/index.js");
let port, call, initial, active;

async function open({ env, mode, actor, scope }) {
  port =
    mode === "reader" ? source.createMockSourceReader(env) : source.createMockSourceWorker(env);
  call = mode === "reader" ? () => port.findGeneration(actor, scope) : () => port.listGrants();
  initial = await call();
  assert.ok(initial);
  return { ready: true };
}
async function failure(action = call) {
  try {
    await action();
  } catch (error) {
    return { code: error.code, message: error.message, name: error.name, keys: Object.keys(error) };
  }
  return { unexpectedSuccess: true };
}
async function startActive() {
  held = new Promise((resolve) => {
    unblock = resolve;
  });
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  active = failure();
  await ready;
  return { held: true };
}
async function execute(message) {
  if (message.action === "open") return open(message);
  if (message.action === "active-start") return startActive();
  if (message.action === "active-finish") {
    unblock();
    const result = await active;
    held = undefined;
    return result;
  }
  if (message.action === "observe") {
    if (observed < message.count)
      await new Promise((resolve) => {
        notify = resolve;
      });
    assert.equal(observed, message.count);
    return { observed: true };
  }
  if (message.action === "failure") return failure();
  if (message.action === "recover") {
    assert.deepEqual(await call(), initial);
    return { recovered: true };
  }
  if (message.action === "close") {
    await port.close();
    return { closed: true };
  }
  throw new Error("Unknown child action");
}
process.on("message", async (message) => {
  try {
    process.send(await execute(message));
  } catch {
    process.send({ failed: true });
  }
});

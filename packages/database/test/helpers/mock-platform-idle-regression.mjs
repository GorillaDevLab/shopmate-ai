import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";

function request(child, message) {
  return new Promise((resolve, reject) => {
    const failed = () => {
      clean();
      reject(new Error("Source child exited before completing idle recovery"));
    };
    const received = (value) => {
      clean();
      resolve(value);
    };
    const timer = setTimeout(failed, 10000);
    function clean() {
      clearTimeout(timer);
      child.off("exit", failed);
      child.off("message", received);
    }
    child.once("exit", failed);
    child.once("message", received);
    if (child.exitCode !== null || child.signalCode !== null) failed();
    else child.send(message);
  });
}

function isolatedChild() {
  const child = fork(new URL("./mock-platform-idle-child.mjs", import.meta.url), {
    env: {},
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  const exited = once(child, "exit");
  let output = 0;
  child.stdout.on("data", (data) => {
    output += data.length;
  });
  child.stderr.on("data", (data) => {
    output += data.length;
  });
  return { child, exited, output: () => output };
}
async function backendFor(admin, application, mode, state = "idle") {
  const backend = await admin.query(
    "SELECT pid,usename,state FROM pg_stat_activity WHERE application_name=$1",
    [application],
  );
  assert.equal(backend.rowCount, 1);
  assert.equal(
    backend.rows[0].usename,
    mode === "reader" ? "source_read_login" : "source_worker_login",
  );
  assert.equal(backend.rows[0].state, state);
  return backend.rows[0].pid;
}
async function terminate(admin, child, pid, count) {
  const result = await admin.query("SELECT pg_terminate_backend($1) AS terminated", [pid]);
  assert.equal(result.rows[0].terminated, true);
  assert.deepEqual(await request(child, { action: "observe", count }), { observed: true });
}
async function recover(admin, child, application, mode) {
  const pid = await backendFor(admin, application, mode);
  await terminate(admin, child, pid, 1);
  assert.deepEqual(await request(child, { action: "failure" }), {
    code: "SOURCE_STORAGE",
    message: "SOURCE_STORAGE",
    name: "SourceStorageError",
    keys: ["code", "name"],
  });
  assert.equal(
    (await admin.query("SELECT pid FROM pg_stat_activity WHERE application_name=$1", [application]))
      .rowCount,
    0,
  );
  assert.deepEqual(await request(child, { action: "recover" }), { recovered: true });
  const fresh = await backendFor(admin, application, mode);
  assert.notEqual(fresh, pid);
  // A second idle failure is closed without consuming its pending operation report.
  await terminate(admin, child, fresh, 2);
  assert.deepEqual(await request(child, { action: "close" }), { closed: true });
}
async function activeRecovery(admin, child, application, mode) {
  assert.deepEqual(await request(child, { action: "active-start" }), { held: true });
  const pid = await backendFor(admin, application, mode, "idle in transaction");
  await terminate(admin, child, pid, 1);
  assert.deepEqual(await request(child, { action: "active-finish" }), {
    code: "SOURCE_STORAGE",
    message: "SOURCE_STORAGE",
    name: "SourceStorageError",
    keys: ["code", "name"],
  });
  assert.deepEqual(await request(child, { action: "recover" }), { recovered: true });
  assert.notEqual(await backendFor(admin, application, mode), pid);
  assert.deepEqual(await request(child, { action: "close" }), { closed: true });
}
export async function idlePoolRecovery(admin, env, mode, actor, scope, active = false) {
  const { child, exited, output } = isolatedChild();
  const key =
    mode === "reader" ? "MOCK_PLATFORM_READ_DATABASE_URL" : "MOCK_PLATFORM_WORKER_DATABASE_URL";
  const url = new URL(env[key]);
  const application = `source_idle_${mode}`;
  url.searchParams.set("application_name", application);
  try {
    assert.deepEqual(
      await request(child, { action: "open", env: { [key]: url.toString() }, mode, actor, scope }),
      { ready: true },
    );
    await (active ? activeRecovery : recover)(admin, child, application, mode);
    child.disconnect();
    assert.deepEqual(await exited, [0, null]);
    assert.equal(output(), 0, "no raw storage payload or other child output escapes");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }
}
